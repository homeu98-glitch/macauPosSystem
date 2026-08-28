import { NextResponse } from "next/server";

import { isValidMacauPhone, normalizePhone } from "@/lib/ledger/phone";

/**
 * 未註冊會員建檔／首充 — Ledger 契約 v3.2 §5.9。
 *
 * ⚠️ 呢度係 **POS 嘅薄轉發**，**唔係** Ledger 本體：
 *    - Ledger HTTP 本體（已上線）：`https://membership-uat.macau-tech.com/api/integration/pos/ensure-customer`
 *    - POS 只做：憑證檢查 → 參數校驗 → 限流 → 帶店員 Bearer token 轉發。
 *    - 建檔／首充嘅業務邏輯**全部喺 Ledger**，POS 唔重複實作。
 *
 * browser **唔可以**直接打 Ledger（契約 §5.9），所以要經呢條 POS 伺服器路由代打。
 *
 * 分流（由前端保證）：
 *    lookup → registered=true  → 唔好打呢條，直連 `merchant_apply_pos_txn(p_type:"topup")`
 *           → registered=false → 打呢條（可附 amountAvos 當首充）
 */

type AttemptBucket = { count: number; resetAt: number };

const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 30;
const attempts = new Map<string, AttemptBucket>();

/** Ledger 本體 base URL。預設 UAT；正式環境用 `LEDGER_INTEGRATION_BASE_URL` 覆寫。 */
const DEFAULT_LEDGER_BASE = "https://membership-uat.macau-tech.com";

function ledgerBaseUrl(): string {
  const raw = process.env.LEDGER_INTEGRATION_BASE_URL?.trim();
  return (raw || DEFAULT_LEDGER_BASE).replace(/\/+$/, "");
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return request.headers.get("x-real-ip") ?? "unknown";
}

/** 限流：每店 / 每操作者（IP）15 分鐘 30 次。 */
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

function extractMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  for (const candidate of [row.error, row.message, row.detail]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return null;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await request.json()) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    return NextResponse.json({ ok: false, error: "缺少店員 Ledger 憑證，請重新登入。" }, { status: 401 });
  }

  const payload = await readJson(request);
  if (!payload) {
    return NextResponse.json({ ok: false, error: "請求內容格式錯誤。" }, { status: 400 });
  }

  const merchantId = String(payload.merchantId ?? "").trim();
  const phone = normalizePhone(String(payload.phone ?? ""));
  const displayName = payload.displayName ? String(payload.displayName).trim() : "";
  const idempotencyKey = payload.idempotencyKey ? String(payload.idempotencyKey).trim() : "";

  const amountRaw = payload.amountAvos;
  const amountAvos = amountRaw === undefined || amountRaw === null || amountRaw === "" ? null : Number(amountRaw);

  if (!merchantId) {
    return NextResponse.json({ ok: false, error: "缺少 merchantId。" }, { status: 400 });
  }
  if (!isValidMacauPhone(phone)) {
    return NextResponse.json({ ok: false, error: "請輸入 8 位數字會員電話。" }, { status: 400 });
  }
  if (amountAvos !== null) {
    if (!Number.isFinite(amountAvos) || !Number.isInteger(amountAvos) || amountAvos <= 0) {
      return NextResponse.json(
        { ok: false, error: "充值金額（avos）須為大於 0 的整數。" },
        { status: 400 },
      );
    }
    if (!idempotencyKey) {
      return NextResponse.json(
        { ok: false, error: "有充值金額時必須提供 idempotencyKey（防止重複首充）。" },
        { status: 400 },
      );
    }
  }

  if (!checkRateLimit(`${merchantId}:${clientIp(request)}`)) {
    return NextResponse.json(
      { ok: false, error: "建立會員過於頻繁，請稍後再試。" },
      { status: 429 },
    );
  }

  const body: Record<string, unknown> = { merchantId, phone };
  if (displayName) body.displayName = displayName;
  if (amountAvos !== null) body.amountAvos = amountAvos;
  if (idempotencyKey) body.idempotencyKey = idempotencyKey;

  const upstreamUrl = `${ledgerBaseUrl()}/api/integration/pos/ensure-customer`;

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });

    const text = await upstream.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!upstream.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: extractMessage(parsed) ?? `Ledger ensure-customer 失敗（HTTP ${upstream.status}）`,
          status: upstream.status,
          detail: parsed,
        },
        { status: upstream.status },
      );
    }

    const data = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    return NextResponse.json({ ok: true, ...data }, { status: upstream.status });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "無法連線到 Ledger，請稍後再試。",
        status: 502,
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}
