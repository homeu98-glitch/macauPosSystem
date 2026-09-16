// 回歸測試：落單專用終端嘅路由白名單（2026-09-16）。
//
// 呢個函式係「店員手機唔會誤入收銀台」嘅唯一判斷點。寫錯嘅後果：
//   ① 用 `includes` 而唔係段邊界比對 ⇒ `/staffing` 之類被當成合法；
//   ② 更嚴重 —— 逃生門 `/select-workbench` 被擋住，部機永遠入唔返其他工作台。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ORDER_ONLY_ALLOWED_PATHS,
  isPathAllowedOnOrderOnlyTerminal,
} from "./order-only-terminal.ts";

describe("isPathAllowedOnOrderOnlyTerminal：白名單", () => {
  it("白名單路徑一律放行", () => {
    for (const p of ORDER_ONLY_ALLOWED_PATHS) {
      assert.equal(isPathAllowedOnOrderOnlyTerminal(p), true, `${p} 應該放行`);
    }
  });

  it("帶 query / hash 都當同一條路徑", () => {
    assert.equal(isPathAllowedOnOrderOnlyTerminal("/staff?tableId=A01"), true);
    assert.equal(isPathAllowedOnOrderOnlyTerminal("/staff#top"), true);
    assert.equal(isPathAllowedOnOrderOnlyTerminal("/select-workbench?mode=staff"), true);
  });

  it("子路徑放行（前綴 + 段邊界）", () => {
    assert.equal(isPathAllowedOnOrderOnlyTerminal("/staff/settings"), true);
  });
});

describe("isPathAllowedOnOrderOnlyTerminal：攔截", () => {
  it("收銀台路由一律攔截", () => {
    const blocked = [
      "/",
      "/orders",
      "/reports",
      "/members",
      "/prints",
      "/shift",
      "/settings",
      "/retail",
      "/admin",
    ];
    for (const p of blocked) {
      assert.equal(isPathAllowedOnOrderOnlyTerminal(p), false, `${p} 應該攔截`);
    }
  });

  it("🔴 段邊界：/staffing 唔可以當成 /staff", () => {
    assert.equal(isPathAllowedOnOrderOnlyTerminal("/staffing"), false);
    assert.equal(isPathAllowedOnOrderOnlyTerminal("/login-help"), false);
    assert.equal(isPathAllowedOnOrderOnlyTerminal("/select-workbench-x"), false);
  });

  it("空 / 異常輸入唔會爆，一律當攔截", () => {
    assert.equal(isPathAllowedOnOrderOnlyTerminal(""), false);
    assert.equal(isPathAllowedOnOrderOnlyTerminal("/"), false);
  });
});
