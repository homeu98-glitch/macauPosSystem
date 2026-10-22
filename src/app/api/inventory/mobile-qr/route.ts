import { NextResponse } from "next/server";

import {
  EXPENSE_RECORDER_WEB_URL_DEFAULT,
  MOBILE_QR_DEFAULT_TTL_SECONDS,
  clampTtlSeconds,
  createExpenseMobileQrStore,
  issueMobileQrSession,
} from "@/lib/expense-mobile-qr";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";
import { readPosDeviceTokenFromRequest } from "@/lib/pos/pos-device-token";
import { posRouteAuthGuard } from "@/lib/pos/pos-route-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 手機版庫存表 QR —— 簽發一次性 SSO 短碼（POST）。
 *
 * ## 用途
 * 庫存頁「手機版庫存表」彈窗打開時打呢條 endpoint，換一條
 * `https://expense-recorder-sigma.vercel.app/api/auth/sso-qr?code=<10位>` URL
 * 去渲染 QR。手機掃完 → expenseRecorder 換返真‧JWT → 現有 SSO 流程自動登入。
 *
 * ## 鑑權（🔴 呢條 endpoint 簽登入 token，絕對唔可以匿名）
 * 用 `posRouteAuthGuard(request, storeId)`：POS 終端憑證（綁店）或 admin session
 * token，任何一條過先放行；`POS_REQUIRE_DEVICE_AUTH=0` 時全域開閘（緊急回滾慣例）。
 * client 一律經 `posDeviceAuthHeadersFresh()` 帶 `Authorization: Bearer <token>`。
 *
 * ## account 來源
 * 優先取 **device token claims** 嘅 `account`（server 端簽發、唔信 client body）；
 * admin session 路行冇 claims → 退化用 body.account（都要過 8 位數字校驗）。
 *
 * 詳見 `docs/integration/mobile-inventory-qr-2026-10-22.md`。
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    storeId?: string;
    account?: string;
    storeName?: string;
  };
  const storeId = String(body.storeId ?? "").trim();

  const denied = posRouteAuthGuard(request, storeId || null, "inventory/mobile-qr");
  if (denied) return denied;

  const claims = readPosDeviceTokenFromRequest(request);
  const account = (claims?.account || String(body.account ?? "")).trim();
  if (!/^\d{8}$/.test(account)) {
    return NextResponse.json(
      { ok: false, error: "缺少有效的 8 位帳號，請重新登入 POS 帳號。", code: "INVALID_ACCOUNT" },
      { status: 400 },
    );
  }

  const expense = getExpenseSupabaseClient();
  if (!expense) {
    return NextResponse.json(
      { ok: false, error: "expenseRecorder 連線未設定，請聯絡管理員。", code: "EXPENSE_CLIENT_MISSING" },
      { status: 503 },
    );
  }

  // ── 開通前檢查（2026-10-22）─────────────────────────────────────────────
  // expenseRecorder 一定要有 `login_id = account` 或 `external_shop_id = storeId`
  // 嘅 shop_users 列先好簽發。呢張列由 `/api/ledger/login` 嘅 auto-provision
  // 負責建立（見 expense-account-provision.ts）；**POS session 唔持久化 PIN**，
  // 所以呢度補唔到開通，只可以擋。
  //
  // 點解要擋：缺少嗰張列時，expenseRecorder SSO 會行 INSERT 路徑隨機生成 PIN
  // （`login_pin: randomPin()`）⇒ 「帳號＋PIN 兩邊互用」靜默失效，而且手機版
  // 會望著一間全新嘅空 row。舊 session（部署前已登入、未重新登入過）就係呢種
  // 情況 —— 正確解法係登出再登入一次觸發 auto-provision。
  //
  // best-effort：查詢本身出錯（網絡／缺欄）照放行，只有「明確搵唔到」先至擋。
  const { data: existingRows, error: existErr } = await expense
    .from("shop_users")
    .select("id")
    .or(`login_id.eq.${account},external_shop_id.eq.${storeId}`)
    .limit(1);
  if (!existErr && (!existingRows || existingRows.length === 0)) {
    return NextResponse.json(
      {
        ok: false,
        error: "庫存帳戶尚未開通，請登出並重新登入 POS 一次後再試。",
        code: "EXPENSE_ACCOUNT_MISSING",
      },
      { status: 409 },
    );
  }

  const result = await issueMobileQrSession(createExpenseMobileQrStore(expense), {
    storeId,
    account,
    storeName: String(body.storeName ?? ""),
    secret: process.env.MACAU_LEDGER_SSO_SECRET ?? "",
    issuer: process.env.MACAU_LEDGER_SSO_ISSUER,
    audience: process.env.MACAU_LEDGER_SSO_AUDIENCE,
    ttlSeconds: readTtlSecondsFromEnv(),
  });

  if (!result.ok) {
    const message =
      result.code === "SSO_SECRET_MISSING"
        ? "手機版庫存表尚未啟用（伺服器未設定 MACAU_LEDGER_SSO_SECRET），請聯絡管理員。"
        : result.code === "QR_TABLE_MISSING"
          ? "手機版庫存表尚未啟用（資料表未建立），請聯絡管理員。"
          : result.error;
    return NextResponse.json({ ok: false, error: message, code: result.code }, { status: result.status });
  }

  const base = (process.env.EXPENSE_RECORDER_WEB_URL ?? EXPENSE_RECORDER_WEB_URL_DEFAULT).replace(/\/+$/, "");
  return NextResponse.json({
    ok: true,
    url: `${base}/api/auth/sso-qr?code=${result.code}`,
    expiresAt: result.expiresAtIso,
    ttlSeconds: result.ttlSeconds,
  });
}

/** `POS_MOBILE_QR_TTL_SECONDS`（可選）：非法值 → clamp 到預設 300。 */
function readTtlSecondsFromEnv(): number {
  const raw = Number(process.env.POS_MOBILE_QR_TTL_SECONDS ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return MOBILE_QR_DEFAULT_TTL_SECONDS;
  return clampTtlSeconds(raw);
}
