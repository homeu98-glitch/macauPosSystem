import "server-only";

import { NextResponse } from "next/server";

import { resolveAdminScope } from "@/lib/admin-scope.server";
import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
import { prepareLedgerServerClient } from "@/lib/ledger/supabase-server-auth";

/**
 * 「店主」守衛 —— 店員權限控制嘅唯一入口。
 *
 * ## 為何要兩條通道
 *
 * 同一個「權限控制」頁會出現喺**兩個地方**（2026-10-23 J 要求）：
 *
 * | 入口 | 憑證 | 身份 |
 * |---|---|---|
 * | POS 設定頁 `/settings` › 權限控制 | Ledger access token（`x-pos-ledger-token`） | Ledger `staff_role = owner` |
 * | 後台 `/admin/staff` | `adminSessionToken`（`Authorization: Bearer`） | `admin_account_users`（平台／店主帳號） |
 *
 * 兩者係**兩套身份系統**（POS 終端 vs 後台帳號），刻意唔合併：
 * 合併要嘛逼所有收銀開後台帳號，要嘛逼後台帳號綁 Ledger —— 兩邊都唔合理。
 *
 * ## 安全要求
 *
 * ① Ledger 通道**一定**要 `staff_role = owner`：`staff` 唔可以改權限
 *    （否則任何收銀都可以自己放開退款權）。
 * ② Ledger 通道**一定**要 `merchant_id === storeId`：唔可以跨店改。
 * ③ Admin 通道用 `resolveAdminScope()` 解析（同其他 admin route 同一真源），
 *    `scope.all` 或者 storeId 喺 scope 內才放行。
 * ④ 失敗訊息唔洩露帳號狀態（同 admin-guard 一致）。
 */

const LEDGER_TOKEN_HEADER = "x-pos-ledger-token";
const LEDGER_REFRESH_HEADER = "x-pos-ledger-refresh";

export type StoreOwnerGuardOk = {
  ok: true;
  via: "admin" | "ledger";
  /** 審計用：admin 帳號 / Ledger email */
  account: string;
};
export type StoreOwnerGuardFail = { ok: false; res: NextResponse };

function deny(error: string, status: number, code?: string): StoreOwnerGuardFail {
  return {
    ok: false,
    res: NextResponse.json(
      code ? { ok: false, error, code } : { ok: false, error },
      { status },
    ),
  };
}

export async function requireStoreOwner(
  request: Request,
  storeId: string,
): Promise<StoreOwnerGuardOk | StoreOwnerGuardFail> {
  const store = String(storeId ?? "").trim();
  if (!store) return deny("缺少 storeId。", 400, "store_required");

  // ① 後台帳號（/admin）
  const claims = readAdminSessionFromRequest(request);
  if (claims) {
    const resolved = await resolveAdminScope(claims.account);
    if (!resolved.ok) {
      if (resolved.reason === "unavailable") {
        return deny("系統未正確配置資料庫，暫時無法管理店員。", 503, "supabase_not_configured");
      }
      return deny("登入狀態已失效，請重新登入。", 401, "session_invalid");
    }
    if (resolved.scope.all || resolved.scope.storeIds.includes(store)) {
      return { ok: true, via: "admin", account: claims.account };
    }
    return deny("未經授權：此店舖不在你的可見範圍內。", 403, "scope.denied");
  }

  // ② Ledger 店主（POS 設定頁）
  const accessToken = (request.headers.get(LEDGER_TOKEN_HEADER) ?? "").trim();
  if (accessToken) {
    const refreshToken = (request.headers.get(LEDGER_REFRESH_HEADER) ?? "").trim() || null;
    const client = await prepareLedgerServerClient(accessToken, refreshToken);
    if (!client) {
      return deny("Ledger 環境變數未設定，暫時無法管理店員。", 503, "ledger_not_configured");
    }

    const { data: userData, error: userError } = await client.auth.getUser(accessToken);
    let userId = userData?.user?.id ?? "";
    let userEmail = userData?.user?.email ?? "";

    // access token 過期但 refresh token 仍有效 → 用 session 重試一次
    // （`prepareLedgerServerClient()` 已經 `setSession()`，會自動刷新）
    if ((userError || !userId) && refreshToken) {
      const retry = await client.auth.getUser();
      if (!retry.error && retry.data.user?.id) {
        userId = retry.data.user.id;
        userEmail = retry.data.user.email ?? "";
      }
    }

    if (!userId) {
      return deny("Ledger 登入已過期，請重新登入 POS。", 401, "ledger_session_invalid");
    }

    const { data: staffRows, error: staffError } = await client
      .from("merchant_staff")
      .select("merchant_id, staff_role")
      .eq("user_id", userId)
      .limit(1);

    if (staffError) {
      return deny("無法讀取商戶員工資料，請稍後再試。", 503, "ledger_staff_read_failed");
    }

    const row = staffRows?.[0] as { merchant_id?: string; staff_role?: string } | undefined;
    if (!row?.merchant_id || String(row.merchant_id) !== store) {
      return deny("此帳號唔屬於呢間店，無法管理店員。", 403, "store_mismatch");
    }
    if (String(row.staff_role ?? "").toLowerCase() !== "owner") {
      return deny("只有店主可以設定員工權限。", 403, "owner_only");
    }

    return { ok: true, via: "ledger", account: userEmail };
  }

  return deny("未授權，請先登入。", 401, "unauthorized");
}
