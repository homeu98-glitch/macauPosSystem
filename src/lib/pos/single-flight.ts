/**
 * Single-flight 去重（2026-09-21 請求數優化）。
 *
 * ## 用途
 *
 * 多個 React component 同時 mount，各自喺 effect 內呼叫同一個「讀雲端」函式
 * ⇒ **同一個 store 同一刻會發 N 個重複請求**。實測：
 *   · `pos_online_order_settings` 同一秒 **4~5 次**（POS 主畫面 4~5 個 component 用同一個 hook）
 *   · `pos_store_status` 同一秒 **3 次**
 *
 * `createSingleFlight()` 令「同一個 key、同一刻」嘅呼叫**共用同一個 promise**
 * ⇒ 只發一個請求，而**每個呼叫端都會等到同一次讀取嘅結果**。
 *
 * ## 為何唔係「時間窗」（重要）
 *
 * 呢個係 **same-tick 合併**，唔係「X 秒內唔拉」。時間窗會改變
 * 「幾時會讀到新值」嘅語義（例如用家撳完掣 5 秒內返前景會攞唔到新值），
 * 所以刻意唔做。合併之後**值一樣、時機一樣**，只係少幾個重複請求 —— 零功能影響。
 *
 * ## 兩個死穴（都有單測）
 *
 * ① **一定要按 key 分開**（`storeId`）：唔匹配就開新 flight。
 *    否則切店時，B 店嘅呼叫會拿到 A 店 in-flight 嘅結果 → **餵錯店**（跨店污染）。
 * ② **失敗一定要清**：`.finally()` 一定要清走自己嗰條 flight；否則一次失敗
 *    會令之後所有呼叫共用同一個**已 reject** 嘅 promise（永遠拿唔到值）。
 *    ⚠️ 只可以清「自己嗰條」（比對 promise 身分），唔可以無條件設 null ——
 *    否則慢嘅舊 flight 完成時會清走後來者嘅 flight，令去重失效。
 */

export type SingleFlight<T> = (key: string, task: () => Promise<T>) => Promise<T>;

export function createSingleFlight<T>(): SingleFlight<T> {
  let inflight: { key: string; promise: Promise<T> } | null = null;

  return function run(key: string, task: () => Promise<T>): Promise<T> {
    // ① 同 key 已有 in-flight → 共用（唔會重複打）
    if (inflight && inflight.key === key) return inflight.promise;

    let promise: Promise<T>;
    try {
      promise = task();
    } catch (err) {
      // task() 同步 throw（呼叫端都係 async function，正常唔會發生）——
      // 唔好留低一個毒 inflight。行為同舊版一樣：錯誤傳返呼叫端。
      return Promise.reject(err);
    }

    // ② 只清自己嗰條（見頂部「死穴②」）
    const tracked = promise.finally(() => {
      if (inflight?.promise === tracked) inflight = null;
    });
    inflight = { key, promise: tracked };
    return tracked;
  };
}

/**
 * 目前有冇 in-flight（**只供測試／診斷**，唔好喺業務邏輯用）。
 * 各 hook 自己持有一個 instance，所以呢個係 instance 方法而唔係模組狀態。
 */
export function createSingleFlightWithProbe<T>(): {
  run: SingleFlight<T>;
  hasInflight: () => boolean;
  inflightKey: () => string | null;
} {
  let inflight: { key: string; promise: Promise<T> } | null = null;

  function run(key: string, task: () => Promise<T>): Promise<T> {
    if (inflight && inflight.key === key) return inflight.promise;
    let promise: Promise<T>;
    try {
      promise = task();
    } catch (err) {
      return Promise.reject(err);
    }
    const tracked = promise.finally(() => {
      if (inflight?.promise === tracked) inflight = null;
    });
    inflight = { key, promise: tracked };
    return tracked;
  }

  return {
    run,
    hasInflight: () => inflight !== null,
    inflightKey: () => inflight?.key ?? null,
  };
}
