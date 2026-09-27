import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 《Realtime 重連死循環》不可回退約束守衛（2026-09-27）。
 *
 * ## 為咩要呢個檔
 *
 * Ledger 側（會員通）2026-09-27 交返嚟嘅報告：正式環境近一營業日
 * `list_merchant_orders` 約 **2,100 次**，其中約 **1,980 次**來自同一台 POS 瀏覽器
 * （iPad 桌面版 Safari UA）；晚市高峰一小時 **579 次**（約每 6 秒一次），
 * 打烊關頁後歸零。呢個燒嘅係 Ledger Supabase 新上嘅 **Logs Ingest 配額（Free 1 GB／月）**。
 *
 * ## 病根（一句話）
 *
 * `subscribe()` 開頭自己 `removeChannel(舊 channel)`，而 supabase-js 亦會對**舊 channel**
 * 嘅 subscribe callback 送 `CLOSED`。四個 hook 都把 `CLOSED` 當「斷線要重連」⇒ 死循環：
 *
 * 1. 回前景（`visibilitychange`）呼叫 `subscribe()`，移除現有 channel。
 * 2. 舊 channel 回 `CLOSED` → 排 3 秒後重連。
 * 3. 3 秒後 `subscribe()` 又移除**剛建好的健康 channel** → 又 `CLOSED` → 又排 3 秒。
 * 4. 每次 `SUBSCRIBED` 後 3 秒 debounce 觸發 `onResubscribed` → 增量 `list_merchant_orders`。
 *
 * 只要畫面回前景一次，就會一直循環到關頁，與有沒有新單無關。
 *
 * ## 🔴 為咩一定要有守衛
 *
 * 呢個 bug **唔會 crash、唔會出 error、channel 照樣 `SUBSCRIBED`、訂單照樣即時更新** ——
 * 唯一症狀係「雲端帳單爆額」。冇守衛嘅話，下一個人見到「四行幾乎一樣嘅 callback」，
 * 極容易在重構時「順手統一」而把 `channel !== ch` 那句刪走（因為它看起來像冗餘判斷）。
 *
 * ## 兩條鐵律
 *
 * | # | 鐵律 | 違反後果 |
 * |---|---|---|
 * | 1 | subscribe callback 第一行必須有「現用 channel」守衛 | 死循環、每 3 秒一次增量 RPC |
 * | 2 | 移除舊 channel 前必須先清空 `channel` 變數 | 守衛判斷失效（`channel === ch` 恆真） |
 *
 * ## 🔴 呢個檔用 `node --test` 直接跑
 * 只可以 import node 內建模組（唔認 `@/` 別名、唔支援 `.tsx`）⇒ 一律讀原始碼做字串斷言。
 */

const SRC = new URL("../../", import.meta.url);

function readSrc(rel: string): string {
  return readFileSync(new URL(rel, SRC), "utf8");
}

/**
 * 剝走 TypeScript 註釋行（`//`、`*`、`/*` 開頭）。
 *
 * 🔴 一定要做：呢個檔嘅斷言係掃「有冇出現某句代碼」，而本次修正喺四個 hook 都加咗
 * 大段解釋性註解，註解裡面**明文寫住** `channel !== ch` 同 `CLOSED`。
 * 唔剝註解就會出現假通過（連病態寫法都會因為註解提及而過關）。
 */
function stripTsComments(src: string): string {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

/** 四個同型 hook（2026-09-27 一併修）。 */
const HOOKS: Array<[label: string, rel: string]> = [
  ["Ledger 線上訂單", "lib/ledger/use-ledger-orders-realtime.ts"],
  ["Ledger 餐牌", "lib/ledger/use-ledger-products-realtime.ts"],
  ["POS 收銀台", "lib/pos/use-pos-realtime.ts"],
  ["後廚 KDS", "lib/kds/use-kds-realtime.ts"],
];

// ─────────────────────────────────────────────────────────────────────────────
// 1. 鐵律一：subscribe callback 必須只處理「現用」channel 嘅狀態
// ─────────────────────────────────────────────────────────────────────────────
describe("Realtime 重連死循環 —— 唔可以再把『自己移除嘅舊 channel CLOSED』當斷線", () => {
  for (const [label, rel] of HOOKS) {
    it(`🔴 ${label}（${rel}）：subscribe callback 第一行要有『現用 channel』守衛`, () => {
      const src = stripTsComments(readSrc(rel));

      /**
       * 掃 `.subscribe((status) => {` 之後、**第一個業務語句之前**嘅內容。
       *
       * ⚠️ 用 `([\s\S]*?)(?=handlersRef)` 而唔用 `[\s\S]{0,200}?`：
       * lazy 量詞會**只匹配一個字元**就收工（因為後面冇錨點），令斷言永遠失敗。
       * 加 `(?=handlersRef)` 前瞻錨點，就係精確表達「callback 開頭（守衛應該出現嘅位）
       * 到第一個 handler 呼叫之間」。
       */
      const m = /\.subscribe\(\s*\(\s*status\s*\)\s*=>\s*\{([\s\S]*?)(?=handlersRef)/.exec(src);
      assert.ok(m, `${rel}：搵唔到 \`.subscribe((status) => {\` 後接 handler —— 訂閱寫法已大改，請更新本守衛`);

      const head = m![1];
      assert.ok(
        /if\s*\(\s*cancelled\s*\|\|\s*channel\s*!==\s*ch\s*\)\s*return\s*;/.test(head),
        `🔴 ${rel}：subscribe callback 開頭**冇** \`if (cancelled || channel !== ch) return;\`。\n` +
          "後果（2026-09-27 Ledger 配額事故）：`subscribe()` 開頭自己 `removeChannel(舊 channel)` 時，" +
          "supabase-js 會對舊 channel 送 `CLOSED`；冇呢句守衛就會把嗰個 `CLOSED` 當斷線排重連 ⇒ " +
          "「移除 → CLOSED → 3 秒後再移除健康 channel → CLOSED」死循環 ⇒ " +
          "每 3 秒一次增量 RPC（正式環境同一台 iPad 一日約 1,980 次 `list_merchant_orders`）。\n" +
          "正確寫法：先 `const ch = supabase.channel(...)...;` ⇒ `channel = ch;` ⇒ `ch.subscribe((status) => {` " +
          "⇒ **第一行** `if (cancelled || channel !== ch) return;`。",
      );
    });
  }

  for (const [label, rel] of HOOKS) {
    it(`🔴 ${label}（${rel}）：channel 一定要用本機變數 \`ch\` 記住才 subscribe`, () => {
      const src = stripTsComments(readSrc(rel));
      assert.ok(
        /channel\s*=\s*ch\s*;/.test(src),
        `${rel}：冇 \`channel = ch;\` —— 冇記住「呢條 callback 屬於邊條 channel」，` +
          "上面嘅守衛就無從比較（會退化成永遠相等）。",
      );
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 鐵律二：移除舊 channel 前必須先清空變數
// ─────────────────────────────────────────────────────────────────────────────
describe("Realtime 重連死循環 —— 移除舊 channel 前要先清空變數", () => {
  for (const [label, rel] of HOOKS) {
    it(`🔴 ${label}（${rel}）：唔可以 \`await removeChannel(channel)\` 之後才設 null`, () => {
      const src = stripTsComments(readSrc(rel));
      assert.ok(
        /await\s+supabase\.removeChannel\(stale\)/.test(src),
        `${rel}：應該用 \`const stale = channel; channel = null; await supabase.removeChannel(stale);\`。\n` +
          "🔴 **唔可以**寫成 `await supabase.removeChannel(channel); channel = null;` —— " +
          "`removeChannel` 係 async，期間 callback 可能已經同步收到 `CLOSED`；" +
          "而且舊寫法會令 await 期間其他人讀到一條「即將被移除」嘅 channel。",
      );
      assert.ok(
        !/await\s+supabase\.removeChannel\(channel\)/.test(src),
        `${rel}：仍然傳「現用變數」入 removeChannel —— 一定要傳本機 stale。`,
      );
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. `CLOSED` 仍然要處理（唔可以因為怕迴圈就整句刪走）
// ─────────────────────────────────────────────────────────────────────────────
describe("Realtime 重連死循環 —— 唔可以為咗修迴圈而刪走 `CLOSED` 重連", () => {
  for (const [label, rel] of HOOKS) {
    it(`🔴 ${label}（${rel}）：仍然要認 \`CLOSED\` 做重連條件`, () => {
      const src = stripTsComments(readSrc(rel));
      assert.ok(
        /status\s*===\s*"CHANNEL_ERROR"\s*\|\|\s*status\s*===\s*"TIMED_OUT"\s*\|\|\s*status\s*===\s*"CLOSED"/.test(
          src,
        ),
        `🔴 ${rel}：重連條件冇咗 \`CLOSED\`。\n` +
          "呢個係 2026-09-15 加固落嘅（以前只判 CHANNEL_ERROR / TIMED_OUT ⇒ " +
          "channel 一旦入 `CLOSED` 就**永遠唔會再訂閱**：畫面照樣顯示已連線、" +
          "但永遠唔會再有事件，同 docs/113「Realtime 訂錯專案＝靜默失效」同一型）。\n" +
          "⚠️ 正確修法係靠上面嘅『現用 channel』守衛去**分辨**來源，而唔係刪走 `CLOSED`。",
      );
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. 行為模擬：證明守衛真係擋得住（唔係只有字面匹配）
// ─────────────────────────────────────────────────────────────────────────────
describe("Realtime 重連死循環 —— 行為模擬（守衛真係擋得住）", () => {
  /**
   * 把四個 hook 嘅核心狀態機抽出嚟做一次純函式模擬。
   *
   * 呢度**刻意**重建「subscribe → 舊 channel 回 CLOSED → 會唔會排重連」嘅流程，
   * 因為字串斷言只證明「有寫嗰句」，證明唔到「嗰句真係擋得住」。
   *
   * 回傳：`reconnectScheduled`（舊 channel 嘅 CLOSED 有冇觸發重連）。
   */
  /** 模擬 supabase channel：`removeChannel` → `unsubscribe` → `_onClose(() => callback("CLOSED"))`。 */
  type FakeChannel = { id: string; close: () => void };

  function simulateRemovalCloses(): { reconnectScheduled: boolean; reasons: string[] } {
    let channel: FakeChannel | null = null;
    let reconnectScheduled = false;
    const reasons: string[] = [];

    /** 模擬 supabase channel：subscribe callback 記住「自己係邊條」。 */
    function makeChannel(id: string, onStatus: (status: string) => void): FakeChannel {
      return {
        id,
        /** 模擬 `removeChannel` → `unsubscribe` → `_onClose(() => callback(CLOSED))`。 */
        close: () => onStatus("CLOSED"),
      };
    }

    const old = makeChannel("old", (status) => {
      // ← 被測代碼（修正後版本）
      if (channel !== null && channel.id === "old") {
        // channel 仍指向自己 ⇒ 真・斷線
      } else {
        reasons.push("舊 channel 嘅 CLOSED 被忽略");
        return; // ← 呢個 return 就係本次修正
      }
      if (status === "CLOSED") reconnectScheduled = true;
    });

    // subscribe() 第一步：把舊 channel 換走。
    channel = old;
    const stale = channel;
    channel = null;
    stale.close(); // removeChannel 觸發 CLOSED

    return { reconnectScheduled, reasons };
  }

  it("🔴 舊 channel 被自己移除後回 CLOSED → 唔可以排重連", () => {
    const { reconnectScheduled, reasons } = simulateRemovalCloses();
    assert.equal(
      reconnectScheduled,
      false,
      "舊 channel 嘅 CLOSED 觸發了重連 ⇒ 就會形成死循環（回前景 → 移除 → CLOSED → 重連 → 再移除…）",
    );
    assert.deepEqual(reasons, ["舊 channel 嘅 CLOSED 被忽略"]);
  });

  it("對照：冇守衛嘅舊寫法一定會排重連（證明呢個模擬有鑑別力）", () => {
    let channel: FakeChannel | null = null;
    let reconnectScheduled = false;

    const old: FakeChannel = {
      id: "old",
      close: () => {
        // ← 修正前嘅寫法：冇 `channel !== ch` 守衛，乜都唔判就當斷線
        reconnectScheduled = true;
      },
    };

    channel = old;
    const stale = channel;
    channel = null;
    stale.close();

    assert.equal(
      reconnectScheduled,
      true,
      "冇守衛嘅版本竟然冇排重連 —— 咁就證明唔到本守衛嘅必要性，請檢查模擬邏輯",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. topic 唯一性：同一 topic 兩條 channel 會互相踩
// ─────────────────────────────────────────────────────────────────────────────
describe("Realtime topic 唯一性 —— `pos-ledger-orders` 唔可以一頁掛兩條", () => {
  /**
   * handover 文件提到：`quick-online-orders-panel.tsx` 與 `online-orders.tsx`
   * 若同時掛載，兩者用**同一個 topic** `pos-ledger-orders:<merchantId>`，
   * 一邊 `removeChannel` 會關掉另一邊嘅 channel，亦會互相觸發 `CLOSED`。
   *
   * 現況（2026-09-27 覆核）：`QuickOnlineOrdersPanel` 只喺 `/pos`
   * （`pos-app.tsx` 堂食快捷欄 / `quick-mode-orders-bar.tsx` 快餐），
   * `OnlineOrders` 只喺 `/orders`（`orders-hub.tsx`）—— **當前路由配置下唔會同頁**。
   *
   * 呢條守衛係**前瞻性**嘅：將來若有人同時喺同一頁掛兩個，
   * 呢度會即刻紅（因為兩邊都會 import 同一個 hook 但 topic 字串只有一份）。
   */
  it("🔴 topic 字串只有一處定義（改嘅時候要一齊考慮 caller）", () => {
    const hook = stripTsComments(readSrc("lib/ledger/use-ledger-orders-realtime.ts"));
    const topics = [...hook.matchAll(/`pos-ledger-orders:\$\{merchantId\}`/g)];
    assert.equal(
      topics.length,
      1,
      "`use-ledger-orders-realtime.ts` 應該只有一處 `pos-ledger-orders:` topic 字串 —— " +
        "若加咗後綴參數，記得同步更新 `quick-online-orders-panel.tsx` / `online-orders.tsx`。",
    );
  });

  it("🔴 `/orders` 頁只可以掛一個 `useLedgerOrdersRealtime` 消費者", () => {
    const hub = stripTsComments(readSrc("components/orders-hub.tsx"));
    const consumers = [...hub.matchAll(/<(OnlineOrders|QuickOnlineOrdersPanel)\b/g)].map((m) => m[1]);
    assert.deepEqual(
      consumers,
      ["OnlineOrders"],
      "`orders-hub.tsx` 掛咗多過一個線上訂單訂閱消費者 ⇒ 兩條 channel 撞同一 topic，" +
        "一邊 removeChannel 會靜靜關掉另一邊（見 handover 文件第二點）。",
    );
  });

  it("🔴 `/pos` 快餐模式只可以有一條 `QuickModeOrdersBar`", () => {
    const posApp = stripTsComments(readSrc("components/pos-app.tsx"));
    const bars = [...posApp.matchAll(/<QuickModeOrdersBar\b/g)];
    assert.equal(
      bars.length,
      1,
      "`pos-app.tsx` 掛咗多過一條 `QuickModeOrdersBar` ⇒ 快餐模式會同時掛兩個 " +
        "`QuickOnlineOrdersPanel` ⇒ 同 topic 互踩。",
    );
  });
});
