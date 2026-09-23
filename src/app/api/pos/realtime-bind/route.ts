import { NextResponse } from "next/server";

import { readPosDeviceTokenFromRequest } from "@/lib/pos/pos-device-token";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

/**
 * `POST /api/pos/realtime-bind` —— 把一個 Supabase Auth 匿名 session 綁去某一間店
 * （per-store token 第 2 階段，2026-09-23）。
 *
 * ## 為何需要
 * Supabase 專案已用**非對稱簽名金鑰（ECC P-256）**，官方明文私鑰取唔出
 * ⇒ 唔可以自簽 JWT。所以 Realtime 嘅 per-store 隔離只能靠
 * **Supabase Auth 簽發嘅 JWT** + **`app_metadata.store_id`**：
 *
 * ```
 * client  signInAnonymously()  → 一個 role:"authenticated" 嘅 JWT
 * client  POST /realtime-bind  → 呢個 route
 * server  驗終端憑證 + 驗 token → 用 Admin API 寫 app_metadata.store_id
 * client  refreshSession()     → 攞返帶 store_id 嘅新 JWT → setAuth
 * ```
 *
 * ## 🔴 為何一定要用 `app_metadata`（唔可以用 `user_metadata`）
 * `user_metadata` 係**用戶自己改得到**嘅（`updateUser()` 就寫得入）。
 * 如果 store 綁定放喺嗰邊，任何匿名用戶都可以自稱係別間店
 * ⇒ RLS 嘅 `store_id = auth.jwt() -> 'app_metadata' ->> 'store_id'` 就形同虛設。
 * `app_metadata` 只可以由 **service_role** 寫 ⇒ 綁定係伺服器權威。
 *
 * ## 🔴 為何只接受匿名用戶
 * 如果任由任何 Supabase Auth 帳號綁店，就等於「擁有一個 auth 帳號 ⇒ 可以自選一間店
 * 去讀佢全部訂單」。本專案嘅 POS 終端身份係**自家 `pv1` 終端憑證**（`storeId` 已簽名），
 * 而 Supabase Auth 只用嚟「承載一個 RLS 認得嘅 role + store claim」。
 * ⇒ 只綁 `is_anonymous === true` 嘅用戶，其餘一律拒。
 *
 * ## 回傳
 * `{ ok: true, storeId, bound: true|false }` —— `bound:false` ＝ 本來已經綁咗同一間店
 * （idempotent，唔會重複打 Admin API）。
 *
 * ## 失敗行為（fail-safe）
 * 任何失敗都回非 2xx。客戶端（`realtime-auth.ts`）見到唔 OK 就**保持 anon**
 * ⇒ 功能同今日完全一樣，唔會更差。呢個 endpoint 冇能力令 POS 壞掉。
 */

export const dynamic = "force-dynamic";

/** 綁定需要 POS 終端憑證 —— 呢個係**唯一權威**知道「呢部機係邊間店」嘅來源。 */
export async function POST(request: Request) {
  // ── 1) 身份：POS 終端憑證（唔接受由 body 自報 storeId）────────────────────
  const claims = readPosDeviceTokenFromRequest(request);
  const storeId = claims?.storeId?.trim() ?? "";
  if (!storeId) {
    // ⚠️ 刻意**唔**跟 `POS_REQUIRE_DEVICE_AUTH` 開關：呢個係「授予跨裝置讀取權」嘅動作，
    //    一定要有簽名憑證。冇憑證 ⇒ 客戶端保持 anon（功能正常，只係未升級）。
    return NextResponse.json(
      { ok: false, error: "未授權：需要 POS 終端憑證方可綁定 Realtime 憑證。" },
      { status: 401 },
    );
  }

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "未配置 SUPABASE_SERVICE_ROLE_KEY，無法寫入 Realtime 憑證綁定。" },
      { status: 503 },
    );
  }

  // ── 2) 取出並驗證客戶端交嚟嘅 Supabase Auth access token ─────────────────
  let body: { accessToken?: unknown };
  try {
    body = (await request.json()) as { accessToken?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "請求格式錯誤（唔係合法 JSON）。" }, { status: 400 });
  }
  const accessToken = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
  if (!accessToken) {
    return NextResponse.json({ ok: false, error: "缺少 accessToken。" }, { status: 400 });
  }

  // 由 Supabase Auth 驗簽名同有效期（唔係自己解 JWT —— 自己解等於冇驗）
  const { data: userData, error: userErr } = await supabase.auth.getUser(accessToken);
  const user = userData?.user;
  if (userErr || !user) {
    return NextResponse.json(
      { ok: false, error: "accessToken 無效或已過期，請重新登入。" },
      { status: 401 },
    );
  }

  // ── 3) 只綁匿名用戶 ──────────────────────────────────────────────────────
  if (user.is_anonymous !== true) {
    return NextResponse.json(
      { ok: false, error: "只可以綁定匿名 Realtime 憑證（拒絕綁定一般帳號）。" },
      { status: 403 },
    );
  }

  // ── 4) 已經綁咗同一間店 → idempotent 直接回（唔重複打 Admin API）──────────
  const existingMeta =
    user.app_metadata && typeof user.app_metadata === "object"
      ? (user.app_metadata as Record<string, unknown>)
      : {};
  if (existingMeta.store_id === storeId) {
    return NextResponse.json({ ok: true, storeId, bound: false });
  }

  // ── 5) 寫入 app_metadata.store_id（merge，唔覆蓋其他既有欄位）────────────
  const { error: updErr } = await supabase.auth.admin.updateUserById(user.id, {
    app_metadata: { ...existingMeta, store_id: storeId },
  });
  if (updErr) {
    console.error("[pos/realtime-bind] updateUserById 失敗:", updErr.message);
    return NextResponse.json({ ok: false, error: "寫入 Realtime 憑證綁定失敗。" }, { status: 500 });
  }

  console.info(
    `[pos/realtime-bind] 已綁定 store=${storeId} user=${user.id.slice(0, 8)}…（匿名 Realtime 憑證）`,
  );
  return NextResponse.json({ ok: true, storeId, bound: true });
}
