import { test } from "node:test";
import assert from "node:assert/strict";

import { createMemberLoginLimiter } from "./member-login-limit.ts";

const T0 = 1_700_000_000_000;

test("全新 key：放行 + 剩餘等於上限", () => {
  const limiter = createMemberLoginLimiter();
  const state = limiter.check("k", T0);
  assert.equal(state.allowed, true);
  assert.equal(state.remaining, 5);
  assert.equal(state.retryAfterSec, 0);
});

test("連續敗 4 次仍然放行，剩餘遞減", () => {
  const limiter = createMemberLoginLimiter();
  for (let i = 1; i <= 4; i += 1) {
    const state = limiter.recordFailure("k", T0 + i * 1000);
    assert.equal(state.allowed, true, `第 ${i} 次應該仍然放行`);
    assert.equal(state.remaining, 5 - i);
  }
});

test("第 5 次失敗即鎖，回 900 秒", () => {
  const limiter = createMemberLoginLimiter();
  for (let i = 1; i <= 4; i += 1) limiter.recordFailure("k", T0 + i * 1000);
  const state = limiter.recordFailure("k", T0 + 5000);
  assert.equal(state.allowed, false);
  assert.equal(state.remaining, 0);
  assert.equal(state.retryAfterSec, 900);
});

test("鎖定中再 check 一律拒絕", () => {
  const limiter = createMemberLoginLimiter();
  for (let i = 1; i <= 5; i += 1) limiter.recordFailure("k", T0 + i * 1000);
  const state = limiter.check("k", T0 + 10 * 60_000);
  assert.equal(state.allowed, false);
  assert.ok(state.retryAfterSec > 0);
});

test("鎖定期過：恢復放行 + 剩餘回滿", () => {
  const limiter = createMemberLoginLimiter();
  // 鎖係由**最後一次失敗**起算 15 分鐘（唔係由窗口起點）。
  for (let i = 1; i <= 5; i += 1) limiter.recordFailure("k", T0 + i * 1000);
  const lockedState = limiter.check("k", T0 + 15 * 60_000 + 1);
  assert.equal(lockedState.allowed, false, "最後一次失敗之後 15 分鐘內仍然應該鎖住");

  const state = limiter.check("k", T0 + 5000 + 15 * 60_000 + 1);
  assert.equal(state.allowed, true);
  assert.equal(state.remaining, 5);
});

test("未達上限但窗口已過：計數歸零（唔會跨窗口累積）", () => {
  const limiter = createMemberLoginLimiter();
  limiter.recordFailure("k", T0);
  limiter.recordFailure("k", T0 + 1000);
  const state = limiter.check("k", T0 + 15 * 60_000 + 1);
  assert.equal(state.allowed, true);
  assert.equal(state.remaining, 5);
});

test("成功登入 clear 之後：即刻回復全部次數", () => {
  const limiter = createMemberLoginLimiter();
  for (let i = 1; i <= 4; i += 1) limiter.recordFailure("k", T0 + i * 1000);
  limiter.clear("k");
  const state = limiter.check("k", T0 + 5000);
  assert.equal(state.allowed, true);
  assert.equal(state.remaining, 5);
});

test("唔同 key 互不影響（IP 維度同電話維度要分開）", () => {
  const limiter = createMemberLoginLimiter();
  for (let i = 1; i <= 5; i += 1) limiter.recordFailure("ip:1.1.1.1", T0 + i * 1000);
  assert.equal(limiter.check("ip:1.1.1.1", T0 + 6000).allowed, false);
  assert.equal(limiter.check("phone:60000003", T0 + 6000).allowed, true);
});

test("自訂參數：max 3 + 鎖 1 秒", () => {
  const limiter = createMemberLoginLimiter({ maxAttempts: 3, lockMs: 1000, windowMs: 60_000 });
  limiter.recordFailure("k", T0);
  limiter.recordFailure("k", T0 + 1);
  const locked = limiter.recordFailure("k", T0 + 2);
  assert.equal(locked.allowed, false);
  assert.equal(locked.retryAfterSec, 1);
  const state = limiter.check("k", T0 + 1003);
  assert.equal(state.allowed, true);
  assert.equal(state.remaining, 3, "解鎖後唔可以沿用舊失敗計數，否則即刻再鎖");
});
