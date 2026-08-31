import { NextResponse } from "next/server";

import { authenticateAccountFromServer } from "@/lib/admin-account-server";
import { issueAdminSessionToken } from "@/lib/admin-session-token";

/**
 * POST /api/admin/session — 用「管理員帳號 + PIN」換一張 12 小時短效 token。
 *
 * 【2026-08-31 資安修復，見 docs/89 §2】
 * 之前 `/api/admin/accounts` 完全冇授權。呢條 route 提供一個真正嘅身分驗證關口：
 * 拎唔到 token 就做唔到任何帳戶管理操作。
 *
 * 安全設計：
 *   - 用既有嘅 `authenticateAccountFromServer()` 做 PIN 驗證（對 DB，唔係前端嗰份 localStorage）。
 *   - 除咗要 login 成功，仲要 `permissions.manageAccounts === true` 先放行
 *     （店長 role 預設冇呢個權限）。
 *   - **生產環境冇配 DB → 一律拒絕**。因為 `authenticateAccountFromServer()` 喺冇 DB 時
 *     會 fallback 去 `mock-data.ts` 嘅示範帳號（60000000 / 0000），呢組係公開值，
 *     喺生產環境等於開咗道後門。dev/local 先容許 fallback。
 *   - 回傳只畀 token + 到期時間，唔回傳 PIN。
 */

const ACCOUNT_PATTERN = /^\d{8}$/;
const PIN_PATTERN = /^\d{4}$/;

export async function POST(request: Request) {
  let payload: { account?: string; pin?: string };
  try {
    payload = (await request.json()) as { account?: string; pin?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "請求格式錯誤。" }, { status: 400 });
  }

  const account = String(payload?.account ?? "").trim();
  const pin = String(payload?.pin ?? "").trim();

  // 格式唔啱直接 400，唔好浪費一次 DB 查詢，亦縮細暴力破解嘅輸入面
  if (!ACCOUNT_PATTERN.test(account) || !PIN_PATTERN.test(pin)) {
    return NextResponse.json({ ok: false, error: "請輸入 8 位帳號與 4 位 PIN。" }, { status: 400 });
  }

  const result = await authenticateAccountFromServer(account, pin);

  // 生產環境 + mock 來源 = 用咗公開嘅示範帳號 → fail closed
  if (result.ok && result.source === "mock" && process.env.NODE_ENV === "production") {
    console.error("[admin/session] 拒絕：生產環境未配 DB，只會用示範帳號驗證。");
    return NextResponse.json(
      { ok: false, error: "系統未正確配置資料庫，管理員驗證停用。" },
      { status: 503 },
    );
  }

  // 帳號 / PIN 錯、帳戶停用 → 一律同一句，唔好洩漏「邊樣錯」
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: "帳號或 PIN 不正確。" }, { status: 401 });
  }

  // 登入成功 ≠ 有權管帳戶：要明確有 manageAccounts
  if (!result.session.permissions?.manageAccounts) {
    return NextResponse.json({ ok: false, error: "此帳號沒有管理帳戶的權限。" }, { status: 403 });
  }

  const token = issueAdminSessionToken({ account: result.session.account, role: result.session.role });
  if (!token) {
    // 冇任何 server secret → 簽唔到 token → fail closed，寧願用唔到都唔好開放
    console.error("[admin/session] 拒絕：未設定 ADMIN_SESSION_SECRET 或 SUPABASE_SERVICE_ROLE_KEY。");
    return NextResponse.json(
      { ok: false, error: "系統未設定管理員憑證密鑰，管理功能停用。" },
      { status: 503 },
    );
  }

  return NextResponse.json({
    ok: true,
    token,
    account: result.session.account,
    name: result.session.name,
    role: result.session.role,
  });
}
