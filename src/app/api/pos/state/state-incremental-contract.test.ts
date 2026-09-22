import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 《增量拉取 / 舊版止血》安全契約守衛（2026-09-22 P0＋P1＋P3）。
 *
 * ## 為咩要守（呢兩條一旦被改走，係災難級而唔係效能級）
 *
 * ① **增量回傳只係「變更過嘅子集」，唔可以當「雲端全集」用。**
 *    `pos-app.tsx` 嘅孤兒單對賬判準係「雲端 `payload.orders` 冇呢張單 + 本機冇 pending
 *    事件 + 單齡 ≥10 分鐘 ⇒ 隔離」。如果增量之下照跑，**全店未變更過嘅單會一次過被
 *    隔離**（收銀枱面全部消失）。
 *
 * ② **「舊版 bundle 止血」只強制 `queue=0`。** 一定要保持「只少行數、唔改形狀」——
 *    舊分頁嘅 merge 係「本地為底 + 補 server 事件」，空 queue ＝ 完整保留本地 queue；
 *    但如果改成「回 4xx / 空 body / 改欄位名」，舊分頁就會**完全拉唔到嘢**
 *    （比多拉 500 KB 嚴重得多）。
 *
 * ③ **手動「更新」一定要全量。** 呢粒掣嘅語義係「攞返雲端真值」；若果被增量邏輯蓋過，
 *    用家撳完會見到「乜都冇變」，而孤兒單對賬亦永遠唔會再跑。
 *
 * ④ **水位唔可以喺 `truncated` 之後照更新。** 撞 `limit` ＝ 有單未拉到 ⇒
 *    一定要清水位（下次全量），否則嗰批單永久唔會出現。
 */
const HERE = new URL(".", import.meta.url);
const STATE_ROUTE = readFileSync(new URL("./route.ts", HERE), "utf8");
// ⚠️ 呢個檔案喺 `src/app/api/pos/state/` ⇒ 去 `src/` 要退 4 層。
const POS_APP = readFileSync(new URL("../../../../components/pos-app.tsx", HERE), "utf8");
const LOCAL_ORDERS = readFileSync(
  new URL("../../../../components/local-orders-panel.tsx", HERE),
  "utf8",
);
const SYNC_CLIENT = readFileSync(
  new URL("../../../../lib/pos/state-sync-client.ts", HERE),
  "utf8",
);

describe("/api/pos/state ── 增量拉取（P1）", () => {
  it("🔴 有讀 `since` 參數，而且 `ordersOnly` 一律唔做增量（報表／對賬要完整區間）", () => {
    assert.ok(/searchParams\.get\("since"\)/.test(STATE_ROUTE), "冇讀 since ⇒ 增量功能消失");
    assert.ok(
      /const incremental = Boolean\(since\) && !ordersOnly/.test(STATE_ROUTE),
      "`ordersOnly` 冇被排除 ⇒ 報表／交班／對賬守護會攞到不完整區間（靜默少錢）",
    );
  });

  it("🔴 增量行獨立單腿查詢（唔可以經三腿區間查詢）", () => {
    assert.ok(
      /incrementalOrdersPromise/.test(STATE_ROUTE) &&
        /\.gt\("updated_at", since as string\)/.test(STATE_ROUTE),
      "增量查詢唔見咗 ⇒ 會退化成三腿 OR 查詢（又貴又語義唔明）",
    );
    assert.ok(
      /const ordersInRangePromise = incrementalOrdersPromise\s*\n?\s*\? null/.test(STATE_ROUTE.replace(/\s+/g, " ")) ||
        /incrementalOrdersPromise\s*\? null\s*:/.test(STATE_ROUTE.replace(/\s+/g, " ")),
      "增量之下仍然會行三腿查詢 ⇒ 白費一次查詢（優化失效）",
    );
  });

  it("🔴 增量時 queue 一定要跳過（`limit(0)`）", () => {
    assert.ok(
      /!skipQueue && !legacyQueueSuppressed && !incremental && storeId/.test(STATE_ROUTE),
      "增量／舊版之下仍然照拉 300 條 queue（≈500 KB）⇒ 止血同增量都失效",
    );
  });

  it("回應要帶 `incremental` 同 `truncated`（client 靠佢哋決定對賬／清水位）", () => {
    assert.ok(/incremental \? \{ incremental: true \}/.test(STATE_ROUTE), "冇回 incremental 旗標");
    assert.ok(/incrementalTruncated \? \{ truncated: true \}/.test(STATE_ROUTE), "冇回 truncated 旗標");
  });

  it("🔴 撞 limit ／查詢失敗都當 truncated（唔可以靜默截斷）", () => {
    assert.ok(
      /Boolean\(incrementalResult\?\.error\)/.test(STATE_ROUTE),
      "查詢失敗冇當 truncated ⇒ client 唔會清水位，會永久缺一批單",
    );
    assert.ok(
      /isIncrementalTruncated\(/.test(STATE_ROUTE),
      "冇用 isIncrementalTruncated ⇒ 撞 limit 唔會被發現",
    );
  });
});

describe("/api/pos/state ── 舊版止血（P0）", () => {
  it("🔴 legacy（非 ordersOnly 且冇 skipQueue）一定要強制 queue=0", () => {
    assert.ok(
      /const legacyQueueSuppressed = isLegacyFullState/.test(STATE_ROUTE),
      "止血開關唔見咗 ⇒ 一部舊分頁又可以每 4.6 秒燒 903 KB",
    );
  });

  it("🔴 止血只可以「少行數」，唔可以改回應形狀（否則舊分頁完全拉唔到）", () => {
    // 唔准出現「legacy → 回錯誤 / 回空 body」嘅寫法
    assert.ok(
      !/isLegacyFullState[\s\S]{0,400}?status:\s*(4\d\d|5\d\d)/.test(STATE_ROUTE),
      "舊版路徑唔可以回 4xx/5xx（會令舊分頁完全拉唔到嘢，比多拉 500 KB 嚴重）",
    );
  });

  it("仍然保留 `legacy=1` 嘅 egress log 維度（診斷唔可以斷）", () => {
    assert.ok(/legacy: isLegacyFullState \? 1 : 0/.test(STATE_ROUTE), "legacy 診斷欄唔見咗");
    assert.ok(/legacyQueueOff: legacyQueueSuppressed \? 1 : 0/.test(STATE_ROUTE), "止血狀態冇記錄");
  });
});

describe("client ── 增量拉取嘅兩條安全閘", () => {
  it("🔴🔴 孤兒單對賬只可以喺**全量**之下跑", () => {
    assert.ok(
      /if \(!payload\.incremental\) \{[\s\S]{0,600}?computeOrphanLocalOrders\(/.test(POS_APP) ||
        /payload\.incremental[\s\S]{0,200}?computeOrphanLocalOrders\(/.test(POS_APP),
      "增量之下照跑孤兒單對賬 ⇒ 全店未變更過嘅單會一次過被隔離（災難級）",
    );
  });

  it("🔴 手動「更新」一定要 forceFull（唔可以同 in-flight 增量合併）", () => {
    assert.ok(
      /loadRuntimeState\("manual", \{ forceFull: true \}\)/.test(POS_APP),
      "手動更新唔係全量 ⇒ 撳完見到「乜都冇變」，孤兒單對賬亦永遠唔會跑",
    );
    assert.ok(
      /if \(opts\?\.forceFull\) return runLoadRuntimeState\(src, \{ forceFull: true \}\)/.test(POS_APP),
      "forceFull 冇繞過 single-flight ⇒ 撞正 in-flight 增量時會攞到差量",
    );
  });

  it("🔴 `truncated` ⇒ 清水位（下次全量）＋ 補拉一次", () => {
    assert.ok(/commitStateSince\(sinceTicket, true\)/.test(POS_APP), "截斷冇清水位");
    assert.ok(/forceFull: true \}\);?\s*\}, 1_000\)/.test(POS_APP), "截斷之後冇補拉全量");
  });

  it("兩個入口（工作台 + 訂單頁）共用同一套水位", () => {
    assert.ok(/beginStateSince\(/.test(POS_APP), "pos-app 冇用共用 helper");
    assert.ok(/beginStateSince\(/.test(LOCAL_ORDERS), "訂單頁冇用共用 helper");
    assert.ok(/commitStateSince\(/.test(SYNC_CLIENT), "helper 內部冇更新水位");
  });

  it("水位只可以喺**成功**之後更新（失敗／401 唔可以推進水位）", () => {
    // 檢查 pos-app：`commitStateSince` 必須喺 `response.json()` 之後（即已成功）
    const at = POS_APP.indexOf("const payload = (await response.json())");
    const commit = POS_APP.indexOf("commitStateSince(sinceTicket");
    assert.ok(at > 0 && commit > at, "水位更新唔喺成功回應之後 ⇒ 失敗都會推進水位（會漏單）");
  });
});
