import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 《admin/dashboard ── 店主帳號唔可以操作商家》守衛（2026-10-23，J 回報）。
 *
 * ## 為何要守
 *
 * 店主帳號登入 admin panel，「商家列表」每行都見到「模組」＋「停用／啟用」。
 * server 一早封咗（`requireAdmin(request, { platform: true })` ⇒ 403），
 * 但舊版 UI **無條件 render** 兩個按鈕 ⇒ 店主「撳得出、儲存先死」，
 * 令人誤以為自己有權限改嘢。
 *
 * ⇒ 頁面一定要經 `GET /api/admin/me` 拎 `scope.all`，非平台（或未載入）
 *   一律唔 render「操作」欄（表頭 + 身體一齊閘）。
 *   呢個係**手寫源碼掃描**守衛：呢類「UI 洩漏」tsc／eslint 都唔會出聲。
 */
const HERE = new URL(".", import.meta.url);
const PAGE = readFileSync(new URL("./page.tsx", HERE), "utf8");
const STATUS_ROUTE = readFileSync(new URL("../../api/admin/merchants/status/route.ts", HERE), "utf8");
const MODULES_ROUTE = readFileSync(new URL("../../api/admin/merchants/modules/route.ts", HERE), "utf8");

describe("/admin/dashboard ── scope gate 契約", () => {
  it("🔴 頁面一定要打 /api/admin/me 拎 scope（client 唔可以自己推定身份）", () => {
    assert.ok(
      PAGE.includes("/api/admin/me"),
      "冇打 /api/admin/me ⇒ 頁面根本唔知登入者係平台定店主",
    );
  });

  it("🔴 fetch 一定要帶 `Authorization: Bearer`（同其他 admin 頁一致）", () => {
    assert.ok(
      /Authorization:\s*`Bearer \$\{token/.test(PAGE),
      "冇帶 Authorization 標頭 ⇒ /api/admin/me 會 401，scope 永遠拎唔到",
    );
  });

  it("🔴 isPlatform 初值一定要 null（未載入 = 非平台，fail-closed）", () => {
    assert.ok(
      /useState<boolean \| null>\(null\)/.test(PAGE),
      "初值唔係 null ⇒ 載入中都會見到大平台操作按鈕",
    );
  });

  it("🔴 fetch 失敗／非 ok 都要當非平台（唔可以 fail-open）", () => {
    assert.ok(
      /setIsPlatform\(false\)/.test(PAGE),
      "冇失敗降級 ⇒ 網絡錯誤時按鈕照出，違反 fail-closed",
    );
    assert.ok(
      /setIsPlatform\(res\.ok && json\.ok === true/.test(PAGE),
      "一定要顯式驗 res.ok + json.ok 先至當平台",
    );
  });

  it("🔴 「操作」表頭一定要受 isPlatform === true gate", () => {
    assert.ok(
      /isPlatform === true \? \(\s*<th[^>]*>操作<\/th>/.test(PAGE),
      "「操作」表頭冇受 gate ⇒ 店主帳號會見到一個空嘅操作欄",
    );
  });

  it("🔴 「模組」＋「停用／啟用」按鈕一定要受 isPlatform === true gate", () => {
    assert.ok(
      /isPlatform === true \? \(\s*<td[^>]*>[\s\S]*?停用/.test(PAGE),
      "操作按鈕冇受 gate ⇒ 店主帳號「撳得出、儲存先死」（J 2026-10-23 回報）",
    );
  });

  it("server 側仍然要 platform: true（UI gate 唔係授權，唔可以為方便而放寬）", () => {
    assert.ok(
      /requireAdmin\(request/.test(STATUS_ROUTE) && /platform:\s*true/.test(STATUS_ROUTE),
      "merchants/status 冇 platform: true ⇒ 店主帳號可以停用商家",
    );
    // modules PATCH 先至要 platform: true（GET 允許店主讀自己店嘅授權，屬預期）。
    assert.ok(
      /platform:\s*true/.test(MODULES_ROUTE),
      "merchants/modules PATCH 冇 platform: true ⇒ 店主帳號可以改模組授權",
    );
  });
});
