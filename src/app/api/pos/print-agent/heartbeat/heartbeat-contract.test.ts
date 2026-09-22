import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 《中繼 APK 心跳合約》守衛（2026-09-21）。
 *
 * ## 為何要守住 —— 呢個係一條**跨倉庫合約**
 *
 * `POST /api/pos/print-agent/heartbeat` 嘅回應加咗 `nextPollMs`，
 * 目的係俾 `macau-ledger-merchant`（Ledger 倉）嘅中繼 APK 讀嚟決定「下次幾時再心跳」。
 * 交接文件：`docs/integration/apk-optimization-handover-2026-09-21.md`（§A-1）。
 *
 * APK 側嘅寫法係（你嗰邊睇唔到呢個 repo，所以呢度要守住）：
 *
 * ```kotlin
 * nextPollMs = resp.optInt("nextPollMs", 0).takeIf { it in 5_000..180_000 }?.toLong()
 * ```
 *
 * ⇒ **一旦呢個欄位消失或超出 5 秒 ~ 3 分鐘嘅範圍，APK 就會靜默 fallback 返 30 秒**
 * （唔會報錯、唔會 crash，只係偷偷打返多一倍請求）—— 呢種「兩邊都話正常但其實冇生效」
 * 正係本專案最常見嘅病（見 MEMORY §4「配對失敗垃圾桶文案」同型）。
 *
 * ## 兩個方向都要守
 *
 * ① `nextPollMs` 唔可以消失；值唔可以 < 5 秒（APK 會當無效）或 > 180 秒
 *    （POS 網頁 `print-center.tsx` 寫死「≥5 分鐘 → 疑似離線」⇒ 會出假警報）。
 * ② `recordActivity: true` 唔可以剝走 —— 剝咗之後心跳就唔會蓋 `last_seen_at`，
 *    而「成功嘅 claim 本身已構成心跳」呢個前提就會斷（`claim` 亦靠同一個蓋章）。
 */
const SRC = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

describe("/api/pos/print-agent/heartbeat ── APK 心跳合約", () => {
  it("🔴 回應一定要有 `nextPollMs`（APK 靠佢決定下次心跳間隔）", () => {
    assert.ok(
      /nextPollMs:\s*SUGGESTED_HEARTBEAT_MS/.test(SRC),
      "`nextPollMs` 唔見咗 ⇒ APK 會靜默 fallback 30 秒，A-1 優化完全失效",
    );
  });

  it("🔴 `nextPollMs` 必須落喺 5 秒 ~ 180 秒（APK 嘅有效範圍）", () => {
    const m = SRC.match(/const SUGGESTED_HEARTBEAT_MS\s*=\s*([\d_]+)\s*;/);
    assert.ok(m, "搵唔到 SUGGESTED_HEARTBEAT_MS");
    const ms = Number(m[1].replace(/_/g, ""));
    assert.ok(
      ms >= 5_000,
      `建議值 ${ms}ms < 5 秒 ⇒ APK 嘅 takeIf { it in 5_000..180_000 } 會當無效`,
    );
    assert.ok(
      ms <= 180_000,
      `建議值 ${ms}ms > 3 分鐘 ⇒ 會超過 POS 網頁「5 分鐘＝疑似離線」閾值，出假警報`,
    );
  });

  it("🔴 驗證一定要帶 `recordActivity: true`（否則唔會蓋 last_seen_at）", () => {
    assert.ok(
      /verifyAgent\([^)]*recordActivity:\s*true/.test(SRC),
      "冇 recordActivity ⇒ last_seen_at 唔更新 ⇒ 中繼機會被顯示成離線",
    );
  });

  it("`ok` / `serverTime` 唔可以剝走（現役 APK 已經靠佢哋）", () => {
    assert.ok(/\bok:\s*true\b/.test(SRC), "APK 用 optBoolean(\"ok\") 判斷心跳成功");
    assert.ok(/serverTime:/.test(SRC), "serverTime 係既有欄位，唔應該靜默移除");
  });
});

/**
 * 🆕 2026-09-21：**刪咗心跳之後，節奏旋鈕搬去 `claim`**。
 *
 * 建議 APK 刪走獨立心跳迴圈（`claim` 已經順手蓋 `last_seen_at` ⇒ 心跳完全多餘），
 * 之後由 `claim` 回應嘅 `nextPollMs` 控制節奏 ⇒ 服務端可以隨時調整、唔使再出 APK。
 * 呢個守衛防「有人以為冇用而剝走佢」——剝走之後 APK 只可以寫死常數。
 */
const CLAIM_SRC = readFileSync(
  new URL("../claim/route.ts", import.meta.url),
  "utf8",
);

/**
 * 🆕 2026-09-22：claim 嘅節奏常數搬去純模組（決策可單測）。
 * 守衛要**同時掃呢個檔**，否則值域檢查會因為 route 已經冇 `const *_MS =` 而空轉綠燈。
 */
const CADENCE_SRC = readFileSync(
  new URL("../../../../../lib/pos/print-agent-cadence.ts", import.meta.url),
  "utf8",
);

describe("/api/pos/print-agent/claim ── App 節奏旋鈕", () => {
  it("🔴 回應一定要有 `nextPollMs`（刪咗心跳之後唯一嘅節奏控制）", () => {
    assert.ok(
      /nextPollMs\s*[,}]/.test(CLAIM_SRC),
      "`nextPollMs` 唔見咗 ⇒ 服務端失去節奏控制，要再出 APK 才改得到",
    );
    assert.ok(
      /const\s+nextPollMs\s*=/.test(CLAIM_SRC),
      "`nextPollMs` 必須係計出嚟嘅值（雙檔自適應），唔可以又寫死一個常數",
    );
  });

  it("🔴 全部節奏值必須落喺 5_000 ~ 180_000（APK 有效範圍／UI 假警報界線）", () => {
    // 2026-09-22：節奏常數搬去純模組 `print-agent-cadence.ts`
    // ⇒ 值域檢查要掃嗰個檔（route 已經冇 `const *_MS =`，掃 route 會變空轉綠燈）。
    const matches = [...CADENCE_SRC.matchAll(/const\s+([A-Z0-9_]*_MS)\s*=\s*([\d_]+)\s*;/g)];
    assert.ok(matches.length >= 2, "搵唔到 cadence 常數（應該有後備／活躍／上限）");
    for (const m of matches) {
      const name = m[1];
      const ms = Number(m[2].replace(/_/g, ""));
      assert.ok(
        ms >= 5_000,
        `${name} = ${ms}ms < 5 秒 ⇒ APK 嘅 takeIf { it in 5_000..180_000 } 會當無效、靜默 fallback 30 秒`,
      );
      assert.ok(
        ms <= 180_000,
        `${name} = ${ms}ms > 3 分鐘 ⇒ 會超過 POS 網頁「5 分鐘＝疑似離線」閾值，出假警報`,
      );
    }
    // 階梯（陣列）都要逐個檢查 —— 唔可以只驗單一常數
    const ladder = [...CADENCE_SRC.matchAll(/CLAIM_IDLE_LADDER_MS\s*=\s*\[([^\]]+)\]/g)];
    assert.equal(ladder.length, 1, "搵唔到空閒退避階梯");
    for (const raw of ladder[0][1].split(",")) {
      const ms = Number(raw.replace(/[^\d]/g, ""));
      if (!ms) continue;
      assert.ok(ms >= 5_000 && ms <= 180_000, `階梯值 ${ms}ms 超出 5_000..180_000`);
    }
  });

  it("🔴 三檔 ＋ 空閒退避：有 job 快、冇 job 逐級放慢（唔可以又變返單一固定值）", () => {
    assert.ok(
      /nextClaimPollMs\(\{\s*claimed: jobs\.length,\s*limit,\s*emptyStreak: streak\s*\}\)/.test(CLAIM_SRC),
      "claim 冇用 cadence 決策 ⇒ 又變返固定間隔（關店就會照樣每 30 秒打）",
    );
    assert.ok(
      /nextEmptyStreak\(emptyStreakByAgent\.get\(agentId\) \?\? 0, jobs\.length\)/.test(CLAIM_SRC),
      "冇記「連續冇 job」⇒ 退避永遠唔會啟動",
    );
  });

  it("`claim` 一定要帶 `recordActivity: true`（否則刪咗心跳就冇人蓋章）", () => {
    assert.ok(
      /verifyAgent\([^)]*recordActivity:\s*true/.test(CLAIM_SRC),
      "claim 唔蓋 `last_seen_at` ⇒ 中繼機會被顯示成離線",
    );
  });
});
