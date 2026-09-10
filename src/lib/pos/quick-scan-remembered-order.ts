import type { PosOrder } from "../types";

/**
 * 快餐掃碼：手機端「留住取餐號」（2026-09-10 用戶確認，docs/115 §11.4）。
 *
 * ## 為何需要呢個
 *
 * 快餐掃碼落單成功頁**刻意唔用 5 秒倒數自動返回**（同 kiosk 唔同）：
 * - kiosk 係店內共用平板，倒數係為咗下一位客人，而且落單即刻印咗顧客小票
 *   （號碼喺紙上）；
 * - 客人**自己部手機**冇小票，取餐號就係佢去櫃檯唯一嘅憑據 —— 倒數一過就蓋走，
 *   客人去到櫃檯 show 唔到號。
 *
 * 但快餐又**刻意唔 resume**（每單獨立，見 `use-kiosk-order.ts` resume effect），
 * 所以 reload / 誤關分頁之後唔會由 DB 撈返 → 取餐號一樣會唔見。
 * 呢個 session memory 就係補呢個窿：記住**剛落嗰一張**快餐單，令重新載入之後
 * 仍然睇得返個號。
 *
 * ## 為何用 sessionStorage（唔用 localStorage）
 *
 * 呢個係「今次瀏覽 session、呢部手機嘅客人」自己嗰張單：
 * - 換分頁 / 關 tab 就應該冇（唔係裝置級記憶，唔可以殘留到下一位客人）；
 * - 亦唔應該跨裝置同步（同 per-store 真源完全兩回事）。
 *
 * ## 為何放喺獨立檔（唔放 `kiosk-order.ts`）
 *
 * `kiosk-order.ts` 有一堆 `@/…` runtime import → 喺 `node --test` 下會
 * `ERR_MODULE_NOT_FOUND`，令呢個檔案嘅規則測唔到。呢度只 `import type`（會被
 * type-stripping 完全擦走）= **零 runtime 依賴**，可以直接單元測試。
 */

const QUICK_SCAN_LAST_ORDER_KEY = "macau-pos-quick-scan-last-order";

/** 記憶有效期：超過就當過期（唔會顯示一個幾個鐘前、甚至隔夜嘅取餐號）。 */
export const QUICK_SCAN_LAST_ORDER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * 判斷「值唔值得顯示」時**真正會讀**嘅欄位（唔要求成個 `PosOrder`）。
 *
 * 特意收窄：呢個係一個**護欄**（guard），唔係完整 validator —— 佢只需要確認
 * 「有 id、係 counter 單、`createdAt` 解得通、未過期」。寫入端只有
 * `saveQuickScanLastOrder()` 一個（一定收到完整 `PosOrder`），所以讀取端
 * `JSON.parse` 之後嘅 blind cast 係安全嘅。
 */
export type RememberableQuickOrder = {
  id?: string | null;
  tableId?: string | null;
  createdAt?: string | null;
};

/**
 * 記住嘅快餐單仲值唔值得顯示（純函式，可單元測試）。
 *
 * 條件：① 有 id；② 係快餐 / 自助 counter 單（唔係枱單）；③ `createdAt` 解得通；
 * ④ 未過期（預設 6 小時）。
 *
 * ⚠️ ② 係必須嘅護欄：呢個 key 係 sessionStorage（同分頁內所有 `/quick` 訪問共用），
 * 一旦有枱單漏咗入去，客人就會喺快餐 link 上見到一張「枱單」嘅號碼。
 */
export function quickScanRememberedOrderIsFresh(
  order: RememberableQuickOrder | null | undefined,
  nowMs: number,
  maxAgeMs: number = QUICK_SCAN_LAST_ORDER_MAX_AGE_MS,
): boolean {
  if (!order?.id) return false;
  if (!order.tableId || order.tableId !== "counter") return false;
  const created = Date.parse(order.createdAt ?? "");
  if (!Number.isFinite(created)) return false;
  return nowMs - created <= maxAgeMs;
}

/** 落單成功後記住今次快餐單（只喺客人自己部手機嘅 session 內）。 */
export function saveQuickScanLastOrder(order: PosOrder): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(QUICK_SCAN_LAST_ORDER_KEY, JSON.stringify(order));
  } catch {
    // 寫唔到（私隱模式 / 容量）唔影響落單：最多 reload 之後睇唔返個號
  }
}

/** 讀返今次 session 記住嘅快餐單；冇 / 過期 / 壞資料 / 唔係 counter 單一律回 `null`。 */
export function loadQuickScanLastOrder(nowMs: number = Date.now()): PosOrder | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(QUICK_SCAN_LAST_ORDER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PosOrder;
    if (!quickScanRememberedOrderIsFresh(parsed, nowMs)) {
      // 過期 / 唔啱形狀 → 順手清走，免得每次 reload 都再 parse 一次垃圾
      window.sessionStorage.removeItem(QUICK_SCAN_LAST_ORDER_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** 客人撳「再點一單」→ 清走記憶（否則 reload 又跳返成功頁）。 */
export function clearQuickScanLastOrder(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(QUICK_SCAN_LAST_ORDER_KEY);
  } catch {
    // 忽略
  }
}
