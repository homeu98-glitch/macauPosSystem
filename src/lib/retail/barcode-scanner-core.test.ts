// 掃碼槍鍵盤緩衝狀態機測試（docs/124 §R1 / §2.6）
// 用 Node 內建 test runner：node --test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MAX_LENGTH,
  createBufferState,
  feedKey,
  isAllowedChar,
  isPlausibleCode,
  isPrintableKey,
  stripPrefix,
  terminatorOf,
  tickTimeout,
} from "./barcode-scanner-core.ts";
import type { ScannerProfile } from "./types.ts";

const enterProfile: ScannerProfile = {
  id: "t1",
  name: "測試槍（Enter 結尾）",
  suffix: "enter",
  timeoutMs: 50,
  minLength: 8,
  maxLength: 13,
  charset: "digits",
  source: "manual",
};

const noneProfile: ScannerProfile = { ...enterProfile, id: "t2", suffix: "none" };
const prefixProfile: ScannerProfile = { ...enterProfile, id: "t3", prefix: "~" };

/**
 * 掃一串字元（每鍵相隔 `intervalMs`），回傳最後一次結果。
 * 重餵規則同 hook 一致：**只有 timeout 完成才要重餵今次嘅 key**
 * （terminator 完成時，結尾字元已經被消耗）。
 */
function scan(
  keys: string[],
  intervalMs: number,
  profile: ScannerProfile,
  startAt = 1000,
): ReturnType<typeof feedKey> {
  let state = createBufferState();
  let now = startAt;
  let last: ReturnType<typeof feedKey> = { kind: "buffering", state };
  for (const k of keys) {
    last = feedKey(state, k, now, profile);
    state = last.state;
    if (last.kind === "complete" && last.reason === "timeout") {
      last = feedKey(state, k, now, profile);
      state = last.state;
    }
    now += intervalMs;
  }
  return last;
}

// ─────────────────────────────────────────────────────────────

test("isPrintableKey / terminatorOf：modifier 同空白唔算字元", () => {
  assert.equal(isPrintableKey("4"), true);
  assert.equal(isPrintableKey("~"), true);
  assert.equal(isPrintableKey(" "), false); // 冇條碼符號體系用空格
  assert.equal(isPrintableKey("Shift"), false);
  assert.equal(isPrintableKey("ArrowLeft"), false);
  assert.equal(isPrintableKey("Enter"), false);
  assert.equal(terminatorOf("Enter"), "enter");
  assert.equal(terminatorOf("Tab"), "tab");
  assert.equal(terminatorOf("4"), null);
});

test("stripPrefix：剝走設定咗嘅出廠前綴", () => {
  assert.equal(stripPrefix("~4891028001232", prefixProfile), "4891028001232");
  assert.equal(stripPrefix("4891028001232", prefixProfile), "4891028001232");
  assert.equal(stripPrefix("4891028001232", enterProfile), "4891028001232");
});

test("isAllowedChar：digits 收窄面；前綴本身要放行", () => {
  assert.equal(isAllowedChar("", "4", enterProfile), true);
  assert.equal(isAllowedChar("", "A", enterProfile), false);
  // 有前綴時第一個字元要放行，否則前綴永遠入唔到緩衝
  assert.equal(isAllowedChar("", "~", prefixProfile), true);
  assert.equal(isAllowedChar("~", "4", prefixProfile), true);
  assert.equal(isAllowedChar("~", "~", prefixProfile), false);
  // alnum 設定放行字母
  assert.equal(isAllowedChar("", "A", { ...enterProfile, charset: "alnum" }), true);
});

// ─────────────────────────────────────────────────────────────
// 正常掃描
// ─────────────────────────────────────────────────────────────

test("🔴 feedKey：掃碼槍速度（8ms/鍵）+ Enter → 一次完成，長度正確", () => {
  const out = scan(["4", "8", "9", "1", "0", "2", "8", "0", "0", "1", "2", "3", "2", "Enter"], 8, enterProfile);
  assert.equal(out.kind, "complete");
  if (out.kind !== "complete") return;
  assert.equal(out.code, "4891028001232");
  assert.equal(out.reason, "terminator");
  assert.equal(out.sample.chars, "4891028001232");
  assert.equal(out.sample.terminatedBy, "enter");
  assert.equal(out.sample.keyTimestamps.length, 13);
  // 完成之後緩衝要清空
  assert.equal(out.state.chars, "");
});

test("🔴 feedKey：帶 `~` 前綴 → 完成時剝走前綴", () => {
  const out = scan(["~", "4", "8", "9", "1", "0", "2", "8", "0", "0", "1", "2", "3", "2", "Enter"], 8, prefixProfile);
  assert.equal(out.kind, "complete");
  if (out.kind !== "complete") return;
  assert.equal(out.code, "4891028001232");
  assert.equal(out.sample.chars, "~4891028001232"); // 樣本保留原樣（自動學習要用）
});

test("🔴 完成契約：terminator 完成之後唔可以重餵結尾鍵（會變 empty-terminator）", () => {
  let state = createBufferState();
  let now = 1000;
  for (const k of ["1", "2", "3", "4", "5", "6", "7", "8"]) {
    state = feedKey(state, k, now, enterProfile).state;
    now += 8;
  }
  const done = feedKey(state, "Enter", now, enterProfile);
  assert.equal(done.kind, "complete");
  if (done.kind !== "complete") return;
  const again = feedKey(done.state, "Enter", now, enterProfile);
  assert.equal(again.kind, "reset");
  if (again.kind === "reset") assert.equal(again.reason, "empty-terminator");
});

test("feedKey：Tab 結尾一樣得", () => {
  const out = scan(["1", "2", "3", "4", "5", "6", "7", "8", "Tab"], 8, { ...enterProfile, suffix: "tab" });
  assert.equal(out.kind, "complete");
  if (out.kind !== "complete") return;
  assert.equal(out.sample.terminatedBy, "tab");
});

// ─────────────────────────────────────────────────────────────
// 🔴 分辨人手打字
// ─────────────────────────────────────────────────────────────

test("🔴 feedKey：人手打字速度（150ms/鍵）→ 唔會累積成條碼", () => {
  // 逐個餵，每次間隔 150ms > timeout 50ms → 每次都 reset，緩衝永遠只有一個字元
  let state = createBufferState();
  let now = 1000;
  const kinds: string[] = [];
  for (const k of ["4", "8", "9", "1", "0"]) {
    const out = feedKey(state, k, now, enterProfile);
    kinds.push(out.kind === "reset" ? `reset:${out.reason}` : out.kind);
    state = out.state;
    now += 150;
  }
  // 第一個係 buffering（緩衝空，冇得比間隔），其後每個都係 human-speed reset
  assert.equal(kinds[0], "buffering");
  assert.deepEqual(kinds.slice(1), ["reset:human-speed", "reset:human-speed", "reset:human-speed", "reset:human-speed"]);
  // 結果緩衝只淨最後一個字元（唔會累積）
  assert.equal(state.chars, "0");
});

test("🔴 人手慢慢打幾個字再撳 Enter → 雖然會「完成」，但係長度唔合理要被過濾", () => {
  let state = createBufferState();
  let now = 1000;
  for (const k of ["1", "2", "3"]) {
    const out = feedKey(state, k, now, enterProfile);
    state = out.state;
    now += 200;
  }
  const done = feedKey(state, "Enter", now, enterProfile);
  assert.equal(done.kind, "complete"); // 技術上係完成
  if (done.kind !== "complete") return;
  assert.equal(done.code, "3"); // 但只係最後一個字元
  // ✅ 所以 hook 一定要再用 isPlausibleCode 過濾
  assert.equal(isPlausibleCode(done.code, enterProfile), false);
});

test("feedKey：非數字字元（設定純數字）→ 即刻 reset", () => {
  let state = createBufferState();
  let out = feedKey(state, "4", 1000, enterProfile);
  state = out.state;
  out = feedKey(state, "A", 1008, enterProfile);
  assert.equal(out.kind, "reset");
  if (out.kind === "reset") assert.equal(out.reason, "bad-charset");
  assert.equal(out.state.chars, "");
});

test("feedKey：太長 → reset（唔係條碼）", () => {
  let state = createBufferState();
  let now = 1000;
  for (let i = 0; i < DEFAULT_MAX_LENGTH; i++) {
    const out = feedKey(state, "1", now, { ...enterProfile, maxLength: undefined });
    state = out.state;
    now += 8;
  }
  assert.equal(state.chars.length, DEFAULT_MAX_LENGTH);
  const over = feedKey(state, "1", now, { ...enterProfile, maxLength: undefined });
  assert.equal(over.kind, "reset");
  if (over.kind === "reset") assert.equal(over.reason, "too-long");
});

test("feedKey：modifier 鍵（Shift / 方向鍵）要忽略，唔可以清緩衝", () => {
  let state = createBufferState();
  let out = feedKey(state, "4", 1000, enterProfile);
  state = out.state;
  out = feedKey(state, "Shift", 1005, enterProfile);
  assert.equal(out.kind, "buffering");
  assert.equal(out.state.chars, "4"); // 緩衝保留
  out = feedKey(state, "8", 1010, enterProfile);
  assert.equal(out.state.chars, "48");
});

test("feedKey：冇緩衝就撳 Enter → empty-terminator（唔會送出空條碼）", () => {
  const out = feedKey(createBufferState(), "Enter", 1000, enterProfile);
  assert.equal(out.kind, "reset");
  if (out.kind === "reset") assert.equal(out.reason, "empty-terminator");
});

// ─────────────────────────────────────────────────────────────
// 無結尾字元（靠超時收尾）
// ─────────────────────────────────────────────────────────────

test("🔴 feedKey：suffix=none + 超時 → 完成上一串（唔會掉棄）", () => {
  let state = createBufferState();
  let now = 1000;
  for (const k of ["1", "2", "3", "4", "5", "6", "7", "8"]) {
    const out = feedKey(state, k, now, noneProfile);
    state = out.state;
    now += 8;
  }
  assert.equal(state.chars, "12345678");
  // 隔咗 200ms 再嚟一個新字元 → 上一串應該完成
  const out = feedKey(state, "9", now + 200, noneProfile);
  assert.equal(out.kind, "complete");
  if (out.kind !== "complete") return;
  assert.equal(out.code, "12345678");
  assert.equal(out.reason, "timeout");
  assert.equal(out.sample.terminatedBy, "none");
});

test("🔴 tickTimeout：只有 suffix=none 才收尾（其他型號唔可以自動送出半截單號）", () => {
  let state = createBufferState();
  let now = 1000;
  for (const k of ["1", "2", "3", "4", "5", "6", "7", "8"]) {
    state = feedKey(state, k, now, noneProfile).state;
    now += 8;
  }
  // 未夠時間 → 唔收尾
  assert.equal(tickTimeout(state, now + 10, noneProfile).kind, "buffering");
  // 過咗超時 → 收尾
  const out = tickTimeout(state, now + 200, noneProfile);
  assert.equal(out.kind, "complete");
  if (out.kind === "complete") assert.equal(out.code, "12345678");

  // ✅ Enter 型號：即使過咗超時都唔會自動送出
  let s2 = createBufferState();
  let n2 = 1000;
  for (const k of ["1", "2", "3", "4", "5", "6", "7", "8"]) {
    s2 = feedKey(s2, k, n2, enterProfile).state;
    n2 += 8;
  }
  assert.equal(tickTimeout(s2, n2 + 5000, enterProfile).kind, "buffering");
});

test("tickTimeout：空緩衝 → buffering（唔會拋錯）", () => {
  assert.equal(tickTimeout(createBufferState(), 9999, noneProfile).kind, "buffering");
});

// ─────────────────────────────────────────────────────────────
// 合理性過濾
// ─────────────────────────────────────────────────────────────

test("isPlausibleCode：長度 / 字元集把關", () => {
  assert.equal(isPlausibleCode("4891028001232", enterProfile), true);
  assert.equal(isPlausibleCode("3", enterProfile), false); // 太短
  assert.equal(isPlausibleCode("48910280012345", enterProfile), false); // 太長
  assert.equal(isPlausibleCode("4891028A", enterProfile), false); // 非數字
  assert.equal(
    isPlausibleCode("AB123456", { ...enterProfile, charset: "alnum" }),
    true,
  );
  // 冇設 minLength → 預設 6
  assert.equal(isPlausibleCode("12345", { ...enterProfile, minLength: undefined }), false);
  assert.equal(isPlausibleCode("123456", { ...enterProfile, minLength: undefined }), true);
});
