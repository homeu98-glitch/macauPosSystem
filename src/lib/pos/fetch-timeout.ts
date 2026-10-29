/**
 * `fetch` ＋ 硬逾時（2026-10-29，離線可用性 P2）。
 *
 * ## 為何要有呢個檔
 *
 * POS 好多請求嘅「失敗路徑」本身已經寫好（本地序號 fallback、bootstrap cache、
 * outbox 排隊…），但前提係 `fetch` **會失敗**。
 *
 * 而「冇網絡」其實有兩種，行為完全唔同：
 *
 * | 情況 | `fetch` 行為 | POS 後果 |
 * |---|---|---|
 * | 完全斷網（wifi / data 全關） | 即刻 reject `ERR_INTERNET_DISCONNECTED` | 正常降級，已實測 ✅ |
 * | **有 wifi 但上唔到網**（DNS 死、hotspot 冇 uplink、server hang、半開連線） | **一直掛住**，直到瀏覽器預設超時（Chrome 30–120 秒，WebView 更差） | 落單轉圈、開機卡「正在載入門店設定…」 ❌ |
 *
 * 門店最常遇到嘅正正係第二種（router 通、寬頻斷）。所以凡係
 * **「一邊等 server、一邊擋住店員做嘢」** 嘅呼叫，都要有硬逾時。
 *
 * ## 唔係所有 fetch 都應該用
 *
 * 只適用於**已經有本地 fallback** 嘅呼叫。有 `since` 水位語意嘅
 * `/api/pos/state` 增量拉取**唔好**加（中斷會令水位同資料唔一致），
 * 佢本身 `catch { /* ignore *\/ }` 唔會擋 UI，掛住只係浪費一條連線。
 *
 * ## 為何唔用 `AbortSignal.timeout()`
 *
 * 同 `sync-flush.ts` / `realtime-target.ts` 一致：舊 iPad Safari 未支援
 * （`AbortSignal.timeout` 要 Safari 16+），所以一律手動 `AbortController`。
 */

/** 開機拉門店設定：要有返咁上下耐（大店 bootstrap 可以幾 MB），但唔可以無限等。 */
export const BOOTSTRAP_FETCH_TIMEOUT_MS = 8_000;

/**
 * 落單前取店內序號：**必須短**。
 *
 * 呢個請求喺「店員撳落單」嘅同步路徑上（`pos-app.tsx` `submitOrder`），
 * 佢未返之前訂單唔會寫入 localStorage、`orderSubmitting` 一直 true
 * ＝ 個掣一直轉圈。等 8 秒不如即刻用本地序號（`nextLocalDailyOrderNo()`），
 * 連網後 server 會對齊。
 */
export const SEQUENCE_FETCH_TIMEOUT_MS = 2_500;

/** 逾時／被中止時拋出，方便呼叫端分辨（一般唔需要，`catch` 一律當連線失敗）。 */
export class FetchTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`fetch 逾時（${timeoutMs}ms）`);
    this.name = "FetchTimeoutError";
  }
}

/**
 * 同 `fetch` 一樣用，但 `timeoutMs` 內未返就 abort 並拋 `FetchTimeoutError`。
 *
 * ⚠️ 呼叫端傳入嘅 `init.signal` 會被一併尊重（任何一邊 abort 都會中止）。
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const outer = init.signal;

  const forwardAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", forwardAbort, { once: true });
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    // 只將「我哋自己造成嘅逾時」換成專屬錯誤；
    // 其他網絡錯誤（DNS／斷線／被外層 abort）原樣拋，等呼叫端行為不變。
    if (timedOut) throw new FetchTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", forwardAbort);
  }
}
