import { NextResponse } from "next/server";

import { authenticateAccountFromServer } from "@/lib/admin-account-server";
import { readClientIp, writeAdminAudit } from "@/lib/admin-audit.server";
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
 *
 * 【2026-10-21 多店控制台 P0-2／P0-4】
 *   - IP rate limit（10 次／分鐘）＋ **per-account 失敗鎖定**（5 次鎖 15 分鐘，落 DB）。
 *     後者係 D2「沿用 4 位 PIN」嘅補償措施：PIN 只有 10⁴ 組合、帳號可枚舉，
 *     單靠 IP 限流換 IP 即繞過。
 *   - 每次登入結果寫 `admin_audit_log`（成功／失敗／鎖定）。**失敗唔阻登入**。
 *   - 回傳多一個 `scope` 摘要（P0-5）。P1 會由 `resolveAdminScope()` 正式計算；
 *     現階段登入本身已要求 `manageAccounts`，即只有平台帳號入得到，故 `all` 為 true。
 */

const ACCOUNT_PATTERN = /^\d{8}$/;
const PIN_PATTERN = /^\d{4}$/;

/** IP 維度限流（防同一 IP 快速枚舉多個帳號）。per-account 鎖定由 DB 負責。 */
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
type RateBucket = { count: number; resetAt: number };
const ipAttempts = new Map<string, RateBucket>();

function checkIpRateLimit(ip: string, now = Date.now()): boolean {
  const bucket = ipAttempts.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    ipAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  if (bucket.count >= LOGIN_MAX_ATTEMPTS) return false;
  bucket.count += 1;
  return true;
}

export async function POST(request: Request) {
  const ip = readClientIp(request);

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

  if (!checkIpRateLimit(ip)) {
    await writeAdminAudit({ account, action: "login_locked", target: "session.ip_rate_limit", ip });
    return NextResponse.json(
      { ok: false, error: "登入嘗試過於頻繁，請稍後再試。", code: "rate_limited" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
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

  // 帳號 / PIN 錯、帳戶停用 → 一律同一類回覆，唔好洩漏「邊樣錯」
  if (!result.ok) {
    // 鎖定（per-account，DB 狀態）→ 429 + Retry-After。
    // ⚠️ 訊息刻意同「帳號或 PIN 不正確」分開講「嘗試過多」：呢個唔會洩露帳號是否存在
    //   （一個唔存在嘅帳號永遠唔會被鎖，因為根本冇 row 可以鎖），
    //   但對被鎖嘅真用戶嚟講，唔講清楚只會不斷重試／打去客服。
    if (result.code === "locked") {
      const retry = Math.max(1, result.retryAfterSec ?? 900);
      await writeAdminAudit({ account, action: "login_locked", target: "session.account_locked", ip });
      return NextResponse.json(
        { ok: false, error: result.error, code: "locked", retryAfterSec: retry },
        { status: 429, headers: { "Retry-After": String(retry) } },
      );
    }

    await writeAdminAudit({
      account,
      action: "login_failed",
      target: result.code === "inactive" ? "session.inactive" : "session.invalid_credentials",
      ip,
    });
    return NextResponse.json({ ok: false, error: result.error }, { status: 401 });
  }

  // 登入閘（2026-10-21 P1 調整）：
  //   · 平台級（`manageAccounts`）→ 可以登入，scope = 全部店。
  //   · 店舖級（`adminPanelAccess === true` ＋ 有店舖綁定）→ 可以登入，scope = 自己嘅店。
  //   · 其餘（包括舊有冇 manageAccounts 嘅店長／收銀帳號）→ **照舊拒絕**。
  //
  // 🔴 為何要一個**明確** flag 而唔係「有綁定就入得」：
  //    `admin_account_store_bindings` 早就存在，好多現有店長／收銀帳號都有綁定。
  //    如果「有綁定就入得 /admin」，等於突然開咗個新入口畀所有前線帳號（雖然只係自己店、
  //    只讀），屬**未經批准嘅權限擴張**。所以要有 `adminPanelAccess` 明確開啟；
  //    P2 建 owner 帳號時由平台勾選（或 SQL 設 `permissions.adminPanelAccess = true`）。
  const permissions = result.session.permissions;
  const storeIds = result.session.storeIds ?? [];
  const isPlatform = Boolean(permissions?.manageAccounts);
  const canEnterAdmin = isPlatform || permissions?.adminPanelAccess === true;

  if (!canEnterAdmin) {
    await writeAdminAudit({ account, action: "login_failed", target: "session.permission_denied", ip });
    return NextResponse.json({ ok: false, error: "此帳號沒有管理後台權限。" }, { status: 403 });
  }

  if (!isPlatform && storeIds.length === 0) {
    await writeAdminAudit({ account, action: "login_failed", target: "session.no_scope", ip });
    return NextResponse.json(
      { ok: false, error: "此帳號未獲分配任何店舖，請聯絡平台管理員。" },
      { status: 403 },
    );
  }

  const token = issueAdminSessionToken({ account: result.session.account, role: result.session.role });
  if (!token) {
    // 冇 ADMIN_SESSION_SECRET → 簽唔到 token → fail closed，寧願用唔到都唔好開放。
    // 🔴 2026-10-21：**唔會**再 fallback 用 service role key（見 admin-session-token.ts 註解）。
    console.error("[admin/session] 拒絕：未設定 ADMIN_SESSION_SECRET（已取消 service key fallback）。");
    return NextResponse.json(
      { ok: false, error: "系統未設定管理員憑證密鑰，管理功能停用。" },
      { status: 503 },
    );
  }

  await writeAdminAudit({
    account: result.session.account,
    action: "login_success",
    target: "session",
    // ⚠️ 登入時只記「有冇店綁定」同數量，唔記全部 id（避免一行塞幾十個 uuid）
    detail: { storeCount: storeIds.length, role: result.session.role, platform: isPlatform },
    ip,
  });

  return NextResponse.json({
    ok: true,
    token,
    account: result.session.account,
    name: result.session.name,
    role: result.session.role,
    /**
     * Scope 摘要（P0-5 / P1）：同 `resolveAdminScope()` 嘅判斷一致
     * （`manageAccounts` 為平台級過渡推導；P2 會改用明確 `scopeAllStores` flag）。
     * 前端**唔可以**用呢個值做授權判斷，只作顯示／預設選店用（真授權永遠在 server）。
     */
    scope: {
      all: isPlatform,
      storeIds,
    },
  });
}
