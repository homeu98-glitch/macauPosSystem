import { NextResponse } from "next/server";

import { getExpenseSupabaseClient } from "@/lib/expense-supabase";
import { resolveExpenseUserId, sanitizePhotoPaths } from "@/lib/expense-inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 收據相片嘅 **signed URL**（讀取用）。
 *
 * 🔴 為何需要呢支端點？
 *   `receipt-photos` bucket 係 **private**（J 拍板：收據相片含供應商、金額，唔應該公開）。
 *   Private bucket 嘅檔案**唔可以**直接用 `<img src="https://xxx.supabase.co/...">` ——
 *   會回 400/403。要由持有 service_role 嘅後端簽一條有時效嘅 URL。
 *
 * 🔴 為何唔喺 GET `/api/inventory/receipts` 就順手簽好？
 *   ① **數量**：一張清單可能幾十張收據 × 每張幾張相 ⇒ 幾百次簽名呼叫，
 *      而商家根本冇打開每張。signed URL 有 TTL（1 小時），過期又要重簽。
 *   ② **職責**：清單 API 應該快（只讀 DB）；簽名係「睇相」一刻嘅事。
 *   所以設計成**按需**：前端打開相片檢視器時才呼叫。
 *
 * 用法：GET /api/inventory/receipt-photos/url?account=...&paths=a.jpg,b.jpg
 *   → { ok, urls: { "a.jpg": "https://...signed...", ... } }
 *
 * ⚠️ 逐個 path 簽名（Supabase 有 `createSignedUrls` 批量版，但**單一 path 失敗
 *    會令整批失敗**）。相片係非關鍵資源：一張簽唔到唔應該令其他都睇唔到 ⇒
 *    逐個簽、失敗嘅靜默略過（前端顯示「相片無法載入」佔位）。
 */
const BUCKET = "receipt-photos";

/** 1 小時。夠商家睇相，又唔會長到能用黎當公開連結分享。 */
const EXPIRES_IN = 3600;

export async function GET(request: Request) {
  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  const { searchParams } = new URL(request.url);
  const resolved = await resolveExpenseUserId(client, searchParams.get("account"));
  if ("error" in resolved) return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  const userId = resolved.userId;

  const requested = sanitizePhotoPaths(searchParams.getAll("paths").flatMap((p) => p.split(",")));
  // 🔴 只簽本店前綴底下嘅路徑。service_role 唔受 RLS 管，冇呢層就變成
  //    「任何登入帳號都可以攞到其他店嘅收據相片」= 資料外洩。
  const owned = requested.filter((p) => p.startsWith(`${userId}/`));

  const urls: Record<string, string> = {};
  await Promise.all(
    owned.map(async (path) => {
      const { data, error } = await client.storage.from(BUCKET).createSignedUrl(path, EXPIRES_IN);
      if (error || !data?.signedUrl) {
        console.warn("[receipt-photos/url] 簽名失敗", { path, message: error?.message });
        return;
      }
      urls[path] = data.signedUrl;
    }),
  );

  return NextResponse.json({ ok: true, urls, expiresIn: EXPIRES_IN });
}
