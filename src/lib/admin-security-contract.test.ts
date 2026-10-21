import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Admin 安全底座「源碼契約」守衛（2026-10-21 · P0-1 / P0-3 / P0-4）。
 *
 * 為何要手寫掃描而唔係單元測試：
 *   呢幾條約束係「**唔可以**出現某段 code」或「**一定**要出現某段 code」，
 *   tsc／eslint 都唔會出聲。歷史上呢類「靜靜回退」最易被人手改返轉頭：
 *     · 有人為咗令 dev 好跑，把 `ADMIN_SESSION_SECRET` 嘅 fallback 加返去 service key；
 *     · 有人見 401 麻煩，把 backoffice store route 嘅閘拆走。
 *   一旦拆走，表面功能完全正常 —— 所以只可以靠 source scan 守住。
 */
const TOKEN_SRC = readFileSync(new URL("../lib/admin-session-token.ts", import.meta.url), "utf8");
const SESSION_ROUTE = readFileSync(new URL("../app/api/admin/session/route.ts", import.meta.url), "utf8");
const STORE_ROUTE = readFileSync(
  new URL("../app/api/backoffice/stores/[storeId]/route.ts", import.meta.url),
  "utf8",
);

describe("admin 簽名密鑰 ── P0-1：唔可以 fallback 到 service role key", () => {
  it("🔴 admin-session-token.ts 唔可以讀 process.env.SUPABASE_SERVICE_*（註解提及唔算）", () => {
    assert.ok(
      !/process\.env\.SUPABASE_SERVICE_(ROLE_)?KEY/.test(TOKEN_SRC),
      "service key 一洩漏就等於可以偽造 admin token；rotate service key 亦會令 admin 全員靜默被登出。",
    );
  });

  it("resolveSecret 只可以由 ADMIN_SESSION_SECRET 取，冇就回 null（fail closed）", () => {
    assert.ok(/process\.env\.ADMIN_SESSION_SECRET\?\.trim\(\)/.test(TOKEN_SRC));
    assert.ok(/return dedicated \|\| null;/.test(TOKEN_SRC));
  });
});

describe("admin 登入 route ── P0-2 / P0-4 / P0-5", () => {
  it("必須有 IP 限流（429）", () => {
    assert.ok(/checkIpRateLimit/.test(SESSION_ROUTE), "冇 IP 限流 ⇒ 可以快速枚舉多個帳號");
    assert.ok(/status:\s*429/.test(SESSION_ROUTE));
  });

  it("必須處理 per-account 鎖定（DB 狀態），並回 Retry-After", () => {
    assert.ok(/code === "locked"/.test(SESSION_ROUTE), "唔處理 locked ⇒ 被鎖帳號只會見到『PIN 錯』");
    assert.ok(/Retry-After/.test(SESSION_ROUTE));
  });

  it("必須寫審計（成功／失敗／鎖定）", () => {
    assert.ok(/writeAdminAudit/.test(SESSION_ROUTE));
    assert.ok(/login_success/.test(SESSION_ROUTE));
    assert.ok(/login_failed/.test(SESSION_ROUTE));
    assert.ok(/login_locked/.test(SESSION_ROUTE));
  });

  it("回傳要帶 scope 摘要（P0-5，前端只作顯示，真授權在 server）", () => {
    assert.ok(/scope:\s*\{/.test(SESSION_ROUTE));
    assert.ok(/storeIds/.test(SESSION_ROUTE));
  });
});

describe("/api/backoffice/stores/[storeId] ── P0-3：唔可以再係無閘", () => {
  it("🔴 GET 必須驗 admin session 或 POS 終端憑證", () => {
    assert.ok(
      /readAdminSessionFromRequest\(request\)/.test(STORE_ROUTE),
      "冇 admin session 檢查 ⇒ 任何人都可以讀走店舖詳情（含帳號清單）",
    );
    assert.ok(/readPosDeviceTokenFromRequest\(request\)/.test(STORE_ROUTE));
    assert.ok(/status:\s*401/.test(STORE_ROUTE));
  });

  it("🔴 終端憑證唔可以越店讀（device.storeId 必須等於 storeId）", () => {
    assert.ok(
      /device\.storeId !== storeId/.test(STORE_ROUTE),
      "冇越店檢查 ⇒ 任何一台 POS 機都可以列舉其他店",
    );
    assert.ok(/status:\s*403/.test(STORE_ROUTE));
  });

  it("🔴 PATCH（停用／啟用店舖）只准 admin session，POS 終端憑證一律拒絕", () => {
    const patch = STORE_ROUTE.slice(STORE_ROUTE.indexOf("export async function PATCH"));
    assert.ok(/readAdminSessionFromRequest\(request\)/.test(patch));
    assert.ok(!/readPosDeviceTokenFromRequest/.test(patch), "PATCH 唔應該接受終端憑證");
    assert.ok(/writeAdminAudit/.test(patch), "平台級寫操作一定要落審計");
  });
});
