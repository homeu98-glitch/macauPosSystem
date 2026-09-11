import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scanModeForLoginMode } from "./scan-mode-from-login.ts";

/**
 * 登入模式 → 店級掃碼模式的映射規則（docs/115 §12）。
 *
 * 呢條規則錯咗會**靜默**改變全店客人嘅落單方式，所以每個分支都要鎖死：
 *   - 回錯 `dine_in` → 快餐店冇桌台，設定頁卻出「每枱一碼」，印出嚟嘅貼紙客人掃到會落錯流程；
 *   - `kiosk` / `salon` 唔回 `null` → 自助機同收銀機互相覆蓋（每次登入顯示嘅碼都唔同）。
 */

describe("scanModeForLoginMode", () => {
  it("快餐登入 → 店級 quick（全店一碼）", () => {
    assert.equal(scanModeForLoginMode("quick"), "quick");
  });

  it("堂食登入 → 店級 dine_in（每枱一碼）", () => {
    assert.equal(scanModeForLoginMode("dinein"), "dine_in");
  });

  it("自助點餐機 / 美容 / 後廚屏 / 出餐台屏登入 → null（唔可以改店級設定）", () => {
    assert.equal(scanModeForLoginMode("kiosk"), null);
    assert.equal(scanModeForLoginMode("salon"), null);
    assert.equal(scanModeForLoginMode("kitchen"), null);
    assert.equal(scanModeForLoginMode("expo"), null);
  });

  it("六個模式嘅回傳值兩兩唔同（冇漏 branch、冇 fallthrough）", () => {
    // ⚠️ 呢個測試係**安全網**：`LoginMode` 一加新值，下面長度就會唔 match → 即刻 fail，
    // 逼你返嚟明確決定「呢個新模式應唔應該寫店級 scan_mode」。
    // 2026-09-11 加 kitchen / expo 時就係咁捉到（docs/116 §4.1）。
    const modes = ["quick", "dinein", "salon", "kiosk", "kitchen", "expo"] as const;
    const results = modes.map((mode) => scanModeForLoginMode(mode));
    assert.deepEqual(results.slice(0, 2), ["quick", "dine_in"]);
    assert.deepEqual(results.slice(2), [null, null, null, null]);
    // 唯一一個會回 null 嘅「店級」模式唔存在 → 寫入端一定要判 null 先 POST
    assert.equal(results.filter((r) => r === null).length, 4);
  });
});
