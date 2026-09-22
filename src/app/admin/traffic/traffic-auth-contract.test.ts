import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 《admin 頁面 ↔ admin API 鑑權契約》守衛（2026-09-22）。
 *
 * ## 為何要守（首次上線就中）
 *
 * `/admin/traffic` 第一版嘅 `fetch()` **冇帶 `Authorization: Bearer <adminSessionToken>`**，
 * 而 `AdminShell` 嘅守衛係**客戶端讀 localStorage** —— 所以頁面「睇落登入咗」，
 * 但 API 回 401：KPI 全部 0、得一句「未授權」。
 *
 * ⇒ admin 頁嘅 API 一律要用 `loadAuthSession()?.adminSessionToken`
 *   砌 `Authorization: Bearer` 標頭（同 `/admin/sessions` 完全一樣）。
 *   呢個係**手寫源碼掃描**守衛：呢類「漏 header」tsc／eslint 都唔會出聲。
 */
const HERE = new URL(".", import.meta.url);
const PAGE = readFileSync(new URL("./page.tsx", HERE), "utf8");
const ROUTE = readFileSync(new URL("../../api/admin/traffic/route.ts", HERE), "utf8");

describe("/admin/traffic ── 鑑權契約", () => {
  it("🔴 頁面一定要用 `loadAuthSession()?.adminSessionToken`（同 /admin/sessions 同源）", () => {
    assert.ok(
      /loadAuthSession\(\)\?\.adminSessionToken/.test(PAGE),
      "冇讀 admin token ⇒ fetch 會 401，頁面只會顯示「未授權」（2026-09-22 首次上線就係咁）",
    );
  });

  it("🔴 fetch 一定要帶 `Authorization: Bearer`（而唔係靠 cookie／localStorage）", () => {
    assert.ok(
      /Authorization:\s*`Bearer \$\{token\}`/.test(PAGE),
      "冇帶 Authorization 標頭 ⇒ admin API 一律 401",
    );
  });

  it("冇 token 要**即刻**顯示未授權，唔好照打（避免無謂 401 + 令人誤解）", () => {
    assert.ok(
      /if \(!token\) \{[\s\S]{0,200}?return;/.test(PAGE),
      "冇 token 都照打 ⇒ console 一堆 401、頁面先至顯示錯誤",
    );
  });

  it("route 側仍然要驗 admin claims（唔可以為方便而放寬）", () => {
    assert.ok(
      /readAdminSessionFromRequest\(request\)/.test(ROUTE),
      "route 冇驗 admin session ⇒ 任何人知道 storeId 就可以讀走各店用量",
    );
    assert.ok(
      /status:\s*401/.test(ROUTE),
      "冇 token 唔係回 401 ⇒ 鑑權語義同其他 admin API 唔一致",
    );
  });
});
