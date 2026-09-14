import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_STORE_OPEN,
  normalizeStoreOpen,
  readStoreOpenFromPayload,
} from "./store-status.ts";

/**
 * 「店內營業」開關嘅防禦式解析測試（migration 0039）。
 *
 * 🔴 呢批測試鎖死兩條唔可以退讓嘅口徑：
 * 1. **未設定 / 讀唔到 → 營業中**（`DEFAULT_STORE_OPEN = true`）。反過來就會令
 *    一間未用過呢個功能嘅店（或者 migration 未跑）開機即停業。
 * 2. **只有真 boolean 才算「server 講嘅值」**（`fromServer`）。`"false"` 字串、
 *    `0`、缺欄一律 fallback —— 呢個 flag 係客端分辨「server 話已暫停」同
 *    「讀唔到所以當營業中」嘅唯一依據，錯咗就會無聲停業 / 無聲收單。
 */

test("DEFAULT_STORE_OPEN 一定要係 true（唔可以改成 false）", () => {
  assert.equal(DEFAULT_STORE_OPEN, true);
});

test("normalizeStoreOpen：真 boolean 原樣通過", () => {
  assert.equal(normalizeStoreOpen(true), true);
  assert.equal(normalizeStoreOpen(false), false);
});

test("normalizeStoreOpen：型別唔啱一律 fallback（唔會把 \"false\" 當 true/false）", () => {
  assert.equal(normalizeStoreOpen("false"), DEFAULT_STORE_OPEN);
  assert.equal(normalizeStoreOpen("true"), DEFAULT_STORE_OPEN);
  assert.equal(normalizeStoreOpen(0), DEFAULT_STORE_OPEN);
  assert.equal(normalizeStoreOpen(1), DEFAULT_STORE_OPEN);
  assert.equal(normalizeStoreOpen(null), DEFAULT_STORE_OPEN);
  assert.equal(normalizeStoreOpen(undefined), DEFAULT_STORE_OPEN);
  assert.equal(normalizeStoreOpen({}), DEFAULT_STORE_OPEN);
});

test("normalizeStoreOpen：可以自訂 fallback", () => {
  assert.equal(normalizeStoreOpen(null, false), false);
  assert.equal(normalizeStoreOpen("x", false), false);
});

test("readStoreOpenFromPayload：server 明確回已暫停", () => {
  const parsed = readStoreOpenFromPayload({ ok: true, isOpen: false, updatedAt: "2026-09-14T07:00:00Z" });
  assert.equal(parsed.isOpen, false);
  assert.equal(parsed.fromServer, true);
  assert.equal(parsed.updatedAt, "2026-09-14T07:00:00Z");
});

test("readStoreOpenFromPayload：server 明確回營業中（未設定過 row 嘅 default）", () => {
  const parsed = readStoreOpenFromPayload({ ok: true, isOpen: true, updatedAt: null });
  assert.equal(parsed.isOpen, true);
  assert.equal(parsed.fromServer, true);
  assert.equal(parsed.updatedAt, null);
});

test("readStoreOpenFromPayload：ok:false（查詢失敗）→ fallback 且 fromServer:false", () => {
  const parsed = readStoreOpenFromPayload({ ok: false, error: "boom" });
  assert.equal(parsed.isOpen, DEFAULT_STORE_OPEN);
  assert.equal(parsed.fromServer, false);
});

test("readStoreOpenFromPayload：缺 isOpen 欄（migration 未跑 / fallback 回應）→ 唔算 server 值", () => {
  const parsed = readStoreOpenFromPayload({ ok: true, fallback: true, storeId: "s1" });
  assert.equal(parsed.isOpen, DEFAULT_STORE_OPEN);
  assert.equal(parsed.fromServer, false);
});

test("readStoreOpenFromPayload：非 boolean 嘅 isOpen 唔可信", () => {
  for (const bad of ["false", "true", 0, 1, null]) {
    const parsed = readStoreOpenFromPayload({ ok: true, isOpen: bad });
    assert.equal(parsed.isOpen, DEFAULT_STORE_OPEN);
    assert.equal(parsed.fromServer, false);
  }
});

test("readStoreOpenFromPayload：非物件（null / 字串 / 陣列）一律 fallback", () => {
  for (const bad of [null, undefined, "nope", 42, []]) {
    const parsed = readStoreOpenFromPayload(bad);
    assert.equal(parsed.isOpen, DEFAULT_STORE_OPEN);
    assert.equal(parsed.fromServer, false);
  }
});

test("readStoreOpenFromPayload：updatedAt 唔係字串就當 null", () => {
  const parsed = readStoreOpenFromPayload({ ok: true, isOpen: false, updatedAt: 12345 });
  assert.equal(parsed.isOpen, false);
  assert.equal(parsed.updatedAt, null);
});
