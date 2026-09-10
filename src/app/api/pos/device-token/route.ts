import { NextResponse } from "next/server";

import { createLedgerServerClient, prepareLedgerServerClient } from "@/lib/ledger/supabase-server-auth";
import { issuePosDeviceToken } from "@/lib/pos/pos-device-token";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";

/**
 * POST /api/pos/device-token — 用 **Ledger 會話** 換一張 POS 終端憑證。
 *
 * 【點解需要呢支 API（2026-09-10 P0-3 配套）】
 *   POS 終端憑證 TTL 係 12 小時，而收銀機係全日開住。冇續期機制嘅話：
 *     1. 每日返工幾個鐘之後，全店 POS 會突然 401（讀唔到訂單 / 落唔到單）；
 *     2. 部署當日已經登入咗嘅舊終端（session 入面冇 token）會即刻壞。
 *   所以要有「唔使重新輸 PIN 都可以續期」嘅路徑。
 *
 * 【點解用 Ledger access token 做憑證】
 *   登入流程（`/api/ledger/login`）本身就用 Ledger Supabase Auth 驗身，成功之後
 *   `authSession` 已經存住 `ledgerAccessToken` / `ledgerRefreshToken`。用佢哋去讀
 *   `merchant_staff` 就係「權威地確認商戶身份」，而且 RLS 由 Ledger 自己把關
 *   （`is_merchant_staff()`），我哋唔使自己維護一套。
 *
 * 安全：fail closed —— 讀唔到 merchant_staff 就唔簽。
 */

export async function POST(request: Request) {
  if (!rateLimit(`pos-device-token:${clientIp(request)}`, 60, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const payload = (await request.json().catch(() => null)) as {
    accessToken?: string;
    refreshToken?: string;
  } | null;
  const accessToken = typeof payload?.accessToken === "string" ? payload.accessToken.trim() : "";
  const refreshToken = typeof payload?.refreshToken === "string" ? payload.refreshToken.trim() : "";
  if (!accessToken) {
    return NextResponse.json({ ok: false, error: "缺少 accessToken。" }, { status: 400 });
  }

  const client = refreshToken
    ? await prepareLedgerServerClient(accessToken, refreshToken)
    : createLedgerServerClient(accessToken);
  if (!client) {
    return NextResponse.json({ ok: false, error: "Ledger 未配置，無法簽發終端憑證。" }, { status: 503 });
  }

  // 由 JWT 拎 user id（token 無效 / 過期 → getUser 會失敗）
  const { data: userData, error: userError } = await client.auth.getUser();
  const userId = userData?.user?.id;
  if (userError || !userId) {
    return NextResponse.json({ ok: false, error: "Ledger 會話已失效，請重新登入。" }, { status: 401 });
  }

  const { data: staffRows, error: staffError } = await client
    .from("merchant_staff")
    .select("merchant_id, staff_role")
    .eq("user_id", userId)
    .limit(1);

  if (staffError) {
    console.error("[pos/device-token] 讀取 merchant_staff 失敗:", staffError.message);
    return NextResponse.json({ ok: false, error: "無法驗證商戶身份。" }, { status: 503 });
  }

  const merchantId = staffRows?.[0]?.merchant_id as string | undefined;
  if (!merchantId) {
    return NextResponse.json({ ok: false, error: "非本店 Ledger 帳號。" }, { status: 403 });
  }

  const role = String(staffRows?.[0]?.staff_role ?? "").toLowerCase() === "owner" ? "admin" : "cashier";
  const token = issuePosDeviceToken({ storeId: merchantId, account: "ledger-session", role });
  if (!token) {
    console.error("[pos/device-token] 未能簽發（未設定任何 server secret）。");
    return NextResponse.json({ ok: false, error: "系統未設定終端憑證密鑰。" }, { status: 503 });
  }

  return NextResponse.json({ ok: true, token, storeId: merchantId });
}
