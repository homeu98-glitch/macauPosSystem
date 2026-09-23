import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 《列印即時性 / 訂單存在顯示 / 流程完整性》不可回退約束守衛（2026-09-23）。
 *
 * ## 為咩要呢個檔
 *
 * 2026-09-23 覆核（`docs/reviews/recheck-2026-09-23-egress-and-relay.md`）之後，
 * 有一批「省 egress」嘅建議被**否決**，因為佢哋會靜默破壞下面三樣嘢。
 * 呢啲否決理由如果只寫喺報告／註釋，下一個人（或者下一個 agent）見到
 * 「pos_orders 匿名讀得到全部」就會當 bug 去「修」，然後**收銀台永遠收唔到新單、
 * 中繼機永遠唔知有新紙要印 —— 而且 Supabase 唔會報錯**（channel 照樣 `SUBSCRIBED`）。
 *
 * 所以把口徑釘成測試。三組約束：
 *
 * | 組 | 保護嘅嘢 | 一旦被改走嘅後果 |
 * |---|---|---|
 * | A | 中繼機 Realtime 喚醒 | 列印由「即時」退化成「等下一個 claim（最長 180 秒）」 |
 * | B | 收銀台 / 後廚 Realtime | 訂單唔自動彈出，要人手 reload 先見到 |
 * | C | 匿名 Realtime 依賴本身 | 同上，而且係**靜默**（冇 error、冇 crash） |
 *
 * ## 🔴 呢個檔用 `node --test` 直接跑
 * 只可以 import node 內建模組（唔認 `@/` 別名、唔支援 `.tsx`）⇒ 一律讀原始碼做字串斷言。
 */

const MIGRATIONS_DIR = new URL("../../../supabase/migrations/", import.meta.url);
const SRC = new URL("../../", import.meta.url);

/**
 * 剝走 SQL 行註釋。
 *
 * 🔴 一定要做：`0021` 同 `0041` 都**故意**喺註釋裡面留低「日後可以改成咩樣」
 * 嘅範例（例如 `store scoped read`、`interval '14 days'` 嘅回滾版本）。
 * 唔剝註釋就會掃到嗰啲**未生效**嘅寫法，令斷言變成假陽／假陰。
 */
function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

/** 壓平空白，方便用單行正則去掃跨行 SQL。 */
function flat(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** 讀全部 migration（按檔名排序），回傳 `[檔名, 剝註釋 + 壓平後內容]`。 */
function readMigrations(): Array<[string, string]> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => [f, flat(stripSqlComments(readFileSync(new URL(f, MIGRATIONS_DIR), "utf8")))]);
}

function readSrc(rel: string): string {
  return readFileSync(new URL(rel, SRC), "utf8");
}

/**
 * 剝走 TypeScript／TSX 註釋行（`//`、`*`、`/*` 開頭）。
 *
 * 🔴 一定要做：呢個檔有幾條斷言係掃「有冇用某個 API」。但解釋性註解成日都會
 * **提及**嗰個 API（例如 realtime-bind route 嘅註解就寫住「唔可以用 user_metadata」），
 * 唔剝註解就會出現**假失敗**（實測中過一次）。
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

/** 讀原始碼並剝註釋（掃「有冇用某 API」嘅斷言一律用呢個）。 */
function readSrcCode(rel: string): string {
  return stripTsComments(readSrc(rel));
}

/**
 * 讀單一份 migration（**剝註釋 + 壓平**）；唔存在回 `null`。
 *
 * ⚠️ 一定要剝註釋：`0051` 嘅**回滾 SQL 係刻意用註解留低**嘅（`-- drop policy ...`），
 * 唔剝就會當成生效語句，令「唔可以 drop anon」呢條斷言假失敗。
 */
function readMigrationOrNull(name: string): string | null {
  try {
    return flat(stripSqlComments(readFileSync(new URL(name, MIGRATIONS_DIR), "utf8")));
  } catch {
    return null;
  }
}

/**
 * 由全部 migration 抽出「某表 anon 可讀窗口（小時）」。
 *
 * 只認**未註釋**嘅 `create policy "<表> anon read recent" ... for select to anon
 * using (coalesce(created_at, now()) >= now() - interval 'N hours')`，
 * 並且回傳**最後一個**（檔名排序 ＝ 最新一次生效嘅定義）。
 */
function anonReadWindowHours(table: string): { hours: number; from: string } | null {
  const re = new RegExp(
    `create policy "[^"]*" on public\\.${table} for select to anon using \\(coalesce\\(created_at, now\\(\\)\\) >= now\\(\\) - interval '(\\d+) hours'\\)`,
    "g",
  );
  let found: { hours: number; from: string } | null = null;
  for (const [name, sql] of readMigrations()) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) found = { hours: Number(m[1]), from: name };
  }
  return found;
}

/** 喺全部 migration 嘅**未註釋**內容入面，有冇任何一句 drop 咗某條 policy 而冇重建。 */
function hasAnonSelectPolicy(table: string): boolean {
  return readMigrations().some(([, sql]) =>
    new RegExp(`create policy "[^"]*" on public\\.${table} for select to anon`).test(sql),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// A. 中繼機（列印即時性）
// ─────────────────────────────────────────────────────────────────────────────
describe("列印即時性 —— 中繼機 Realtime 喚醒鏈路", () => {
  const CLAIM_ROUTE = readSrc("app/api/pos/print-agent/claim/route.ts");
  const AGENT_SERVER = readSrc("lib/print-agent-server.ts");
  const CADENCE = readSrc("lib/pos/print-agent-cadence.ts");

  it("🔴 `pos_print_jobs` 一定要有 anon SELECT policy（中繼機用 anon key 訂 Realtime）", () => {
    assert.ok(
      hasAnonSelectPolicy("pos_print_jobs"),
      "`pos_print_jobs` 冇咗 `for select to anon` policy ⇒ 中繼機嘅 postgres_changes 訂閱會 " +
        "**靜默失效**：WebSocket 照樣 SUBSCRIBED，但一個事件都唔會推 ⇒ " +
        "出紙退化成等下一個 claim（最長 180 秒）。" +
        "呢個係刻意保留嘅匿名讀取，唔係漏做（見 0011 / 0016 / 0021 檔頭）。",
    );
  });

  it("🔴 `pos_print_jobs` anon 讀取窗口唔可以短過 24 小時", () => {
    const w = anonReadWindowHours("pos_print_jobs");
    assert.ok(w, "搵唔到 `pos_print_jobs anon read recent` 嘅窗口定義");
    assert.ok(
      w.hours >= 24,
      `窗口收窄到 ${w.hours} 小時（來自 ${w.from}）—— 唔可以 < 24 小時。` +
        "Realtime 對 UPDATE / DELETE 事件係用 **row 自身嘅 created_at** 去過 RLS SELECT policy，" +
        "窗口太短會令「延遲認領 / 延遲結帳」嘅舊單事件被擋 ⇒ 收據／廚房單永遠唔出。",
    );
  });

  it("🔴 中繼機 Realtime 目標唔可以 fallback 去 Ledger 專案", () => {
    const body = AGENT_SERVER.slice(AGENT_SERVER.indexOf("resolveRelayRealtimeConfig"));
    const fn = body.slice(0, body.indexOf("\n}") + 2);
    assert.ok(/process\.env\.SUPABASE_URL/.test(fn), "應該只讀 POS 專案嘅 SUPABASE_URL");
    assert.ok(
      /process\.env\.SUPABASE_ANON_KEY/.test(fn),
      "應該只讀 POS 專案嘅 SUPABASE_ANON_KEY",
    );
    assert.ok(
      !/NEXT_PUBLIC_SUPABASE_URL/.test(fn),
      "🔴 唔可以 fallback 去 `NEXT_PUBLIC_SUPABASE_URL`（＝Ledger，冇 pos_* 表）—— " +
        "會令 APK 開到 WS、顯示「已連線」，但永遠收唔到事件（2026-09-10 P0 同一型靜默失效）。",
    );
  });

  it("🔴 claim 路由：驗證失敗一律 401；RPC 失敗一律 500（唔可以混）", () => {
    assert.ok(
      /verifyAgent\([^)]*recordActivity:\s*true/.test(CLAIM_ROUTE),
      "claim 應該以 `recordActivity: true` 蓋 `last_seen_at`（claim 本身兼任心跳）",
    );
    assert.ok(
      /agent 驗證失敗[\s\S]{0,80}status:\s*401/.test(CLAIM_ROUTE),
      "agent 驗證失敗必須回 401（APK 收到 401 會清配對、返配對畫面）",
    );
    assert.ok(
      /claim 失敗[\s\S]{0,80}status:\s*500/.test(CLAIM_ROUTE),
      "🔴 RPC 失敗**唔可以**回 401 —— 一次 DB 抖動就會令收銀機要重新配對中繼機，" +
        "比「今次冇印到」嚴重得多（見 print-agent-server.ts 嘅降級說明）。",
    );
  });

  it("🔴 claim 回應一定要帶 `nextPollMs`（APK 靠它控節奏）", () => {
    assert.ok(
      /nextPollMs/.test(CLAIM_ROUTE),
      "冇 `nextPollMs` ⇒ APK 只能 fallback 自己嘅常數，伺服器就無法調節關店／夜間節奏",
    );
  });

  it("🔴 節奏上限要 ≥ 60 秒（省請求）而且 ≤ 180 秒（POS 5 分鐘離線判準）", () => {
    const nums = [...CADENCE.matchAll(/(\d{2,3})_000|(\d{2,3})000/g)].map((m) =>
      Number(m[1] ?? m[2]),
    );
    assert.ok(nums.length > 0, "讀唔到節奏常數");
    const max = Math.max(...nums);
    const min = Math.min(...nums.filter((n) => n > 0));
    assert.ok(
      max <= 180,
      `節奏上限 ${max} 秒 > 180 秒 —— POS 網頁 print-center.tsx 寫死「last_seen_at ≥5 分鐘 ⇒ 疑似離線」，` +
        "會令中繼機被誤顯示為離線。",
    );
    assert.ok(min >= 5, `節奏下限 ${min} 秒太密（< 5 秒）`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. 收銀台 / 後廚（訂單存在顯示）
// ─────────────────────────────────────────────────────────────────────────────
describe("訂單存在顯示 —— 收銀台 / 後廚 Realtime 鏈路", () => {
  const POS_REALTIME = readSrc("lib/pos/use-pos-realtime.ts");
  const KDS_REALTIME = readSrc("lib/kds/use-kds-realtime.ts");
  const STATE_ROUTE = readSrc("app/api/pos/state/route.ts");

  it("🔴 `pos_orders` 一定要有 anon SELECT policy（收銀台 / 後廚用 anon key 訂 Realtime）", () => {
    assert.ok(
      hasAnonSelectPolicy("pos_orders"),
      "`pos_orders` 冇咗 `for select to anon` policy ⇒ 掃碼落單之後" +
        "**收銀台唔會即時彈單、後廚屏唔會即時出單**，而 Supabase 唔會報錯。" +
        "（2026-09-10 P0 就係同一型靜默失效；docs/reviews/qr-self-order-audit-2026-09-10.md）",
    );
  });

  it("🔴 `pos_orders` anon 讀取窗口唔可以短過 72 小時", () => {
    const w = anonReadWindowHours("pos_orders");
    assert.ok(w, "搵唔到 `pos_orders anon read recent` 嘅窗口定義");
    assert.ok(
      w.hours >= 72,
      `窗口收窄到 ${w.hours} 小時（來自 ${w.from}）—— 唔可以 < 72 小時。` +
        "堂食長枱「開枱 → 加菜 → 結帳」跨幾小時甚至跨夜；" +
        "Realtime 嘅 UPDATE 事件用 row 自身 created_at 過 policy，窗口太短會令加菜／結帳事件被擋。",
    );
  });

  it("🔴 收銀台 Realtime 一定要訂 `pos_orders`", () => {
    assert.ok(
      /table:\s*"pos_orders"/.test(POS_REALTIME),
      "收銀台 realtime 冇訂 pos_orders ⇒ 線上單／掃碼單唔會自動彈出",
    );
  });

  it("🔴 後廚 Realtime 一定要訂 `pos_orders`", () => {
    assert.ok(
      /table:\s*"pos_orders"/.test(KDS_REALTIME),
      "後廚屏 realtime 冇訂 pos_orders ⇒ 新單唔會出現喺出餐屏",
    );
  });

  it("🔴 `/api/pos/state`：partial payload 一定要帶 `incremental: true`", () => {
    assert.ok(
      /\.\.\.\(incremental \? \{ incremental: true \} : \{\}\)/.test(STATE_ROUTE),
      "增量回應冇帶 `incremental` 旗標 ⇒ 新 bundle 會以為「雲端真係冇呢啲單」而跑孤兒單對賬，" +
        "把全店未變更過嘅未結帳單一次過隔離（收銀枱面清空）。",
    );
  });

  it("🔴 `/api/pos/state`：非增量回應唔可以省略 config 區塊", () => {
    const responseStart = STATE_ROUTE.indexOf('"pos/state",');
    const responseEnd = STATE_ROUTE.indexOf("mode: \"full\"");
    assert.ok(responseStart > 0 && responseEnd > responseStart, "讀唔到 state 回應物件");
    const body = STATE_ROUTE.slice(responseStart, responseEnd);
    for (const field of [
      "orders:",
      "queue:",
      "printJobs:",
      "deviceConfig:",
      "localSettings:",
      "printTemplatesServer:",
      "notePresetsServer:",
    ]) {
      assert.ok(
        body.includes(field),
        `回應物件缺少 \`${field}\` —— 🔴 唔可以為省 egress 而改成「條件式省略 config」。` +
          "2026-09-22 P0b 嘅教訓就係：伺服器**唔可以**用「partial payload ＋ 一個新欄位」去保護舊 client，舊 client 唔會睇嗰個新欄位。",
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. 匿名 Realtime 依賴本身（呢條約束一旦消失，A 同 B 都失效）
// ─────────────────────────────────────────────────────────────────────────────
describe("匿名 Realtime 依賴 —— 唔可以單靠改 SQL 收口", () => {
  it("🔴 瀏覽器 POS client 仍然用 anon key（若日後改用 JWT，要一齊更新呢個守衛）", () => {
    const CLIENT = readSrc("lib/pos/supabase-client.ts");
    assert.ok(
      /createClient\(config\.url, config\.anonKey/.test(CLIENT),
      "POS 瀏覽器 client 唔再用 anon key —— 如果係刻意改成 per-store token，" +
        "請一併更新 0041 §3 嘅說明同呢個守衛；唔係嘅話就係連錯憑證，Realtime 會靜默失效。",
    );
  });

  it("🔴 全庫搜尋：唔可以有任何「drop 咗 anon policy 而冇重建」嘅新 migration", () => {
    for (const table of ["pos_orders", "pos_print_jobs"]) {
      const latestDrop = readMigrations()
        .filter(([, sql]) => new RegExp(`drop policy if exists "[^"]*" on public\\.${table}`).test(sql))
        .map(([name]) => name);
      assert.ok(latestDrop.length > 0, `${table} 應該至少有一份 migration 管理佢嘅 policy`);
      assert.ok(
        hasAnonSelectPolicy(table),
        `${table} 嘅 anon SELECT policy 唔見咗 —— 見上面兩組測試嘅後果。` +
          "要做按店隔離，必須連 per-store token（JWT 內帶 store_id claim）一齊做，" +
          "唔可以淨改 SQL（0041 檔頭 §3 已記錄呢個決定）。",
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. per-store token 第 1 階段（0051）—— 加性政策
//
// 呢一組守衛嘅目的：0051 係「**加** store-scoped `authenticated` 政策，
// 但**唔可以**動任何 anon 政策」嘅加性 migration。
// 一旦有人後來「順手」喺 0051 加咗一句 drop anon，就會靜默搞死列印同訂單彈窗，
// 而且係要等到第 4 階段（真嘅 cutover）之後才會爆 —— 最難追嘅一種。
// ─────────────────────────────────────────────────────────────────────────────
describe("per-store token 第 1 階段（0051 / 0052）—— 加性政策", () => {
  /** 0052 受管嘅 5 張表（`pos_soldout` 刻意排除 —— 匿名客人端讀）。 */
  const SCOPED = [
    "pos_orders",
    "pos_print_jobs",
    "pos_kds_item_state",
    "pos_store_status",
    "pos_online_order_settings",
  ];

  /**
   * 共用斷言：一個「加性、store-scoped、保留 anon」嘅 migration 必須滿足嘅條件。
   *
   * ⚠️ `using (` 壓平之後後面仲有個空格 ⇒ 一定要 `\s*`，否則會假失敗。
   */
  function assertAdditive(
    file: string,
    label: string,
    storeFilter: RegExp,
    /** 政策 body 額外必須出現嘅字串（0052 要 app_metadata） */
    extraBody?: string,
  ): void {
    const MIG = readMigrationOrNull(file);
    assert.ok(MIG !== null, `搵唔到 ${file} —— ${label} 嘅加性政策唔見咗`);

    // (1) 唔可以 drop 任何 anon 政策（加性推進嘅唯一前提）
    const dropped = [...MIG!.matchAll(/drop policy if exists "([^"]*)"/gi)].map((m) => m[1]);
    const anonDrops = dropped.filter((n) => /anon/i.test(n));
    assert.deepEqual(
      anonDrops,
      [],
      `${file} 唔可以 drop anon 政策（被 drop 嘅：${anonDrops.join(", ")}）。` +
        "第 1 階段係純加性；收口係第 4 階段嘅事，而且必須等第 2／3 階段驗收通過。",
    );

    // (2) 5 張表每張都要有一條帶 store 過濾嘅 authenticated 政策
    for (const t of SCOPED) {
      const head = new RegExp(
        String.raw`create policy "${t} store scoped read" on public\.${t}\s+for select to authenticated using \(`,
      );
      assert.ok(
        head.test(MIG!),
        `${t} 缺少 store-scoped authenticated 政策（${file}）—— ` +
          "冇 store 過濾嘅話，呢條政策等同 `using (true)`，即係換咗個 role 名但零隔離。",
      );
      assert.ok(storeFilter.test(MIG!), `${t} 嘅 store 過濾寫法唔符預期（${file}）`);
    }
    assert.equal(
      [...MIG!.matchAll(/create policy "\w+ store scoped read" on public\.\w+/g)].length,
      SCOPED.length,
      `${file} 嘅 store-scoped 政策數目應該係 ${SCOPED.length} —— 多咗可能係抄錯表，少咗即有表漏做。`,
    );

    // (3) 額外 body 要求（0052：一定要認 app_metadata 位置）
    if (extraBody) {
      assert.equal(
        [...MIG!.matchAll(new RegExp(extraBody, "g"))].length,
        SCOPED.length,
        `${file} 每條政策都應該包含 ${extraBody}（共 ${SCOPED.length} 次）`,
      );
    }

    // (4) pos_soldout 唔可以出現（註釋已剝走 ⇒ 連註解提及都唔會誤報）
    assert.ok(
      !/pos_soldout/.test(MIG!),
      `${file} 出現咗 pos_soldout —— 該表由匿名客人端（掃碼 / kiosk）` +
        "經 `use-kiosk-order.ts` → `soldout.ts` 直接用 anon client 讀，永遠拿唔到 store token。",
    );
  }

  it("0051 存在（頂層 store_id claim 版）", () => {
    assert.ok(readMigrationOrNull("0051_pos_store_scoped_authenticated_read.sql") !== null);
  });

  it("0052 存在（雙位置 claim 版：app_metadata 或頂層 store_id）", () => {
    assert.ok(
      readMigrationOrNull("0052_pos_store_scoped_dual_claim.sql") !== null,
      "0052 唔見咗 —— Supabase 已輪換到非對稱簽名金鑰（私鑰取唔出），" +
        "所以政策必須同時認 `app_metadata.store_id`（Supabase Auth 簽發路徑）" +
        "同頂層 `store_id`（自簽路徑），否則將來兩條路都行唔通。",
    );
  });

  describe("0051 —— 加性檢查", () => {
    it("保留 anon、5 張表 store-scoped、排 pos_soldout", () => {
      assertAdditive(
        "0051_pos_store_scoped_authenticated_read.sql",
        "0051",
        /for select to authenticated using \(\s*store_id = \(auth\.jwt\(\) ->> 'store_id'\)/,
      );
    });
  });

  describe("0052 —— 加性檢查", () => {
    it("保留 anon、5 張表 store-scoped、並且認 app_metadata、排 pos_soldout", () => {
      assertAdditive(
        "0052_pos_store_scoped_dual_claim.sql",
        "0052",
        /for select to authenticated using \(\s*store_id = coalesce\( auth\.jwt\(\) -> 'app_metadata' ->> 'store_id', auth\.jwt\(\) ->> 'store_id' \)/,
        String.raw`auth\.jwt\(\) -> 'app_metadata' ->> 'store_id'`,
      );
    });
  });

  it("🔴 兩份加性 migration 嘅時間窗都唔可以比 anon 更短（72h / 24h）", () => {
    for (const file of [
      "0051_pos_store_scoped_authenticated_read.sql",
      "0052_pos_store_scoped_dual_claim.sql",
    ]) {
      const MIG = readMigrationOrNull(file);
      if (MIG === null) continue;
      const orders = /pos_orders store scoped read[\s\S]*?interval '(\d+) hours'/.exec(MIG);
      const jobs = /pos_print_jobs store scoped read[\s\S]*?interval '(\d+) hours'/.exec(MIG);
      assert.ok(orders, `${file}：pos_orders 政策冇時間窗`);
      assert.ok(jobs, `${file}：pos_print_jobs 政策冇時間窗`);
      assert.ok(
        Number(orders![1]) >= 72,
        `${file}：pos_orders 窗口收窄到 ${orders![1]} 小時（唔可以 < 72）—— ` +
          "Realtime UPDATE／DELETE 事件用 row 自身 created_at 過 policy。",
      );
      assert.ok(
        Number(jobs![1]) >= 24,
        `${file}：pos_print_jobs 窗口收窄到 ${jobs![1]} 小時（唔可以 < 24）`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. per-store token 第 2 階段（2026-09-23）—— 接線守衛
//
// 呢一組守衛嘅目的：第 2 階段嘅每一個接線位都係「錯咗唔會 crash，但會靜默收唔到
// Realtime 事件」型（列印失去即時喚醒、訂單唔再自動彈出、零 error）。
// 所以就算日後有人重構，呢幾條口徑都唔可以走樣。
// ─────────────────────────────────────────────────────────────────────────────
describe("per-store token 第 2 階段 —— 接線守衛", () => {
  it("🔴 0053 存在：為 pos_soldout 加 authenticated 讀取，並且保留 anon", () => {
    const MIG = readMigrationOrNull("0053_pos_soldout_authenticated_read.sql");
    assert.ok(
      MIG !== null,
      "0053 唔見咗 —— 冇咗佢，POS client 一旦升級做 authenticated，" +
        "`pos_soldout` 就會**靜默讀唔到**（0016 曾經 revoke 走 authenticated 嘅 select），" +
        "即售罄標記失效 + soldout channel 收唔到事件。",
    );
    assert.ok(
      /create policy "pos_soldout authenticated read" on public\.pos_soldout for select to authenticated using \(true\)/.test(
        MIG!,
      ),
      "pos_soldout 嘅 authenticated 政策唔見咗或者唔再係 `using (true)`" +
        "（客人端係匿名，唔可以改成按 store 過濾）",
    );
    assert.ok(
      /grant select on table public\.pos_soldout to authenticated/.test(MIG!),
      "缺 grant select to authenticated",
    );
    // 唔可以有寫入權限
    assert.ok(
      !/grant\s+(all|insert|update|delete|truncate)[^;]*to\s+authenticated/i.test(MIG!),
      "🔴 0053 唔可以畀 authenticated 任何寫入權限（只准 SELECT）",
    );
    // 唔可以 drop anon 政策
    const dropped = [...MIG!.matchAll(/drop policy if exists "([^"]*)"/gi)].map((m) => m[1]);
    assert.deepEqual(
      dropped.filter((n) => /anon/i.test(n)),
      [],
      "0053 唔可以 drop anon 政策（加性推進）",
    );
  });

  it("🔴 `/api/pos/realtime-bind`：身份一定要由終端憑證嚟，唔可以由 body 自報 store", () => {
    const ROUTE = readSrcCode("app/api/pos/realtime-bind/route.ts");
    assert.ok(
      /readPosDeviceTokenFromRequest/.test(ROUTE),
      "必須用 POS 終端憑證做身份來源（唯一權威知道呢部機係邊間店）",
    );
    assert.ok(
      /is_anonymous\s*!==\s*true/.test(ROUTE),
      "🔴 一定要拒絕對「非匿名帳號」綁店 —— 否則擁有任何 auth 帳號就等於可以自選一間店去讀",
    );
    assert.ok(
      /app_metadata/.test(ROUTE),
      "🔴 綁定一定要寫 `app_metadata`（只有 service_role 寫得入）",
    );
    assert.ok(
      !/user_metadata/.test(ROUTE),
      "🔴 唔可以用 `user_metadata` —— 用戶自己改得到，等於冇綁（RLS 形同虛設）",
    );
    assert.ok(
      /supabase\.auth\.getUser\(/.test(ROUTE),
      "access token 一定要交畀 Supabase Auth 驗簽名（唔可以自己解 JWT 就當驗過）",
    );
  });

  it("🔴 四個 realtime hook 都必須**喺建立 channel 之前** await Realtime 憑證", () => {
    const hooks = [
      "lib/pos/use-pos-realtime.ts",
      "lib/kds/use-kds-realtime.ts",
      "lib/pos/use-store-status.ts",
      "lib/pos/use-merchant-order-config.ts",
    ];
    for (const h of hooks) {
      const src = readSrcCode(h);
      const authIdx = src.indexOf("ensureRealtimeAuth(");
      const channelIdx = src.indexOf(".channel(");
      assert.ok(authIdx >= 0, `${h} 冇用 ensureRealtimeAuth —— Realtime 會永遠停留喺 anon 身份`);
      assert.ok(channelIdx >= 0, `${h} 搵唔到 .channel(`);
      assert.ok(
        authIdx < channelIdx,
        `🔴 ${h}：\`ensureRealtimeAuth\` 出現喺 \`.channel(\` 之後 —— ` +
          "Realtime 身份係**每條連線**，遲咗設定就等於全部 channel 都用錯身份；" +
          "Supabase 官方要求 `setAuth` 一定要喺建立 channel 之前。",
      );
    }
  });

  it("🔴 收銀台 / 後廚 realtime 必須喺 token 續期時重新 subscribe", () => {
    for (const h of ["lib/pos/use-pos-realtime.ts", "lib/kds/use-kds-realtime.ts"]) {
      const src = readSrcCode(h);
      assert.ok(
        /onRealtimeAuthChanged\(/.test(src),
        `🔴 ${h} 冇掛 onRealtimeAuthChanged —— JWT 過期後連線仍然用舊 token，` +
          "RLS 會全拒而**零 error**（靜默失效）。",
      );
      assert.ok(
        /offAuthChanged\(\)/.test(src),
        `${h} 冇喺 cleanup 解除 onRealtimeAuthChanged 訂閱（會洩漏 listener）`,
      );
    }
  });

  it("🔴 POS 瀏覽器 client 一定要 persistSession + autoRefreshToken", () => {
    const CLIENT = readSrcCode("lib/pos/supabase-client.ts");
    assert.ok(
      /persistSession:\s*true/.test(CLIENT),
      "🔴 `persistSession` 一定要 true —— 否則每次重新載入都建立**一個新匿名用戶**" +
        "（用戶表爆炸 + 每次都要重新綁店）",
    );
    assert.ok(
      /autoRefreshToken:\s*true/.test(CLIENT),
      "🔴 `autoRefreshToken` 一定要 true —— 否則 token 1 小時後過期冇人續，" +
        "Realtime RLS 全拒而零 error",
    );
  });

  it("🔴 客戶端綁店流程一定要 refreshSession 之後才交 token 出去", () => {
    const SRC = readSrcCode("lib/pos/realtime-auth.ts");
    assert.ok(
      /refreshSession\(\)/.test(SRC),
      "🔴 綁完一定要 refreshSession —— JWT 係簽發時快照，改 app_metadata 唔會令舊 token 帶 store_id",
    );
    assert.ok(
      /isUsableBoundToken\(/.test(SRC),
      "🔴 交出去之前一定要用 isUsableBoundToken 驗一次（冇 store claim 就唔可以 setAuth）",
    );
    assert.ok(
      /realtime\.setAuth\(/.test(SRC),
      "冇呼叫 realtime.setAuth —— 攞到 token 但冇用，等於冇升級",
    );
    assert.ok(
      /catch\s*\(/.test(SRC),
      "執行層一定要吞錯（任何一步失敗都要保持 anon，唔可以令訂閱鏈斷）",
    );
  });
});
