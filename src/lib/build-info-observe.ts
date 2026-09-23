import { setObservedServerBuildId } from "@/lib/build-info";
import { POS_BUILD_HEADER } from "@/lib/pos/session-record";

/**
 * 由**已經收到嘅**回應讀取「伺服器線上版本」（2026-09-23）。
 *
 * ## 用途
 *
 * `build-stale-banner.tsx` 要有「本機 JS ≠ 線上最新」才出現。本機版本係建置時
 * 內聯嘅（唔使問人），但「線上最新」只可以經**回應標頭** `x-pos-build` 得知。
 *
 * ## 🔴 硬性紀律：唔准為咗呢件事增加任何請求
 *
 * 呢個專案對請求數／egress 極敏感（見 `docs/113`、`src/lib/pos/egress-meter-server.ts`）。
 * ⇒ **唔可以**為咗令版本資訊快啲到手而加一個版本檢查 endpoint、或者加快現有輪詢間隔。
 * 唯一允許嘅做法：喺**本來已經會發生**嘅請求嘅回應上讀標頭。
 *
 * 目前掛喺兩個既有週期請求（兩者都係 client 本來就會打）：
 * | 來源 | 頻率 | 掛喺邊 |
 * |---|---|---|
 * | `POST /api/pos/sync` | 有 pending 事件時每 30 秒 | `sync-flush.ts` |
 * | `GET /api/pos/shift` | 每 180 秒（受輪詢閘限制） | `shift-sync.ts` |
 * | `GET /api/pos/state` | 事件驅動（mount／重連／手動） | `pos-app.tsx` 直接 `setObservedServerBuildId` |
 *
 * ## 為何係獨立一個檔（而唔係加落 `@/lib/build-info`）
 *
 * `@/lib/build-info` 有**零 import** 嘅硬約束（`npm test` ＝ `node --test`，
 * 唔認 `@/` 別名 ⇒ 一 import 就令成套單測跑唔到；守衛測試會捉）。
 * 但呢個函式一定要知標頭名（`POS_BUILD_HEADER`，真源喺 `@/lib/pos/session-record`），
 * 亦唔應該喺兩處各自寫死標頭字串（同一口徑寫兩次必然漂移）。
 * ⇒ 抽出嚟做一個有 import 嘅薄層。
 *
 * ## 為何要 `try/catch`
 *
 * 讀標頭理論上唔會 throw，但呢個函式會喺**落單／同步／班次**嘅熱路徑上被呼叫。
 * 任何意外都**絕對唔可以**影響收銀流程 ⇒ 一律靜默吞掉：最壞情況只係少一次版本更新。
 */
export function observeServerBuildFromResponse(response: Response | null | undefined): void {
  try {
    if (!response?.headers) return;
    setObservedServerBuildId(response.headers.get(POS_BUILD_HEADER));
  } catch {
    // 靜默：版本偵測係增強功能，唔可以影響任何業務流程。
  }
}
