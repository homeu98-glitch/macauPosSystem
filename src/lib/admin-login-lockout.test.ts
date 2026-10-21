import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INITIAL_LOCKOUT,
  LOCK_MS,
  MAX_FAILED_ATTEMPTS,
  isLocked,
  lockRemainingSec,
  lockoutFromRow,
  lockoutToRow,
  onFailure,
  onSuccess,
} from "./admin-login-lockout.ts";

/**
 * Admin 失敗鎖定（2026-10-21 · P0-2，對應 D2「沿用 4 位 PIN」）。
 *
 * 4 位 PIN = 10⁴ 組合、帳號 = 可枚舉嘅 8 位電話 ⇒ 呢個鎖定係唯一有效嘅防線
 * （IP 限流換 IP 即繞過）。所以臨界值一定要有測試，唔可以靠「睇落好似啱」。
 */
describe("admin-login-lockout ── 失敗鎖定", () => {
  const T0 = 1_700_000_000_000; // 固定時間，避免 flaky

  it("初始狀態：未鎖、0 次", () => {
    assert.equal(isLocked(INITIAL_LOCKOUT, T0), false);
    assert.equal(lockRemainingSec(INITIAL_LOCKOUT, T0), 0);
  });

  it("第 1–4 次失敗：只累加，唔鎖", () => {
    let state = INITIAL_LOCKOUT;
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i += 1) {
      state = onFailure(state, T0);
      assert.equal(state.failedLoginCount, i);
      assert.equal(state.lockedUntilMs, null);
      assert.equal(isLocked(state, T0), false);
    }
  });

  it(`第 ${MAX_FAILED_ATTEMPTS} 次失敗：即刻鎖 ${LOCK_MS / 60000} 分鐘`, () => {
    let state = INITIAL_LOCKOUT;
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      state = onFailure(state, T0);
    }
    assert.equal(state.lockedUntilMs, T0 + LOCK_MS);
    assert.equal(isLocked(state, T0), true);
    assert.equal(lockRemainingSec(state, T0), LOCK_MS / 1000);
  });

  it("鎖定過期邊界：到期前 1ms 仍鎖、到期即解", () => {
    let state = INITIAL_LOCKOUT;
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) state = onFailure(state, T0);

    assert.equal(isLocked(state, T0 + LOCK_MS - 1), true);
    assert.equal(isLocked(state, T0 + LOCK_MS), false);
    assert.equal(lockRemainingSec(state, T0 + LOCK_MS - 1000), 1);
  });

  it("🔴 鎖定過期後再失敗 = 新一輪的第 1 次（唔可以喺舊 count 上累加，否則一次失誤即再鎖死）", () => {
    let state = INITIAL_LOCKOUT;
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) state = onFailure(state, T0);

    const afterExpiry = onFailure(state, T0 + LOCK_MS + 1);
    assert.equal(afterExpiry.failedLoginCount, 1);
    assert.equal(afterExpiry.lockedUntilMs, null);
    assert.equal(isLocked(afterExpiry, T0 + LOCK_MS + 1), false);
  });

  it("成功登入清零", () => {
    const failed = onFailure(onFailure(INITIAL_LOCKOUT, T0), T0);
    assert.deepEqual(onSuccess(), INITIAL_LOCKOUT);
    assert.notDeepEqual(failed, onSuccess());
  });

  it("lockoutFromRow：欄位未加／null／undefined 一律當未鎖（migration 0068 未跑時仍可登入）", () => {
    assert.deepEqual(lockoutFromRow({}), INITIAL_LOCKOUT);
    assert.deepEqual(lockoutFromRow({ failed_login_count: null, locked_until: null }), INITIAL_LOCKOUT);
    assert.deepEqual(lockoutFromRow({ failed_login_count: 3 }), { failedLoginCount: 3, lockedUntilMs: null });
  });

  it("lockoutFromRow：支援 ISO 字串同 Date；垃圾值當未鎖", () => {
    const iso = new Date(T0).toISOString();
    assert.deepEqual(lockoutFromRow({ failed_login_count: 5, locked_until: iso }), {
      failedLoginCount: 5,
      lockedUntilMs: T0,
    });
    assert.deepEqual(lockoutFromRow({ failed_login_count: 5, locked_until: new Date(T0) }).lockedUntilMs, T0);
    assert.equal(lockoutFromRow({ locked_until: "not-a-date" }).lockedUntilMs, null);
  });

  it("lockoutToRow：null ↔ null；有鎖時寫 ISO 字串（Supabase timestamptz 可解析）", () => {
    assert.deepEqual(lockoutToRow(INITIAL_LOCKOUT), { failed_login_count: 0, locked_until: null });
    const row = lockoutToRow({ failedLoginCount: 5, lockedUntilMs: T0 });
    assert.equal(row.locked_until, new Date(T0).toISOString());
  });
});
