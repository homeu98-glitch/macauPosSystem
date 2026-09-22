import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  POS_SESSION_KEY_STORAGE,
  generatePosSessionKey,
  getPosSessionKey,
  resetPosSessionKeyForTest,
  rotatePosSessionKey,
} from "./session-key.ts";

/**
 * 《工作階段識別碼》單測（2026-09-22）。
 *
 * 最緊要守住三件事：
 *   ① 同一個分頁**永遠**回同一個值（server 靠佢做 primary key；
 *      中途換 key ＝ 一部機變兩個工作階段 ⇒ 假「多開」）。
 *   ② `rotatePosSessionKey()` **一定**換新值（重新登入 ＝ 新工作階段）。
 *   ③ 冇 `sessionStorage`（Node／私密模式）都要**照跑**，唔可以 throw
 *      —— 呢個 module 會被落單路徑 import，throw 就等於全店落唔到單。
 */

describe("工作階段識別碼", () => {
  it("產生嘅係 URL-safe（符合 server 端 header 白名單）", () => {
    const key = generatePosSessionKey();
    assert.ok(key.length > 0 && key.length <= 64, `長度唔合理：${key.length}`);
    assert.match(key, /^[A-Za-z0-9_-]+$/);
  });

  it("兩次產生唔同（唔可以係常數）", () => {
    assert.notEqual(generatePosSessionKey(), generatePosSessionKey());
  });

  it("同一個 process 內重複讀回同一個值（sessionStorage 唔可用時靠模組記憶）", () => {
    resetPosSessionKeyForTest();
    const first = getPosSessionKey();
    assert.equal(getPosSessionKey(), first);
    assert.equal(getPosSessionKey(), first);
  });

  it("🔴 rotate 一定換新值（重新登入＝新工作階段，唔可以沿用被撤銷嘅 row）", () => {
    resetPosSessionKeyForTest();
    const before = getPosSessionKey();
    const after = rotatePosSessionKey();
    assert.notEqual(after, before);
    assert.equal(getPosSessionKey(), after, "rotate 之後要記住新值");
  });

  it("reset 之後會再產生一個新值", () => {
    const before = getPosSessionKey();
    resetPosSessionKeyForTest();
    assert.notEqual(getPosSessionKey(), before);
  });

  it("冇 sessionStorage／crypto 都唔會 throw（Node 環境直接跑）", () => {
    assert.doesNotThrow(() => getPosSessionKey());
    assert.doesNotThrow(() => rotatePosSessionKey());
  });

  it("storage 鍵名穩定（改咗會令舊分頁嘅 key 對唔上）", () => {
    assert.equal(POS_SESSION_KEY_STORAGE, "macau-pos-session-key");
  });
});
