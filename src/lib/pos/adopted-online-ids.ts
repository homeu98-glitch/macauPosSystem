/**
 * 線上單自動補建嘅**雲端交叉核對**客戶端（2026-09-27）。
 *
 * ## 呢個模組嘅職責（單一）
 *
 * 由 `/api/pos/adopted-online-ids` 攞「雲端**早已經**入帳嘅 Ledger 單 id」集合，
 * 供 `adoptCompletedLedgerOrderToLocal()` 嘅呼叫端併入判準 —— 令「換機／本機冇歷史」
 * 時都唔會誤補一張**雲端明明已經有**嘅單。
 *
 * ## 🔴 鐵律：呢個係**加分項**，唔可以變成必要條件
 *
 * 呢條 route 壞（500／超時／未配置）→ 必須 fallback 返「只用本機判準」＝
 * **行為同今日完全一致**。所以：
 * - 任何錯誤一律回**空集合**（唔 throw）；
 * - 呼叫端把結果**合併**（union）入本機集合，而唔係取代；
 * - 有 timeout（唔可以因為對方慢而拖住 UI）。
 *
 * ## 為何判定邏輯唔喺呢度
 *
 * `npm test` ＝ `node --test`：唔認 `@/` 別名、唔行 bundler。純判定函式收喺
 * `./adopt-completed-ledger-orders.ts`（**零 import**）以便直接測試；
 * 呢個檔案只負責 `fetch`（測試唔會碰）。
 */
import { parseAdoptedOnlineIds } from "@/lib/pos/adopt-completed-ledger-orders";

/** 請求 timeout（5 秒）—— 避免拖住對數節拍。 */
export const ADOPTED_ONLINE_IDS_TIMEOUT_MS = 5_000;

/**
 * 抓雲端已入帳 id 集合。
 *
 * 🔴 任何失敗（網絡／500／超時／格式錯）一律回 **空集合**，唔 throw。
 *    呼叫端會把它併入本機集合 ⇒「空」＝「冇額外資訊」，行為同今日一致。
 *
 * @param hours 回溯時數（route 會夾在 1–168）。
 */
export async function fetchAdoptedOnlineIds(params: {
  storeId: string;
  hours?: number;
  /** 測試／特殊環境可注入；預設用 global fetch。 */
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const { storeId } = params;
  if (!storeId) return [];

  const doFetch = params.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return [];

  const hours = params.hours ?? 48;
  const url = `/api/pos/adopted-online-ids?storeId=${encodeURIComponent(storeId)}&hours=${hours}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ADOPTED_ONLINE_IDS_TIMEOUT_MS);
  try {
    const response = await doFetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return [];
    const payload = await response.json();
    // 純判定委派出去（可測、零 import）。
    return parseAdoptedOnlineIds(payload);
  } catch {
    // fail-open：任何錯誤都當「冇額外資訊」。
    return [];
  } finally {
    clearTimeout(timer);
  }
}
