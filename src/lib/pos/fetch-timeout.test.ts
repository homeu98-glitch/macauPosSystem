import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { FetchTimeoutError, fetchWithTimeout } from "./fetch-timeout.ts";

/**
 * `fetchWithTimeout`（2026-10-29 · 離線可用性 P2）。
 *
 * 為何要用測試鎖死：呢個 helper 嘅唯一價值係「**有 wifi 但上唔到網** 時唔好掛住」。
 * 而佢有兩個相反方向嘅靜默失效模式：
 *   · **逾時唔生效** → 落單照樣轉圈 30–120 秒，等於冇改（而且比改之前更難察覺，
 *     因為代碼「睇落」已經有保護）。
 *   · **誤判逾時** → 把正常嘅 `AbortError`／網絡錯誤標成 `FetchTimeoutError`，
 *     上層就會當成「server 慢」而做出錯誤判斷。
 * 兩邊都唔會拋錯，只會靜靜錯，所以一定要有測試。
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** 掛住唔返，但尊重 `signal` 嘅 fetch（模擬半開連線）。 */
function hangingFetch(): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // 冇 signal 就真係永遠唔返（測試會 timeout，即代表 helper 冇傳 signal）
      if (signal.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
        return;
      }
      signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    })) as typeof fetch;
}

describe("fetchWithTimeout — 正常情況唔受影響", () => {
  it("server 正常回應 → 原樣回傳，唔會拋錯", async () => {
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;

    const res = await fetchWithTimeout("/api/pos/sequence", { method: "POST" }, 1000);

    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  });

  it("普通網絡錯誤 → 原樣拋出（唔會被誤標成逾時）", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;

    await assert.rejects(
      () => fetchWithTimeout("/api/pos/sequence", {}, 1000),
      (err: unknown) => {
        assert.ok(!(err instanceof FetchTimeoutError), "普通網絡錯誤唔應該變成 FetchTimeoutError");
        assert.equal((err as Error).name, "TypeError");
        return true;
      },
    );
  });
});

describe("fetchWithTimeout — 🔴 掛住嘅連線一定要斷", () => {
  it("半開連線（永不回應）→ 拋 FetchTimeoutError，而且唔會等足瀏覽器預設超時", async () => {
    globalThis.fetch = hangingFetch();

    const started = Date.now();
    await assert.rejects(
      () => fetchWithTimeout("/api/pos/sequence", { method: "POST" }, 120),
      (err: unknown) => {
        assert.ok(err instanceof FetchTimeoutError, "應該係 FetchTimeoutError");
        return true;
      },
    );
    const elapsed = Date.now() - started;

    // 上限寬鬆（CI 慢機都可能拖），但一定要遠低於瀏覽器預設嘅 30–120 秒。
    assert.ok(elapsed < 2000, `耗時 ${elapsed}ms，逾時明顯冇生效`);
  });

  it("呼叫端自己 abort → 拋原本嘅 AbortError，唔好扮成逾時", async () => {
    globalThis.fetch = hangingFetch();

    const outer = new AbortController();
    setTimeout(() => outer.abort(), 30);

    await assert.rejects(
      () => fetchWithTimeout("/api/pos/sequence", { signal: outer.signal }, 5000),
      (err: unknown) => {
        assert.ok(!(err instanceof FetchTimeoutError), "外部 abort 唔應該變成 FetchTimeoutError");
        assert.equal((err as Error).name, "AbortError");
        return true;
      },
    );
  });

  it("傳入時已經 abort → 即刻失敗（唔會等 timeout）", async () => {
    const outer = new AbortController();
    outer.abort();
    globalThis.fetch = hangingFetch();

    const started = Date.now();
    await assert.rejects(() => fetchWithTimeout("/x", { signal: outer.signal }, 5000));
    assert.ok(Date.now() - started < 1000, "已 abort 嘅 signal 應該即刻生效");
  });
});
