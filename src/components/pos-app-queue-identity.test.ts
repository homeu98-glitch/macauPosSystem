import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 《同步隊列 array 身分》回歸守衛（2026-09-21 egress 修復）。
 *
 * ## 為何要用 source 掃描守住
 *
 * `pos-app.tsx` 係 `.tsx`，`node --test` 載入唔到（唔行 bundler、唔支援 JSX）；
 * 但呢個 bug 嘅形態**完全係 source 形態**（「有冇一條路徑換走 `queue` 身分」），
 * 所以讀文本已經足夠，而且係唯一可行嘅自動化保護。
 *
 * ## 要守嘅兩個方向
 *
 * ① **唔可以再有** `setQueue(loadQueue())` —— 呢句就算內容一個字都冇變都會換
 *    array 身分，而 `queue` 係全量拉取 effect 嘅 dependency ⇒ 直接引爆
 *    「每 4.49 秒拉一次 424 KB」循環（2026-09-21 營業中實測：5.5 分鐘 62 次 ≈ 25 MB）。
 * ② **唔可以**連 `replaceQueueFromStorage()` 都剷走 —— 剷咗之後「重新讀 localStorage」
 *    就會冇咗，`POS_SYNC_FAILED_EVENT` / 同步健康彈窗 / 重試失敗事件之後
 *    **UI 唔會再更新待同步提示**（功能倒退）。
 */
/**
 * 去掉「整行都係註釋」嘅行，再掃描。
 *
 * 為何要剝註釋：`pos-app.tsx` 內有大量註釋**刻意引用**舊寫法
 * （`// 舊版係 setQueue(loadQueue())`），如果原樣掃描就會誤報。
 * 呢個係「逐行剝」嘅簡化版：只剔除 `trim()` 之後以 `//`、`*`、`/*` 開頭嘅行，
 * 已經足夠覆蓋本檔所有註釋風格（塊註釋每一行都以 `*` 開頭）。
 */
function stripCommentLines(src: string): string {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const RAW = readFileSync(new URL("./pos-app.tsx", import.meta.url), "utf8");
/** 只有真正會執行嘅碼（註釋已剝走）。 */
const SRC = stripCommentLines(RAW);

describe("pos-app ── 同步隊列唔可以無謂換 array 身分", () => {
  it("🔴 程式碼內唔可以有任何 `setQueue(loadQueue())`（會引爆 424 KB 全量拉取循環）", () => {
    const hits = SRC.match(/setQueue\(\s*loadQueue\(\)\s*\)/g) ?? [];
    assert.equal(
      hits.length,
      0,
      `仲有 ${hits.length} 處 setQueue(loadQueue()) —— 要改用 replaceQueueFromStorage()`,
    );
  });

  it("有 `replaceQueueFromStorage()`，而且真係做內容簽名比對", () => {
    const i = SRC.indexOf("function replaceQueueFromStorage()");
    assert.ok(i > 0, "搵唔到 replaceQueueFromStorage()");
    const body = SRC.slice(i, i + 420);
    assert.ok(
      /queueSignature\(next\)/.test(body),
      "冇計簽名 ⇒ 每次都換身分，等於舊 bug",
    );
    assert.ok(
      /signature === queueSignatureRef\.current\) return;/.test(body),
      "冇「簽名一樣就 return」⇒ 守衛唔生效",
    );
    assert.ok(/setQueue\(next\)/.test(body), "連真係要更新嗰陣都冇 setQueue ⇒ UI 唔會更新");
  });

  it("🔴 backfill 同 replaceQueueFromStorage 共用同一個 ref（唔可以有兩份口徑）", () => {
    const hits = SRC.match(/lastLoadedQueueRef/g) ?? [];
    assert.equal(hits.length, 0, "仲有 lastLoadedQueueRef —— 簽名 ref 未統一，兩邊會漂移");
    const setQueueSites = SRC.match(/queueSignatureRef\.current = signature/g) ?? [];
    assert.equal(
      setQueueSites.length,
      2,
      `應該有 2 處（replaceQueueFromStorage + backfill）更新簽名 ref，實際 ${setQueueSites.length}`,
    );
  });

  it("全量拉取 effect 嘅 dependency 仍然係 `queue`（守衛靠佢，唔可以靜默改走）", () => {
    assert.ok(
      /}, \[offlineMode, runtimeRefreshTick, queue\]\);/.test(SRC),
      "全量拉取 effect 嘅 deps 變咗 ⇒ 呢個守衛嘅前提唔再成立，要重新評估",
    );
  });

  it("有三個入口真係行 replaceQueueFromStorage（同步失敗事件／健康彈窗／重試掣）", () => {
    const hits = SRC.match(/replaceQueueFromStorage\(\)/g) ?? [];
    // 1 個定義 + 3 個呼叫點
    assert.ok(
      hits.length >= 4,
      `replaceQueueFromStorage() 出現 ${hits.length} 次（預期 ≥4：1 定義 + 3 入口）`,
    );
  });

  it("🔴 `loadRuntimeState()` 有 single-flight 去重（同刻 N 個入口只發 1 個請求）", () => {
    assert.ok(
      /runtimeStateFlightRef/.test(SRC),
      "冇 single-flight ⇒ 切返前景同時（resubscribe + queue 變）會連發 2~4 次全量拉取",
    );
    assert.ok(
      /flight\(resolveStoreId\(\) \?\? "", \(\) => runLoadRuntimeState\(\)\)/.test(SRC),
      "flight key 唔係 storeId ⇒ 切店時會拿到別店 in-flight 結果（餵錯店）",
    );
    assert.ok(
      /async function runLoadRuntimeState\(\)/.test(SRC),
      "搵唔到 runLoadRuntimeState（實際做嘢嗰個）",
    );
  });
});
