import { NextResponse } from "next/server";

import { verifyLedgerSignature } from "@/lib/ledger/webhook-signature";
import { getSupabaseServerClient } from "@/lib/supabase-server";

/**
 * Ledger → POS：「線上訂單自動接單」入站 webhook（docs/92 §5）。
 *
 * 呢條係 **POS ↔ Ledger 雙向同步嘅入站嗰半邊**：
 * Ledger 嗰邊粒「自動接單」掣改動 → call 呢條 → 寫 `pos_online_order_settings`
 * （`updated_source='ledger'`）→ Supabase Realtime 廣播 → **全部收銀機即時跟住變**。
 *
 * 三個設計重點：
 * 1. **HMAC 簽名**（`webhook-signature.ts`）：呢條係公開嘅 POST 端點，冇店員 session，
 *    一定要有簽名 + 時間窗，否則任何人都可以幫間店開／閂自動接單。
 * 2. **防迴圈**：寫入時 `updated_source='ledger'`，**唔好**再推返去 Ledger
 *    （出站嗰條路喺 `/api/online-order-settings`，見 `auto-accept-sync.ts`）。
 * 3. **冇 polling**：收銀機靠 Realtime 收更新（`use-pos-realtime.ts`），
 *    webhook 淨係負責寫表，唔使廣播畀 client。
 */

const DEFAULT_STORE_ID = "macau-store-a";

// 限流：15 分鐘 30 次（同 /api/ledger/ensure-customer 一致）
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 30;
const attempts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const bucket = attempts.get(key);
  if (!bucket || now >= bucket.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (bucket.count >= MAX_ATTEMPTS) return false;
  bucket.count += 1;
  return true;
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return request.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(request: Request) {
  // ⚠️ 一定要讀 raw text：verifyLedgerSignature 要簽嘅係原始 bytes，
  //    JSON.parse 再 stringify 會改咗 bytes → 簽名一定對唔上。
  const rawBody = await request.text();

  const verification = verifyLedgerSignature(request.headers, rawBody);
  if (!verification.ok) {
    // 唔好洩漏太多：除咗 missing-secret（係我哋環境問題，要 log）之外一律 401
    if (verification.reason === "missing-secret") {
      console.error("[integration/ledger/auto-accept] LEDGER_WEBHOOK_SECRET 未設定");
      return NextResponse.json({ ok: false, error: "伺服器未設定 webhook secret。" }, { status: 500 });
    }
    return NextResponse.json({ ok: false, error: "簽名驗證失敗。" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return NextResponse.json({ ok: false, error: "JSON body 格式錯誤。" }, { status: 400 });
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON body 格式錯誤。" }, { status: 400 });
  }

  const storeId =
    typeof payload.storeId === "string" && payload.storeId.trim()
      ? payload.storeId.trim()
      : DEFAULT_STORE_ID;

  if (typeof payload.autoAccept !== "boolean") {
    return NextResponse.json({ ok: false, error: "autoAccept 必須係 boolean。" }, { status: 400 });
  }
  const autoAccept = payload.autoAccept;
  const updatedBy =
    typeof payload.updatedBy === "string" && payload.updatedBy.trim()
      ? payload.updatedBy.trim()
      : "ledger";

  if (!checkRateLimit(`${storeId}:${clientIp(request)}`)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "Supabase 伺服器端未配置，無法儲存自動接單設定。" },
      { status: 503 },
    );
  }

  const updatedAt = new Date().toISOString();
  const { error } = await supabase.from("pos_online_order_settings").upsert(
    {
      store_id: storeId,
      auto_accept: autoAccept,
      updated_at: updatedAt,
      // 防迴圈：標記來源係 Ledger，出站嗰條路見到 'ledger' 就唔會再推返去
      updated_source: "ledger",
      updated_by: updatedBy,
    },
    { onConflict: "store_id" },
  );

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, autoAccept, updatedAt, updatedSource: "ledger" });
}
