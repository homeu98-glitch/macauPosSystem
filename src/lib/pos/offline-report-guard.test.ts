import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * Ledger「線下營業摘要」route 接線守衛（2026-09-25）。
 *
 * ## 要守嘅五條（做錯一條嘅後果都係「靜默出錯數」或者「開咗道門」）
 *
 * 1. **secret 分家**：只認 `LEDGER_OFFLINE_REPORT_HMAC_SECRET`，**唔可以** fallback 落
 *    `LEDGER_WEBHOOK_SECRET`（方向相反、用途唔同；共用一把 ⇒ 一邊爆兩邊爆）。
 * 2. **fail-closed**：secret 未設 ⇒ 500（唔可以放行、唔可以靜默回空數）。
 * 3. **唔可以渲染假零**：RPC 未部署／驗證失敗 ⇒ 5xx；任何情況下唔可以回 200 嘅空 KPI。
 * 4. **DB 聚合口徑**（0058）：四條時間腿、排除線上投影、狀態收窄、Asia/Macau、
 *    金額 ×100 轉 avos、90 日 clamp、只 grant service_role。
 * 5. **鑑權例外要寫明**：呢條係全專案唯一「唔行 `posRouteAuthGuard()`」嘅業務 GET
 *    （呼叫方係 Ledger 伺服器），一定要有註釋講清楚，否則下一輪匿名端點審計會誤判成漏網。
 * 6. **2026-09-26 增補（`orders[]` + `dishes[]`）**：
 *    · `v` **唔可以升**（Ledger 可能 assert `v === 1`）⇒ 能力探測走 caps 標頭；
 *    · 截斷權威喺 SQL ⇒ route 只可以依 `ordersTotal` 推導 `ordersTruncated`，唔可以自己截；
 *    · **唔可以回自由文字**（`order_note` / item `note` / `discount_note` / `comp_note`）——
 *      呢啲係店員手打，可能藏顧客識別資訊；
 *    · `orders[]` 要包未結帳單（只剔除 `cancelled`），`dishes[]` 只計 `settled`／`paid`。
 * 7. **🔴🔴🔴 2026-10-07 渠道增補（`0066`）—— 最重要嗰組**：
 *    · **J 拍板「JSON 數據架構唔可以改」** ⇒ 舊欄位名／型別／**數值**全部唔准郁；
 *      ⚠️ 呢條要守**三樣**（名／型別／數值），唔係一樣。2026-10-07 事故就係守咗
 *      前兩樣、漏咗數值 ⇒ `dishes[].qty` 由 42 變 54、`orders[]` 由 75 變 93 張，
 *      而舊 code 收到新 payload **唔會 503**（照送 200）⇒ Ledger 張卡即刻跳數；
 *    · **J 拍板方案 A**：舊欄**還原**（`orders[]`／`dishes[]` 維持 0060 口徑），
 *      線上數據全部搬去新 key `ordersByChannel[]`／`dishesByChannel[]`；
 *    · v1 `kpi` 嘅口徑包埋咗外賣平台單（佢冇 `online_order_id`）⇒ **絕對唔可以
 *      「順手修正」成純線下**，改咗 Ledger 嗰張已對數嘅卡即刻跳數；
 *    · `channel` 判定必須三路（`source ∈ aomi,mfood` ＋ `online_order_id is not null` ＋ else），
 *      淨靠其中一個都會錯標；
 *    · `diffAvos` **可以為負**（平台抽成），唔可以夾非負。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 2026-10-07 第二次修正：一條「守數值」嘅守衛要點樣先寫得出來
 * ═══════════════════════════════════════════════════════════════════════════
 *   原版守衛**淨係斷字串**（「檔案入面有 `online_order_id is null`」）。
 *   反證（改壞 → 睇守衛會唔會紅）揭發：改壞嘅方向**永遠係「少咗個過濾」或
 *   「多咗個 aggregate」** —— 兩樣都唔會令任何舊字串消失 ⇒ 呢類守衛對呢宗事故
 *   **完全空轉**（實測 10 種改壞，字串守衛 0 個捉到）。
 *
 *   ⇒ 而家改成**同 0060 逐段比對 SQL**（`normalizeLegacySegment()`）。
 *      正常 ⇒ 兩段 SQL 逐字相同 ⇒ 同一份 `pos_orders` 必然算出同一組數字。
 *      唔正常 ⇒ 直接報第一處差異嘅上下文。
 *   ⚠️ 呢個做法嘅兩處陷阱（都係實測撞到）：
 *      ① 段嘅訖點一定要包到內層子查詢嘅 `limit`（`order by a.revenue_avos desc`
 *         寫喺 `into` **之後**）—— 停得太早就漏咗「改排序」；
 *      ② 淨化走 channel 欄會留低懸空逗號 ⇒ 唔清理就「正確 code 都報紅」。
 *
 * ⚠️ `node --test` 只可以 import node 內建模組 ⇒ 用**源碼掃描**（專案慣例）。
 * 🔴 needle 一律字串拼接砌，唔好寫成完整字面量（否則掃到註釋／自己）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴🔴 2026-10-07 修正咗一個**致命盲點**：`MIGRATION`／`MIGRATION_DETAIL` 原本寫死讀
 *    0058／0059 兩個**歷史檔**。權威移到 0066 之後，「排除線上投影單」「包未結帳單」
 *    「items 白名單」呢啲鐵律會**守住一份歷史檔，而唔係守住現行權威**
 *    ⇒ 0066 寫錯全部測照綠。
 *    ⇒ 而家權威指向 `MIGRATION_CHANNEL`（0066），而 0058／0059 降為「簽名／權限／紅線」
 *    嘅**沿革**檢查（呢啲係同簽名同一支函數嘅共同約束，仍然要守）。
 * ═══════════════════════════════════════════════════════════════════════════
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, "..", "..");
const REPO_ROOT = path.resolve(SRC_ROOT, "..");

function readSrc(rel: string): string {
  return readFileSync(path.join(SRC_ROOT, rel), "utf8");
}

function readRepo(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

/** 去 JS 註解（否則解釋性註釋會令斷言誤中）。 */
function stripJs(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/** 去 SQL `--` 註解（本檔 migration 檔頭有大段口徑說明，唔去會令斷言誤中）。 */
function stripSql(src: string): string {
  return src
    .split(/\r?\n/)
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

/**
 * 只取 plpgsql **body** 並去註解。
 *
 * 🔴 點解要：migration 尾部有 `comment on function … is '…'` 嘅**字串**，
 *    佢會提到同樣嘅關鍵字（`cancelled`、`settled`…）。用整份檔做斷言會誤中，
 *    令「口徑守衛」變成綠燈但空。所有口徑斷言一律落喺 body 上。
 */
function sqlBody(src: string): string {
  const start = src.indexOf("as $$");
  const end = src.lastIndexOf("$$;");
  if (start < 0 || end <= start) return "";
  return stripSql(src.slice(start + "as $$".length, end));
}

/**
 * `expr` 嘅第一個 `(` 嘅配對 `)` 索引；搵唔到回 -1。
 *
 * 🔴 用嚟判斷「整個表達式係咪被單一函數完全包住」——
 *    `greatest(0, A - B)` 嘅配對 `)` 落喺**最後一個字元**；
 *    `greatest(0, A)::bigint - coalesce(B)` 嘅配對 `)` 落喺中間。
 */
function firstCallCloseIndex(expr: string): number {
  const open = expr.indexOf("(");
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < expr.length; i += 1) {
    if (expr[i] === "(") depth += 1;
    else if (expr[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `jsonb_build_object` 入面 `'key', <同一行嘅值>`（0066 嘅值全部寫喺同一行）。 */
function jsonbObjectValueSameLine(body: string, key: string): string | null {
  const at = body.indexOf(`'${key}'`);
  if (at < 0) return null;
  const after = body.slice(at + key.length + 2).replace(/^[\s,]*/, "");
  return after.split("\n")[0].trim() || null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 「舊欄數值唔准變」嘅**唯一可靠做法**：同 0060 逐段比對
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 為咩唔可以用「斷吓啲字串」：
 *   2026-10-07 事故 —— 守衛只斷「欄位名／型別」⇒ 全綠，但 `dishes[].qty` 由 42 變 54。
 *   任何「assert 檔案入面有呢個字串」嘅做法都**守唔到數值**：
 *   改壞嘅方向永遠係「少咗個過濾」或「多咗個 aggregate」，兩樣都唔會令任何
 *   舊字串消失 ⇒ 斷字串嘅守衛對呢類事故**完全空轉**（實測：10 種改壞，字串守衛 0 個捉到）。
 *
 * 做法：抽出 `orders[]`／`dishes[]` 兩段嘅 SQL，正規化之後**同 0060 原文比對**。
 *   正常 ⇒ 兩段 SQL 逐字相同 ⇒ 舊欄嘅輸出必然逐位相同（同一段 SQL ＋ 同一份資料）。
 *   唔正常 ⇒ 即刻指出「邊一段、點樣唔同」。
 *
 * ⚠️ 淨化（`scrubLegacySegment`）只做**三樣**嘢，缺一不可：
 *   ① 剝走 `case … end as channel,`（0066 加嘅 channel 派生欄）
 *   ② 剝走 `'channel', p.channel`（0066 加嘅輸出欄）
 *   ③ **清理因此產生嘅懸空逗號** —— ①② 做完會留下 `…, left(...) ,)`，
 *      而 0060 冇呢個逗號 ⇒ 唔清理就會「正確 code 都報紅」，守衛變假陽性。
 *   ⚠️ ①② 嘅 regex 一定要**兩種都寫**（`, 'channel', p.channel` 同 `'channel', p.channel`），
 *      只寫一種會漏。
 */

/** 抽出 `body` 入面由 `startRe` 到 `endRe`（`endRe` 必須喺 `into` **之後**）嘅段。 */
function sqlSegment(body: string, startRe: RegExp, endRe: RegExp): string {
  const start = body.search(startRe);
  const end = body.search(endRe);
  if (start < 0) return "";
  if (end <= start) return "";
  return body.slice(start, end);
}

/**
 * 段正規化（**兩邊都要套同一個**，否則比對無意義）。
 *
 * ⚠️ `endRe` 一定要包到內層子查詢嘅 `limit`（`limit k_max_orders` / `limit k_max_dishes`），
 *    唔可以停喺 `into v_orders_total` —— 因為內層 `order by a.revenue_avos desc`
 *    寫喺 `into` **之後**，停得太早就會漏咗「改排序」呢類違規。
 */
function normalizeLegacySegment(seg: string): string {
  return seg
    .replace(/\s+/g, " ")
    .replace(/case\s+when o\.source[\s\S]*?end as channel,\s*/g, "")
    .replace(/\s*'channel',\s*p\.channel/g, "")
    .replace(/,\s*'channel',\s*p\.channel/g, "")
    // 🔴 ①② 產生嘅懸空逗號（`left(...) ,)` → `left(...)`）。
    // ⚠️ **淨係刪逗號本身**（`,\s*\)` 會把 `,)` 同 `, )` 都變成 `)`，
    //    令原本 0060 就帶空格嘅 `... k_max_status_len) )` 對唔上）。
    .replace(/,(\s*\))/g, "$1")
    .trim();
}

/** `orders[]` 段嘅定位錨點（起：base CTE 第一個 select 欄；訖：內層子查詢嘅 limit）。 */
const LEGACY_ORDERS_SEG = [
  /left\(o\.local_order_no/,
  /limit k_max_orders/,
] as const;
/** `dishes[]` 段嘅定位錨點。 */
const LEGACY_DISHES_SEG = [
  /coalesce\(nullif\(btrim\(e\.it ->> 'menuItemId'\)/,
  /limit k_max_dishes/,
] as const;

const ROUTE = "app/api/integration/ledger/offline-report/route.ts";
const LIB = "lib/pos/offline-report.ts";
const MIGRATION = "supabase/migrations/0058_pos_offline_report_rpc.sql";
const MIGRATION_DETAIL = "supabase/migrations/0059_pos_offline_report_detail.sql";
/** 🔴 2026-10-07：現行權威。口徑守衛一定要讀呢個，唔係 0058／0059。 */
const MIGRATION_CHANNEL = "supabase/migrations/0066_pos_offline_report_channel.sql";
/**
 * 🔴🔴 舊欄位嘅**基準值**（0060，已上線）。
 *
 * 為咩要讀歷史檔：J 拍板「舊欄一個數字都唔可以變」⇒ 唯一能證明「冇變」嘅方法
 * 就係同**當時嗰版**逐段比對。呢個檔就係當時嗰版。
 * ⚠️ 唔可以因為「0066 係現行權威」就唔讀 0060 —— 咁就冇咗基準可比。
 */
const MIGRATION_V1_BASELINE = "supabase/migrations/0060_pos_offline_report_dishes_by_revenue.sql";
/** 支付方式標籤唯一真源（0066 嘅 SQL 翻譯層要同佢對齊）。 */
const PAYMENT_LABEL = "lib/pos/payment-method-label.ts";
const ENV_EXAMPLE = ".env.example";

const ENV_SECRET = `${"LEDGER_OFFLINE"}_REPORT_HMAC_SECRET`;
const WEBHOOK_SECRET = `${"LEDGER_WEBHOOK"}_SECRET`;
const FUNC = `${"pos_offline"}_report`;

const route = readSrc(ROUTE);
const routeCode = stripJs(route);
const migration = readRepo(MIGRATION);
const migrationCode = stripSql(migration);
const detailSql = readRepo(MIGRATION_DETAIL);
const detailBody = sqlBody(detailSql);
const channelSql = readRepo(MIGRATION_CHANNEL);
const channelBody = sqlBody(channelSql);
const baselineSql = readRepo(MIGRATION_V1_BASELINE);
const baselineBody = sqlBody(baselineSql);

describe("route：secret 分家 + fail-closed（鐵律 1、2）", () => {
  it("🔴 只讀 `LEDGER_OFFLINE_REPORT_HMAC_SECRET`", () => {
    assert.ok(route.includes(ENV_SECRET), `route 冇讀 ${ENV_SECRET}`);
  });

  it("🔴 唔可以 fallback 落 webhook secret（共用 = 一邊爆兩邊爆）", () => {
    assert.ok(!routeCode.includes(WEBHOOK_SECRET), "route 出現 LEDGER_WEBHOOK_SECRET —— 違反 secret 分家");
    assert.ok(!routeCode.includes("POS_SCAN_DEBIT_SECRET"), "route 唔應該掂 scan-debit secret");
  });

  it("secret 未設 ⇒ 500 fail-closed（唔可以回 401 矇混／唔可以放行）", () => {
    assert.ok(/fail\(["']server_misconfigured["'],\s*500\)/.test(routeCode), "缺 secret 未回 500");
    assert.ok(!/if\s*\(!secret\)[\s\S]{0,200}?return\s+(NextResponse\.json|fail)\([^)]*,\s*200\)/.test(routeCode));
  });
});

describe("route：錯誤碼對齊契約（§驗證順序）", () => {
  it("401 unauthorized／400 bad_*／429／404 store_not_found", () => {
    assert.ok(/fail\(["']unauthorized["'],\s*401\)/.test(routeCode), "缺 401");
    assert.ok(/fail\(["']bad_store_id["'],\s*400\)/.test(routeCode), "缺 storeId 400");
    assert.ok(/fail\(["']bad_range["'],\s*400\)/.test(routeCode), "缺區間 400");
    assert.ok(/fail\(["']too_many_requests["'],\s*429\)/.test(routeCode), "缺 429");
    assert.ok(/fail\(["']store_not_found["'],\s*404\)/.test(routeCode), "缺 404");
  });

  it("🔴 限流要放喺打 DB 之前（否則限流形同虛設）", () => {
    assert.ok(routeCode.indexOf("checkRateLimit(storeId)") < routeCode.indexOf(`rpc("${FUNC}"`), "限流排喺 RPC 之後");
  });
});

describe("route：唔可以渲染假零（鐵律 3）", () => {
  it("🔴 RPC 出錯 ⇒ 503，並且分得出「未跑 migration」", () => {
    assert.ok(/rpc_not_deployed/.test(routeCode), "冇區分未部署（42883/PGRST202）");
    assert.ok(routeCode.includes("42883") && routeCode.includes("PGRST202"), "冇認 PostgREST 未部署錯誤碼");
    assert.ok(/fail\(notDeployed\s*\?\s*["']rpc_not_deployed["']\s*:\s*["']upstream_unavailable["'],\s*503\)/.test(routeCode));
  });

  it("🔴 RPC 回值一定要過 `validateOfflineReportRpc` 才回 200", () => {
    assert.ok(routeCode.includes("validateOfflineReportRpc(data,"), "冇驗 RPC 回值");
    assert.ok(/if\s*\(!validated\.ok\)[\s\S]{0,160}?fail\(["']upstream_unavailable["'],\s*503\)/.test(routeCode));
  });

  it("🔴 全檔冇任何硬編 0 嘅 KPI 回退（假零禁令）", () => {
    for (const needle of ["revenueAvos: 0", "orderCount: 0", "kpi: {", "kpi:{ "]) {
      assert.ok(!routeCode.includes(needle), `route 出現疑似假零回退：${needle}`);
    }
  });

  it("寫入／讀取一律 service_role（唔可以 fallback anon）", () => {
    assert.ok(routeCode.includes("getSupabaseWriteClient()"), "應該用 getSupabaseWriteClient()");
    assert.ok(!routeCode.includes("getSupabaseServerClient()"), "唔可以用會 fallback anon 嘅 client");
  });

  it("回應唔可以俾 CDN／中間層快取", () => {
    assert.ok(routeCode.includes('"cache-control": "no-store"'));
    assert.ok(routeCode.includes('dynamic = "force-dynamic"'));
  });
});

describe("route：驗簽用原字串 + 範圍由 route 自己算（契約 §驗證順序 1、4）", () => {
  it("🔴 `pathWithQuery` = `url.pathname + url.search`（唔可以重排 query／唔可以 decode 再 encode）", () => {
    assert.ok(routeCode.includes("${url.pathname}${url.search}"), "冇用原始 pathname+search 砌簽名字串");
    assert.ok(!routeCode.includes("encodeURIComponent(pathWithQuery"), "唔可以自己重編 query");
  });

  it("範圍截斷要用共用純函數（同測試同一套邏輯）", () => {
    assert.ok(routeCode.includes("clampOfflineReportRange(fromParam, toParam)"));
    assert.ok(routeCode.includes("normalizeStoreId")); // UUID 驗證 + 小寫化
  });

  it("🔴 傳落 RPC 嘅一定係**請求嘅原始** from／to（截斷權威在 SQL，route 只核對回傳值）", () => {
    // 2026-09-25 實案：先截斷再傳 ⇒ SQL 回 clamped=false ⇒ 同 expected 對唔上 ⇒ 長區間全部 503
    assert.ok(
      /p_from:\s*fromParam\s*,\s*\n?\s*p_to:\s*toParam\s*,/.test(routeCode),
      "RPC 冇收到原始 fromParam／toParam",
    );
    assert.ok(
      !/p_from:\s*expected\.from/.test(routeCode) && !/p_from:\s*range\.from/.test(routeCode),
      "🔴 route 先截斷再傳 —— SQL 會回 clamped=false，驗值即 503",
    );
    assert.ok(routeCode.includes("validateOfflineReportRpc(data, expected)"), "冇用 expected 核對回傳值");
  });

  it("回應要 echo SQL 回嘅區間（`validated.from` / `validated.to`）", () => {
    assert.ok(
      /range:\s*\{\s*from:\s*validated\.from\s*,\s*to:\s*validated\.to\s*,\s*clamped:\s*validated\.clamped\s*\}/.test(
        routeCode,
      ),
      "回應冇用 SQL 回傳值砌 from／to",
    );
  });
});

describe("route：鑑權例外要寫明（鐵律 5）", () => {
  it("🔴 刻意唔行 `posRouteAuthGuard()` —— 但一定要有註釋講理由", () => {
    assert.ok(!routeCode.includes(["posRoute", "AuthGuard()"].join("")), "唔應該加 POS 終端憑證閘（會令 Ledger 401）");
    assert.match(route, /posRouteAuthGuard/, "例外理由一定要寫喺檔頭，否則審計會當漏網端點");
    assert.ok(route.includes("Ledger 伺服器") && route.includes("HMAC"), "檔頭要講清楚呼叫方同替代鑑權方式");
  });
});

describe("0058 migration：DB 聚合口徑（鐵律 4）", () => {
  it("函數名／簽名同 route 一致", () => {
    assert.ok(migrationCode.includes(`function public.${FUNC}(`), "migration 冇定義預期函數");
    assert.ok(migrationCode.includes("p_store_id text"), "store_id 係 text 欄（0011），參數唔應該寫 uuid");
    assert.ok(routeCode.includes(`rpc("${FUNC}"`), "route 冇叫呢支函數");
  });

  it("🔴 日歸屬＝四條時間腿（settled_at 排最前，唔可以只寫 settled_at/updated_at）", () => {
    const legs = ["o.settled_at, o.reopened_at, o.updated_at, o.created_at"];
    assert.ok(migrationCode.includes(legs[0]), "migration 缺四條時間腿");
    assert.ok(migrationCode.includes("at time zone k_tz"), "冇轉 Asia/Macau");
    assert.ok(migration.includes("Asia/Macau"));
  });

  it("🔴 排除線上投影單（唔排除就會同 Ledger 線上數重複計）", () => {
    assert.ok(migrationCode.includes("o.online_order_id is null"), "缺排除 online_order_id");
  });

  it("🔴 狀態收窄：線下 settled／paid 計入，refunded／partially_refunded 剔除", () => {
    assert.ok(migrationCode.includes("o.status in ('settled', 'paid')"), "缺可計狀態");
    assert.ok(migrationCode.includes("o.status in ('refunded', 'partially_refunded')"), "退款單冇計 refundedAvos");
  });

  it("🔴 金額一律 ×100 轉 avos 整數（`pos_orders.total` 係 MOP numeric）", () => {
    assert.ok(migrationCode.includes("* 100"), "冇做 MOP → avos 轉換");
    assert.ok(/round\(/.test(migrationCode), "冇 round");
    assert.ok(migrationCode.includes("::bigint"), "avos 冇收到整數型");
  });

  it("人流：counter 一單 1 人、其餘 greatest(1, party_size)", () => {
    assert.ok(migrationCode.includes("table_id = 'counter'"), "缺 counter 判定");
    assert.ok(migrationCode.includes("greatest(1, coalesce(party_size, 1))"), "缺堂食人流 fallback");
  });

  it("90 日 clamp：保留 to、from = to − 89，並回 clamped", () => {
    assert.ok(migrationCode.includes("k_max_days") && migrationCode.includes("- (k_max_days - 1)"), "clamp 算式唔對");
    assert.ok(migrationCode.includes("'clamped',"));
  });

  it("支付方式：長度截斷到 32 字（超過會被 Ledger 整包拒收）", () => {
    assert.ok(migrationCode.includes("k_max_method_len"), "冇截斷 method 長度");
    assert.ok(/left\(/.test(migrationCode), "冇用 left() 截斷");
  });

  it("🔴 唯讀 + 唔提升權限 + 只 grant service_role", () => {
    assert.ok(migrationCode.includes("stable"), "函數唔係 stable");
    assert.ok(migrationCode.includes("security invoker"), "唔應該用 security definer（唔需要開後門）");
    assert.ok(!migrationCode.includes("security definer"), "出現 security definer");
    assert.ok(
      /revoke all on function public\.pos_offline_report\(text, date, date\) from public, anon, authenticated;/.test(
        migrationCode,
      ),
      "冇 revoke anon／authenticated（anon 就讀得到全期跨店聚合，繞過 0041 時間窗）",
    );
    assert.ok(
      /grant execute on function public\.pos_offline_report\(text, date, date\) to service_role;/.test(migrationCode),
      "冇 grant service_role",
    );
  });

  it("🔴 唔可以引用 83／94 嘅 report_ro view（83 從未在 production 建立）", () => {
    assert.ok(!migrationCode.includes("report_ro."), "migration 引用咗 report_ro（= 冇跑 83 就 create 唔到）");
  });

  it("🔴 唔可以包 transaction（商家會誤解 commit ＝ git commit，0057 教訓）", () => {
    assert.ok(!/^\s*begin\s*;/im.test(migrationCode), "出現 begin;");
    assert.ok(!/^\s*commit\s*;/im.test(migrationCode), "出現 commit;");
  });
});

describe("環境變數文件同步", () => {
  it("`.env.example` 有記載，並講明唔可以同 webhook secret 共用", () => {
    const env = readRepo(ENV_EXAMPLE);
    assert.ok(env.includes(ENV_SECRET), `.env.example 未記載 ${ENV_SECRET}`);
    const block = env.slice(env.indexOf(ENV_SECRET) - 1200, env.indexOf(ENV_SECRET) + 400);
    assert.match(block, /唔可以|不可|must not/i, "冇寫明唔可以共用／唔可以加 NEXT_PUBLIC_ 前綴");
    assert.ok(!new RegExp(`NEXT_PUBLIC_${ENV_SECRET}`).test(env), "🔴 加咗 NEXT_PUBLIC_ 前綴 = secret 公開");
  });
});

describe("lib 純邏輯：契約常數同檔案分離原因", () => {
  it("路徑／上限同契約固定值一致", () => {
    const lib = readSrc(LIB);
    assert.ok(lib.includes('"/api/integration/ledger/offline-report"'));
    assert.ok(lib.includes("OFFLINE_REPORT_MAX_DAYS = 90"));
    assert.ok(lib.includes("5 * 60_000"), "時間窗唔係 5 分鐘");
  });

  it("純邏輯檔零 `@/` 依賴（否則 `node --test` 載入唔到）", () => {
    const lib = stripJs(readSrc(LIB));
    assert.ok(!lib.includes('from "@/'), "lib 有 @/ 別名 import");
    assert.ok(!lib.includes(".tsx"), "lib 唔應該拖到 tsx");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2026-09-26 增補：`orders[]` ＋ `dishes[]`
// ═══════════════════════════════════════════════════════════════════════════

describe("0066 migration：同 0058 同一簽名（唔可以改簽名）", () => {
  it("🔴 `create or replace` 同一簽名 ⇒ 唔使改 grants、舊呼叫唔會斷", () => {
    // 先確保 `sqlBody()` 真係拆到 body（拆唔到就會令下面所有口徑斷言變空轉綠燈）
    assert.ok(channelBody.length > 500, "sqlBody 拆唔到 0066 body —— 下面所有口徑斷言會變空轉");
    assert.ok(
      /create or replace function public\.pos_offline_report\(\s*p_store_id text,\s*p_from\s+date default null,\s*p_to\s+date default null\s*\)/.test(
        channelSql,
      ),
      "0066 改咗簽名 —— 舊 grants／呼叫會失效，必須同 0058 一模一樣",
    );
  });

  it("🔴 只 grant service_role（唔可以開畀 anon，否則繞過 0041 嘅 72 小時窗）", () => {
    for (const [name, src] of [
      ["0058", migration],
      ["0059", detailSql],
      ["0066", channelSql],
    ] as const) {
      assert.ok(
        /revoke all on function public\.pos_offline_report\(text, date, date\) from public, anon, authenticated;/.test(
          src,
        ),
        `${name} 冇 revoke anon／authenticated`,
      );
      assert.ok(
        /grant execute on function public\.pos_offline_report\(text, date, date\) to service_role;/.test(src),
        `${name} 冇 grant service_role`,
      );
      assert.ok(!/\bgrant execute\b[^;]*\bto\b[^;]*\banon\b/.test(src), `${name} grant 咗 anon`);
    }
  });

  it("🔴 唯讀 stable、唔用 security definer、唔包 transaction", () => {
    assert.ok(channelSql.includes("stable"), "0066 唔係 stable");
    assert.ok(channelSql.includes("security invoker"), "0066 唔係 security invoker");
    assert.ok(!channelSql.includes("security definer"), "0066 出現 security definer");
    assert.ok(!/^\s*begin\s*;/im.test(channelSql), "0066 出現 begin;（商家會誤解 commit = git commit）");
    assert.ok(!/^\s*commit\s*;/im.test(channelSql), "0066 出現 commit;");
    assert.ok(!channelSql.includes("report_ro."), "0066 引用咗 83／94 嘅 report_ro view");
  });
});

describe("0066 migration：🔴🔴🔴 舊欄 SQL 必須同 0060 逐字相同（J：舊欄一個數字都唔可以變）", () => {
  it("先確保兩份 body 都拆得到（拆唔到下面全部變空轉綠燈）", () => {
    assert.ok(baselineBody.length > 500, "sqlBody 拆唔到 0060 body");
    assert.ok(channelBody.length > 500, "sqlBody 拆唔到 0066 body");
  });

  // 🔴🔴🔴 呢條係全個檔最重要嘅一條。
  //
  // 2026-10-07 事故教訓：之前嘅守衛淨係斷「欄位名／型別」，對**數值**完全空轉
  // （實測 10 種改壞：漏咗 `online_order_id is null`、多咗 aggregate、改咗排序、
  //   加咗欄位…全部捉唔到）。所以呢度唔斷字串 —— 直接同 0060 逐段比對 SQL。
  //
  // 正常情況 ⇒ 兩段 SQL **逐字相同** ⇒ 同一份 `pos_orders` 必然算出同一組數字。
  it("🔴 `orders[]` 段 SQL 同 0060 逐字相同（除咗 channel 派生欄／輸出欄）", () => {
    const now = normalizeLegacySegment(sqlSegment(channelBody, ...LEGACY_ORDERS_SEG));
    const base = normalizeLegacySegment(sqlSegment(baselineBody, ...LEGACY_ORDERS_SEG));
    assert.ok(now.length > 300 && base.length > 300, "段拆唔到（守衛變空轉）");
    if (now !== base) {
      // 指出第一處差異所在，方便直接落手改
      let i = 0;
      while (i < Math.min(now.length, base.length) && now[i] === base[i]) i += 1;
      assert.fail(
        `🔴🔴 orders[] 段 SQL 已經唔同咗 0060 ⇒ \`orders.length\`／\`ordersTotal\` 會變，Ledger 嗰張卡即刻跳數。\n` +
          `       第一處差異喺第 ${i} 個字元：\n` +
          `       0060: …${base.slice(Math.max(0, i - 60), i + 100)}…\n` +
          `       0066: …${now.slice(Math.max(0, i - 60), i + 100)}…`,
      );
    }
  });

  it("🔴 `dishes[]` 段 SQL 同 0060 逐字相同（qty／revenueAvos 嘅值就係由佢決定）", () => {
    const now = normalizeLegacySegment(sqlSegment(channelBody, ...LEGACY_DISHES_SEG));
    const base = normalizeLegacySegment(sqlSegment(baselineBody, ...LEGACY_DISHES_SEG));
    assert.ok(now.length > 300 && base.length > 300, "段拆唔到（守衛變空轉）");
    if (now !== base) {
      let i = 0;
      while (i < Math.min(now.length, base.length) && now[i] === base[i]) i += 1;
      assert.fail(
        `🔴🔴 dishes[] 段 SQL 已經唔同咗 0060 ⇒ \`dishes[].qty\`／\`revenueAvos\` 會變（實測曾經由 42／84000 變 54／108000）。\n` +
          `       第一處差異喺第 ${i} 個字元：\n` +
          `       0060: …${base.slice(Math.max(0, i - 60), i + 100)}…\n` +
          `       0066: …${now.slice(Math.max(0, i - 60), i + 100)}…`,
      );
    }
  });

  it("🔴 v1 kpi／byPayment／refunded 三段亦要逐字相同（唔止 orders／dishes）", () => {
    const segs: ReadonlyArray<readonly [string, RegExp, RegExp]> = [
      ["v1 kpi", /select o\.total,\s*o\.discount_amount/, /into v_order_count/],
      ["v1 byPayment", /select o\.total,\s*o\.payment_method/, /into v_by_payment/],
      ["v1 refunded", /select o\.refunded_amount,\s*o\.refund_records/, /into v_refunded/],
    ];
    for (const [name, startRe, endRe] of segs) {
      const now = normalizeLegacySegment(sqlSegment(channelBody, startRe, endRe));
      const base = normalizeLegacySegment(sqlSegment(baselineBody, startRe, endRe));
      assert.ok(now.length > 100 && base.length > 100, `${name} 段拆唔到（守衛變空轉）`);
      assert.ok(now === base, `🔴 ${name} 段 SQL 唔同咗 0060 ⇒ 舊 KPI 五欄／byPayment 嘅數值會變`);
    }
  });

  it("🔴 `online_order_id is null` 出現 5 次，同 0060 一致（kpi／byPayment／refunded／orders／dishes 各一）", () => {
    // 🔴 0066 第一版得 3 次（orders／dishes 被移除咗過濾）⇒ 75 張變 93 張。
    //    方案 A 還原後應該同 0060 一樣係 5 次。
    const n = (channelBody.match(/o\.online_order_id is null/g) ?? []).length;
    const n60 = (baselineBody.match(/o\.online_order_id is null/g) ?? []).length;
    assert.equal(
      n,
      n60,
      `0066 有 ${n} 處 \`online_order_id is null\`，但 0060 有 ${n60} 處 —— ` +
        `少咗即係舊欄開始包埋線上單，Ledger 張卡會跳數`,
    );
  });

  it("🔴 v1 kpi／byPayment 兩段（base → into）完全唔掂 channel（守住「舊欄唔經過新邏輯」）", () => {
    // 一旦有人喺 v1 段加咗 `case … end as channel` 再 group by channel，
    // 舊欄嘅聚合路徑就會改變 ⇒ 值會變 ⇒ Ledger 嗰張已對數嘅卡即刻跳數。
    //
    // ⚠️ 定位用**代碼結構**（base CTE 嘅 select 清單 ＋ `into <v1 變數>`），
    //    唔可以用 `--` 註解做 marker —— `sqlBody()` 已經剝走晒所有 SQL 註解。
    const segments: ReadonlyArray<readonly [string, RegExp, RegExp]> = [
      [
        "v1 kpi",
        /select o\.total,\s*o\.discount_amount,\s*o\.table_id,\s*o\.party_size/,
        /into v_order_count/,
      ],
      ["v1 byPayment", /select o\.total,\s*o\.payment_method/, /into v_by_payment/],
      ["v1 refunded", /select o\.refunded_amount,\s*o\.refund_records/, /into v_refunded/],
    ];
    for (const [name, startRe, endRe] of segments) {
      const start = channelBody.search(startRe);
      const end = channelBody.search(endRe);
      assert.ok(start >= 0, `搵唔到 ${name} 段嘅 base CTE`);
      assert.ok(end > start, `搵唔到 ${name} 段嘅 into 結尾`);
      const seg = channelBody.slice(start, end);
      assert.ok(!/as channel/.test(seg), `🔴 ${name} 段加咗 \`as channel\` —— 舊欄聚合路徑已改變`);
      assert.ok(!/group by\s+channel/.test(seg), `🔴 ${name} 段 group by channel`);
      for (const lit of ["online_platform", "online_projection"]) {
        assert.ok(!seg.includes(lit), `🔴 ${name} 段出現渠道字面值 ${lit} —— 舊欄已經過咗新邏輯`);
      }
    }
  });

  it("🔴 唔可以喺 0066 偷偷收窄渠道（`source not in` / `source <> 'aomi'` 呢類都唔准出現）", () => {
    // 三路 CASE 嘅第一個分支已經用 `source in (...)` 判為 online_platform，
    // 所以**任何**「反向排除」都係想收窄 v1 口徑 ⇒ 會令舊卡跳數。
    for (const bad of [
      "source not in ('aomi', 'mfood')",
      "source not in ('aomi','mfood')",
      "source <> 'aomi'",
      "source != 'aomi'",
    ]) {
      assert.ok(!channelBody.includes(bad), `0066 出現收窄 v1 口徑嘅條件：${bad}`);
    }
  });

  it("🔴 v1 五欄 + byPayment 四個 key 必須照 v1 名輸出（唔可以改名／唔可以搬位）", () => {
    const ret = channelBody.slice(channelBody.lastIndexOf("return jsonb_build_object"));
    for (const key of [
      "'orderCount'",
      "'revenueAvos'",
      "'refundedAvos'",
      "'discountAvos'",
      "'covers'",
      "'byPayment'",
      "'found'",
      "'from'",
      "'to'",
      "'clamped'",
      "'ordersTotal'",
      "'orders'",
      "'dishesTotal'",
      "'dishes'",
    ]) {
      assert.ok(ret.includes(key), `0066 嘅 return 缺 v1 key ${key}`);
    }
  });

  it("🔴 v1 kpi 嘅狀態收窄仍然係 settled／paid，退款仍然係 refunded／partially_refunded", () => {
    assert.ok(channelBody.includes("o.status in ('settled', 'paid')"), "0066 冇收窄到可計銷售狀態");
    assert.ok(
      channelBody.includes("o.status in ('refunded', 'partially_refunded')"),
      "0066 退款單冇計 refundedAvos",
    );
  });
});

describe("0066 migration：channel 三值判定（J：唔可以用 online_order_id 當線下）", () => {
  it("🔴 CASE 必須三個分支齊，而且**每一段**都要齊（唔係「有一段齊就算」）", () => {
    // 🔴 淨靠其中一個都會錯標：
    //    · 只有 `online_order_id is null` → 外賣平台單（冇呢欄）會被當線下
    //    · 只有 `source` → 掃碼單（冇 source）會被當線下
    //
    // 🔴🔴 0066 嘅 channel CASE 散落喺 4 段 SQL（kpiByChannel／paymentBreakdown／
    //    orders／dishes）。只斷「檔案入面有冇一處三齊」係**空轉**：
    //    改壞其中 3 段都捉唔到。⇒ 逐個 block 抽出來 individually 驗。
    const blocks = [...channelBody.matchAll(/case\s+when o\.source[\s\S]*?end as channel/g)].map((m) => m[0]);
    assert.ok(
      blocks.length >= 4,
      `channel CASE 應該散落喺 4 段 SQL（kpiByChannel／paymentBreakdown／orders／dishes），實際 ${blocks.length}`,
    );
    for (const [i, block] of blocks.entries()) {
      for (const branch of [
        /when o\.source in \('aomi', 'mfood'\) then 'online_platform'/,
        /when o\.online_order_id is not null then 'online_projection'/,
        /else 'offline'/,
      ]) {
        assert.ok(
          branch.test(block),
          `🔴 第 ${i + 1} 段 channel CASE 缺分支 ${branch.source} —— 三分支必須每段齊，唔可以淨係靠其中一個`,
        );
      }
    }
  });

  it("🔴 渠道三個值嘅字面量必須同 lib 嘅 OFFLINE_REPORT_CHANNELS 一致（唔可以 SQL 一套、TS 另一套）", () => {
    const lib = readSrc(LIB);
    for (const ch of ["offline", "online_projection", "online_platform"]) {
      assert.ok(lib.includes(`"${ch}"`), `lib 嘅渠道值域冇 ${ch}`);
      assert.ok(channelBody.includes(`'${ch}'`), `0066 SQL 冇 ${ch}`);
    }
  });

  it("🔴 渠道值域唔可以無聲擴大（新增第四個值一定要同步改 lib ＋ 呢條守衛）", () => {
    const lib = readSrc(LIB);
    const block = lib.slice(lib.indexOf("OFFLINE_REPORT_CHANNELS"));
    const listed = [...block.slice(0, block.indexOf("]")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    assert.equal(
      listed.length,
      3,
      `OFFLINE_REPORT_CHANNELS 應該有 3 個值，實際 ${JSON.stringify(listed)} —— 加值就要同步改 normalizeOfflineReportChannel 同 SQL`,
    );
  });
});

describe("0066 migration：kpiByChannel ＋ paymentBreakdown", () => {
  it("🔴 兩個新 key 一定要一齊出（部分缺 = SQL 有 bug ⇒ route 503 失敗得響）", () => {
    assert.ok(channelBody.includes("'kpiByChannel'"), "0066 冇回 kpiByChannel");
    assert.ok(channelBody.includes("'paymentBreakdown'"), "0066 冇回 paymentBreakdown");
  });

  it("🔴 kpiByChannel 三組（offline／online／onlinePlatform）每組五欄", () => {
    for (const key of ["'offline'", "'online'", "'onlinePlatform'"]) {
      assert.ok(channelBody.includes(key), `kpiByChannel 缺 ${key}`);
    }
    // 三組各自要有 orderCount／revenueAvos／refundedAvos／discountAvos／covers
    for (const f of ["'orderCount'", "'revenueAvos'", "'refundedAvos'", "'discountAvos'", "'covers'"]) {
      const n = (channelBody.match(new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
      assert.ok(n >= 3, `kpiByChannel 嘅 ${f} 應該出現至少 3 次（三組各一次），實際 ${n}`);
    }
  });

  it("🔴 paymentBreakdown 七個欄位一個都唔可以少", () => {
    for (const key of [
      "'method'",
      "'label'",
      "'channel'",
      "'orderCount'",
      "'receivableAvos'",
      "'paidAvos'",
      "'diffAvos'",
    ]) {
      assert.ok(channelBody.includes(key), `paymentBreakdown 缺 ${key}`);
    }
  });

  it("🔴 應收口徑 ＝ Σ(price×qty) + 服務費 + 稅（同 POS aggregate() 逐字一致）", () => {
    assert.ok(channelBody.includes("o.service_charge_amount"), "應收漏咗服務費");
    assert.ok(channelBody.includes("o.tax_amount"), "應收漏咗稅");
    // Σ(price × qty)：兩條 regex 守門同乘號，順序唔綁（SQL 內係 quantity 先 price）
    assert.ok(
      /it ->> 'quantity'[\s\S]{0,200}it ->> 'price'/.test(channelBody),
      "應收冇用 items 嘅 quantity × price",
    );
  });

  it("🔴🔴 `diffAvos` 唔可以夾非負（平台抽成會令實收 > 應收）", () => {
    // 🔴 實測有平台單應收 259 / 實收 232（−27），夾咗就變成假零。
    //
    // ⚠️ 2026-10-07 反證揪出原版守衛**空轉**：regex 寫成
    //    `greatest(0, …[^)]*diffAvos)`（要求 greatest 喺 diffAvos **之後**），
    //    但 SQL 係 `'diffAvos', greatest(0, …)` ⇒ 永遠唔 match。
    // ⚠️ 亦唔可以斷「值以 `greatest(` 開頭就算 bug」—— 正確寫法本身就係
    //    `greatest(0, 應收)::bigint - coalesce(實收, 0)::bigint`（夾嘅係應收，唔係整條減法）。
    // ⇒ 正確判斷：**整個值唔可以被單一函數完全包住**（配對 `)` 唔可以落喺最後）。
    const expr = jsonbObjectValueSameLine(channelBody, "diffAvos");
    assert.ok(expr !== null, "parse 唔到 diffAvos 嘅值表達式");
    const close = firstCallCloseIndex(expr as string);
    assert.ok(close >= 0, `diffAvos 應該有函數呼叫，實際：${expr}`);
    assert.ok(
      close !== (expr as string).length - 1,
      `🔴 diffAvos 被 greatest(0,…) 完全包住 —— 平台抽成嘅負差額會變假零。實際：${expr}`,
    );
    // 正面確認：值應該係「兩個值相減」
    assert.ok(
      /-\s*coalesce\s*\(/i.test(expr as string),
      `diffAvos 應該係兩個值相減（應收 − 實收），實際：${expr}`,
    );
    // 對照組：`receivableAvos` 就**應該**被 greatest(0,…) 包住（金額唔會係負）
    const rec = jsonbObjectValueSameLine(channelBody, "receivableAvos");
    assert.ok(rec !== null, "parse 唔到 receivableAvos");
    assert.ok(
      /^greatest\s*\(\s*0\s*,/i.test((rec as string).trim()),
      `receivableAvos 應該夾非負（金額唔會係負），實際：${rec}`,
    );
  });

  it("🔴 支付翻譯層要同 payment-method-label.ts 逐個 key 對齊（雙份維護會漂）", () => {
    const labelSrc = stripJs(readSrc(PAYMENT_LABEL));
    const block = labelSrc.slice(labelSrc.indexOf("LEDGER_PAYMENT_MODE_LABELS"));
    const table = block.slice(0, block.indexOf("};"));
    const keys = [...table.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);
    assert.ok(keys.length >= 2, `payment-method-label 嘅映射表解析唔到 key：${JSON.stringify(keys)}`);
    for (const key of keys) {
      assert.ok(
        channelBody.includes(`'${key}'`),
        `🔴 0066 SQL 嘅翻譯 CASE 冇 key「${key}」—— 同 payment-method-label.ts 漂咗，Ledger 會見到英文`,
      );
    }
  });

  it("🔴 翻譯層嘅 else 分支必須原樣返回（唔可以加會撞 store 自訂名嘅 key）", () => {
    // ⚠️ 加 `cash → 現金` 呢類 key 會令 store 自己叫「現金」嘅項被改寫。
    //     所以 SQL 嘅 else 一定要係 `left(btrim(...), k_max_label_len)`。
    assert.ok(
      /else\s+left\(btrim\(o\.payment_method\),\s*k_max_label_len\)/.test(channelBody),
      "0066 翻譯層嘅 else 分支唔係原樣返回 store 自訂名",
    );
    for (const risky of ["'cash'", "'mpay'", "'alipay'", "'wechat'"]) {
      assert.ok(!channelBody.includes(risky), `🔴 翻譯層出現高風險 key ${risky}（會撞 store 自訂名）`);
    }
  });
});

describe("0066 migration：舊欄 orders[]／dishes[] 維持 0060 形狀（方案 A）", () => {
  it("🔴 orders[] 每列四個欄位（orderNo／totalAvos／status／channel）", () => {
    const seg = sqlSegment(channelBody, ...LEGACY_ORDERS_SEG);
    assert.ok(seg.length > 300, "orders[] 段拆唔到");
    for (const key of ["'orderNo'", "'totalAvos'", "'status'", "'channel'"]) {
      assert.ok(seg.includes(key), `orders[] 缺 ${key}`);
    }
  });

  it("🔴 orders[] 仍然要包未結帳單：只剔除 `cancelled`（唔可以收窄到 settled／paid）", () => {
    assert.ok(channelBody.includes("<> 'cancelled'"), "orders[] 冇剔除 cancelled");
    assert.ok(channelBody.includes("left(o.local_order_no"), "orders[] 冇取本地單號");
  });

  it("🔴🔴 orders[] **必須保留** `online_order_id is null`（線上單改由 ordersByChannel[] 送）", () => {
    // 🔴 0066 第一版移除咗呢行 ⇒ orders.length 由 75 變 93 ⇒ Ledger 張卡跳數。
    //    方案 A：舊欄還原，線上另開新 key。
    const seg = sqlSegment(channelBody, ...LEGACY_ORDERS_SEG);
    assert.ok(seg.includes("o.online_order_id is null"), "🔴 orders[] 冇排除線上投影單");
    // 🔴 而且 orders[] 段唔准出現 per_channel / 拆欄 aggregate（只可以喺新 key）
    assert.ok(!seg.includes("per_channel"), "🔴 orders[] 出現 per_channel（只應該喺 dishes 段）");
  });

  it("🔴🔴 dishes[] **只准三個欄位**（name／qty／revenueAvos，唔准加拆欄）", () => {
    const seg = sqlSegment(channelBody, ...LEGACY_DISHES_SEG);
    assert.ok(seg.length > 300, "dishes[] 段拆唔到");
    for (const key of ["'name'", "'qty'", "'revenueAvos'"]) {
      assert.ok(seg.includes(key), `dishes[] 缺 ${key}`);
    }
    for (const key of ["'offlineQty'", "'offlineRevenueAvos'", "'onlineQty'", "'onlineRevenueAvos'"]) {
      assert.ok(
        !seg.includes(key),
        `🔴 dishes[] 出現 ${key} —— 拆欄只可以喺新 key \`dishesByChannel[]\`。` +
          `加咗而 ` + "`online_order_id is null`" + ` 仍在 ⇒ offlineQty 永遠等於 qty、onlineQty 永遠 0，兩欄都係假資料`,
      );
    }
    // 🔴 舊欄唔准有二維聚合（0066 第一版正係喺呢度加咗 per_channel）
    assert.ok(!seg.includes("per_channel"), "🔴 dishes[] 出現 per_channel（二維聚合只應該喺新 key）");
  });

  it("🔴🔴 dishesByChannel[] 先至可以拆欄，而且一定要做「先分渠道、再 merge」", () => {
    // 由 ordersByChannel 段之後開始，覆蓋 base／per_channel／agg／jsonb_agg 四層
    const start = channelBody.search(/into v_orders_ch_total/);
    const end = channelBody.search(/into v_dishes_ch_total/);
    assert.ok(start > 0 && end > start, `搵唔到 dishesByChannel 段（start=${start} end=${end}）`);
    const dishCh = channelBody.slice(start, end);
    for (const key of ["'offlineQty'", "'offlineRevenueAvos'", "'onlineQty'", "'onlineRevenueAvos'"]) {
      assert.ok(dishCh.includes(key), `dishesByChannel[] 缺 ${key}`);
    }
    assert.ok(dishCh.includes("group by dkey, channel"), "dishesByChannel 冇做 (dkey, channel) 二維聚合");
    assert.ok(dishCh.includes("sum(qty_c)"), "dishesByChannel merge 層冇用 sum(qty_c) 加埋總數");
    assert.ok(dishCh.includes("sum(rev_c)"), "dishesByChannel merge 層冇用 sum(rev_c) 加埋總額");
    // 🔴 新段**唔准**有 `online_order_id is null`（全渠道係呢個 key 存在嘅理由）
    assert.ok(
      !dishCh.includes("o.online_order_id is null"),
      "🔴 dishesByChannel[] 有 `online_order_id is null` ⇒ 線上菜品唔會出現，個 key 就冇存在意義",
    );
  });

  it("🔴 ordersByChannel[] 必須係全渠道（唔准有 `online_order_id is null`）", () => {
    const start = channelBody.search(/left\(o\.local_order_no[\s\S]*?into v_orders_ch_total/);
    assert.ok(start > 0, "搵唔到 ordersByChannel 段");
    // 由「舊 orders[] 之後」第一個 local_order_no 起，到 into v_orders_ch_total 止
    const legacyEnd = channelBody.search(/limit k_max_orders/);
    const segStart = channelBody.indexOf("left(o.local_order_no", legacyEnd);
    const segEnd = channelBody.indexOf("into v_orders_ch_total");
    assert.ok(segStart > 0 && segEnd > segStart, "ordersByChannel 段定位失敗");
    const seg = channelBody.slice(segStart, segEnd);
    assert.ok(
      !seg.includes("o.online_order_id is null"),
      "🔴 ordersByChannel[] 有 `online_order_id is null` ⇒ 線上投影單永遠唔會出現，J 22:30 拍板要送全量",
    );
    assert.ok(seg.includes("'channel'"), "ordersByChannel[] 每列要有 channel");
  });

  it("🔴 兩個新 key 一定要喺 return 嘅新段落（唔可以混入 v1 key 群）", () => {
    const ret = channelBody.slice(channelBody.lastIndexOf("return jsonb_build_object"));
    for (const key of [
      "'kpiByChannel'",
      "'paymentBreakdown'",
      "'ordersByChannelTotal'",
      "'ordersByChannel'",
      "'dishesByChannelTotal'",
      "'dishesByChannel'",
    ]) {
      assert.ok(ret.includes(key), `0066 嘅 return 缺新 key ${key}`);
    }
  });

  it("🔴 dishes[] 只計 settled／paid ＋ 排除已退菜（007 唔可以放寬）", () => {
    assert.ok(channelBody.includes("o.status in ('settled', 'paid')"), "dishes 冇收窄到可計銷售狀態");
    assert.ok(
      channelBody.includes("coalesce(e.it ->> 'voided', 'false') <> 'true'"),
      "dishes 冇排除已退菜",
    );
  });

  it("🔴🔴 dishes[] 兩處 ORDER BY 都係金額倒序（0060 定案，唔准改返銷量倒序）", () => {
    // jsonb_agg 決定陣列次序；子查詢＋limit 決定保留邊 300 款。
    // 只改一處會出現「截斷用銷量、排序用金額」嘅分叉。
    // ⚠️ 兩個新 key（dishes／dishesByChannel）都係金額倒序 ⇒ 應該有 4 處。
    const ords = [...channelBody.matchAll(/order by ([ra])\.(\w+) desc/g)].map((m) => m[2]);
    assert.ok(ords.length >= 4, `搵唔到 dishes 嘅 ORDER BY（應該 ≥ 4 處）：${JSON.stringify(ords)}`);
    for (const o of ords) {
      assert.equal(o, "revenue_avos", `dishes 排序用咗 ${o} —— 0060 定案係 revenue_avos desc`);
    }
    assert.ok(!/order by [ra]\.qty_/.test(channelBody), "🔴 dishes 仲有銷量倒序");
  });

  it("🔴 dishes[] 仍然有上限，而且係 SQL 自己截", () => {
    assert.ok(channelBody.includes("limit k_max_dishes"), "dishes 冇 limit");
    assert.ok(channelBody.includes("limit k_max_orders"), "orders 冇 limit");
    assert.ok(channelBody.includes("count(*) over ()"), "冇用 window count 拎未截斷總數");
  });
});

describe("0066 migration：四條時間腿 ＋ Asia/Macau ＋ 金額轉 avos（口徑唔可以飄）", () => {
  it("🔴 日歸屬＝四條時間腿（settled_at 排最前），四段都要有", () => {
    const legs = "coalesce(o.settled_at, o.reopened_at, o.updated_at, o.created_at)";
    const n = (channelBody.split(legs).length - 1);
    assert.ok(n >= 4, `四條時間腿應該出現至少 4 次（kpi／kpiByChannel／paymentBreakdown／refunded／orders／dishes），實際 ${n}`);
    assert.ok(channelBody.includes("at time zone k_tz"), "冇轉 Asia/Macau");
    assert.ok(channelSql.includes("Asia/Macau"));
  });

  it("🔴 金額一律 ×100 轉 avos 整數", () => {
    assert.ok(channelBody.includes("* 100"), "冇做 MOP → avos 轉換");
    assert.ok(/round\(/.test(channelBody), "冇 round");
    assert.ok(channelBody.includes("::bigint"), "avos 冇收到整數型");
  });

  it("🔴 90 日 clamp：保留 to、from = to − 89，並回 clamped", () => {
    assert.ok(channelBody.includes("k_max_days") && channelBody.includes("- (k_max_days - 1)"), "clamp 算式唔對");
    assert.ok(channelBody.includes("'clamped',"));
  });

  it("🔴 items 展開要 jsonb_typeof 守門，唔可以硬 cast", () => {
    assert.ok(channelBody.includes("jsonb_typeof(o.items) = 'array'"), "items 冇 jsonb_typeof 守門");
    assert.ok(channelBody.includes("jsonb_array_elements"), "冇展開 items");
  });

  it("🔴 展開 items 要防非數字字串（每個 `::numeric` cast 都要有 regex 守門）", () => {
    // 🔴 守「行為不變量」：凡係 `(it ->> 'f')::numeric` 嘅 cast，前面一定要有
    //    `~ '^-?[0-9]…$'` 守門。冇守門 ⇒ 有一項 price 係 'x' 就令**整條 SQL 死掉**
    //    （唔係單行唔計）。
    //
    // ⚠️ 唔好寫死 `) ~` 單空格：SQL 用對齊排版（可以係 `)    ~`）⇒ 過度脆弱。
    // ⚠️ `dishes[]` 嘅展開別名係 `e.it`，`paymentBreakdown` 係 `it` ⇒ regex 要兩者都中。
    for (const f of ["quantity", "price"]) {
      const guarded = channelBody.match(
        new RegExp(`\\((?:e\\.)?it ->> '${f}'\\)\\s*~\\s*'\\^-\\?\\[0-9`, "g"),
      );
      const casts = channelBody.match(new RegExp(`\\((?:e\\.)?it ->> '${f}'\\)\\s*::numeric`, "g"));
      assert.ok((casts ?? []).length > 0, `${f} 完全冇 cast（守衛變空轉）`);
      assert.ok(
        (guarded ?? []).length >= (casts ?? []).length,
        `${f}：${(casts ?? []).length} 個 cast 但只有 ${(guarded ?? []).length} 個 regex 守門 —— 資料有一項非數字就會令整條 SQL 死掉`,
      );
    }
  });
});

describe("🔴 0066 唔可以回自由文字／顧客個資（守住 v1 紅線）", () => {
  it("0066 body 一律唔准掂備註類欄位", () => {
    for (const needle of [
      "order_note",
      "discount_note",
      "comp_note",
      "comped_at",
      "raw_json",
      "platform_fees",
      "external_order_id",
    ]) {
      assert.ok(!channelBody.includes(needle), `0066 body 出現疑似個資／擴權欄位：${needle}`);
    }
  });

  it("items 逐項展開只准讀 name／menuItemId／quantity／price／voided", () => {
    const used = channelBody.match(/e\.it ->> '([a-zA-Z_]+)'/g) ?? [];
    const allowed = new Set(["menuItemId", "name", "quantity", "price", "voided"]);
    for (const m of used) {
      const field = m.replace(/.*'([a-zA-Z_]+)'/, "$1");
      assert.ok(allowed.has(field), `dishes 讀咗未授權嘅 item 欄位：${field}`);
    }
  });
});

describe("🔴 0060 基準檔本身唔可以退化（否則下面嘅逐字比對會變成「兩個都錯 ⇒ 一致」）", () => {
  it("🔴 0060 仍然係「dishes 金額倒序 ×2」（0060 定案，唔准改返銷量倒序）", () => {
    // ⚠️ 唔可以只 match `order by a.…`：0060 嘅 byPayment 用 `m.amount_avos`、
    //    orders[] 用 `b.ev`，真正要守嘅只有 dishes 嗰兩處 `revenue_avos`。
    const n = (baselineBody.match(/order by \w+\.revenue_avos desc/g) ?? []).length;
    assert.equal(n, 2, `0060 嘅 dishes 應該有 2 處 \`order by …revenue_avos desc\`，實際 ${n} —— 呢個檔係舊欄基準，郁咗排序會令所有比對失去意義`);
    assert.ok(!/order by \w+\.qty_/.test(baselineBody), "🔴 0060 仲有銷量倒序");
  });

  it("🔴 0060 仍然有 5 處 `online_order_id is null`（kpi／byPayment／refunded／orders[]／dishes[]）", () => {
    const n = (baselineBody.match(/o\.online_order_id is null/g) ?? []).length;
    assert.equal(n, 5, `0060 應該有 5 處，實際 ${n} —— 呢個檔係「舊欄口徑」嘅定義來源`);
  });

  it("🔴 0060 仍然係同一簽名 ＋ 同一組上限常數", () => {
    assert.ok(
      /create or replace function public\.pos_offline_report\(\s*p_store_id text,\s*p_from\s+date default null,\s*p_to\s+date default null\s*\)/.test(
        baselineSql,
      ),
      "0060 簽名被改 —— 基準失效",
    );
    assert.ok(baselineBody.includes("k_max_orders      constant int  := 3000"), "0060 k_max_orders 被改");
    assert.ok(baselineBody.includes("k_max_dishes      constant int  := 300"), "0060 k_max_dishes 被改");
  });

  it("🔴 0060 嘅舊欄輸出仍然係三欄 dishes／三欄 orders（冇被偷偷加欄）", () => {
    const ret = baselineBody.slice(baselineBody.lastIndexOf("return jsonb_build_object"));
    for (const key of ["'orders'", "'ordersTotal'", "'dishes'", "'dishesTotal'"]) {
      assert.ok(ret.includes(key), `0060 return 缺 ${key}`);
    }
    // 舊欄 dishes 只有 name／qty／revenueAvos
    const dStart = baselineBody.indexOf("coalesce(nullif(btrim(e.it ->> 'menuItemId')");
    const dSeg = baselineBody.slice(dStart, baselineBody.indexOf("limit k_max_dishes"));
    for (const bad of ["'offlineQty'", "'onlineQty'", "'channel'"]) {
      assert.ok(!dSeg.includes(bad), `🔴 0060 嘅 dishes 出現 ${bad} —— 基準被污染`);
    }
  });
});

describe("route ＋ lib：0066 渠道能力嘅接線", () => {
  it("🔴 caps 標頭要宣告渠道 token（Ledger 靠佢知道自己可以讀渠道欄）", () => {
    const lib = readSrc(LIB);
    assert.ok(lib.includes("OFFLINE_REPORT_CAPS_CHANNEL"), "lib 冇 OFFLINE_REPORT_CAPS_CHANNEL");
    for (const token of ["kpiByChannel", "paymentBreakdown", "ordersByChannel", "dishesByChannel"]) {
      assert.ok(lib.includes(`"${token}"`), `caps token 應該包含 ${token}`);
    }
    // 兩參數形式由下面「route：caps 標頭」嗰條守（避免兩條守同一件事）
  });

  it("🔴 caps 渠道 token 只可以喺 `hasDetail && hasChannel` 時宣告", () => {
    const lib = readSrc(LIB);
    const fn = lib.slice(lib.indexOf("export function offlineReportCapsHeader"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    assert.ok(
      body.includes("hasDetail && hasChannel"),
      "渠道 token 冇綁 hasDetail —— 冇明細嘅話根本冇嘢可標示渠道",
    );
  });

  it("🔴 route 要把 hasChannel 同四個新 key 交落 payload 組裝", () => {
    assert.ok(routeCode.includes("hasChannel: validated.hasChannel"), "route 冇傳 hasChannel");
    for (const field of [
      "paymentBreakdown",
      "ordersByChannel",
      "ordersByChannelTotal",
      "dishesByChannel",
      "dishesByChannelTotal",
    ]) {
      assert.ok(routeCode.includes(`${field}: validated.${field}`), `route 冇傳 ${field}`);
    }
  });

  it("🔴 降級閥要包埋**六個**渠道 key（唔可以淨係兩個 —— 會出現半吊子狀態）", () => {
    const lib = stripJs(readSrc(LIB));
    assert.ok(lib.includes("rpc-partial-channel-keys"), "冇區分渠道 key 全缺／部分缺");
    assert.ok(lib.includes("hasChannel"), "lib 冇 hasChannel 概念");
    // 🔴 方案 A 加咗兩個新 key ⇒ 降級閥必須包埋佢哋
    const CH = lib.slice(lib.indexOf("const CHANNEL_CAPABILITY_KEYS"));
    const block = CH.slice(0, CH.indexOf("]"));
    for (const k of [
      "kpiByChannel",
      "paymentBreakdown",
      "ordersByChannel",
      "ordersByChannelTotal",
      "dishesByChannel",
      "dishesByChannelTotal",
    ]) {
      assert.ok(block.includes(`"${k}"`), `🔴 CHANNEL_CAPABILITY_KEYS 漏咗 ${k} —— 會出現「有 paymentBreakdown 但冇 dishesByChannel」嘅半吊子狀態`);
    }
  });

  it("🔴 `hasChannel` 依賴 `hasDetail`（冇明細就冇嘢可標示渠道）", () => {
    const lib = readSrc(LIB);
    assert.ok(
      /const hasChannel = hasDetail &&/.test(lib),
      "hasChannel 冇綁 hasDetail —— 0059 未跑但 0066 跑咗嘅中間狀態會錯宣告",
    );
    const build = lib.slice(lib.indexOf("export function buildOfflineReportResponse"));
    assert.ok(
      /hasChannel = input\.hasChannel === true && input\.hasDetail/.test(build),
      "buildOfflineReportResponse 冇再綁一次 hasDetail",
    );
  });

  it("🔴 `byPayment` 永遠照 v1 輸出（唔可以因為有渠道能力就改成全渠道）", () => {
    const lib = readSrc(LIB);
    const build = lib.slice(lib.indexOf("export function buildOfflineReportResponse"));
    assert.ok(build.includes("byPayment: input.byPayment"), "build 冇照抄 v1 byPayment");
    // 唔可以出現「byPayment: ...paymentBreakdown」呢類替換
    assert.ok(
      !/byPayment:\s*input\.(paymentBreakdown|hasChannel)/.test(build),
      "🔴 byPayment 被新資料取代 —— Ledger 嗰條 bar 上嘅「外賣平台」條會突然消失",
    );
  });

  it("🔴 `v` 仍然係 1（0066 加咗三個 key 都唔可以升）", () => {
    const lib = stripJs(readSrc(LIB));
    assert.ok(lib.includes("OFFLINE_REPORT_VERSION = 1"), "v 唔係 1");
    assert.ok(!/OFFLINE_REPORT_VERSION\s*=\s*[2-9]/.test(lib), "v 被升級咗");
  });

  it("🔴 `diffAvos` 用有符號驗證（唔可以夾非負 —— 平台抽成會令佢為負）", () => {
    const lib = readSrc(LIB);
    assert.ok(lib.includes("isSignedSafeInt"), "lib 冇有符號整數檢查");
    const fn = lib.slice(lib.indexOf("export function validateOfflineReportRpc"));
    const idx = fn.indexOf("diffAvos");
    assert.ok(idx > 0, "驗證函式冇掂 diffAvos");
    const window = fn.slice(idx - 40, idx + 120);
    assert.ok(window.includes("isSignedSafeInt"), "diffAvos 冇用 isSignedSafeInt");
    assert.ok(
      !/isNonNegativeSafeInt\(row\.diffAvos\)/.test(fn),
      "🔴 diffAvos 用咗非負檢查 —— 平台抽成嘅負差額會令整包 503",
    );
  });

  it("🔴🔴🔴 舊欄 `dishes[]` 出現拆欄要 503（`rpc-dish-split-on-legacy`）", () => {
    // 呢個係今次事故嘅**第二層保險**：就算有人再犯同一個錯（加拆欄落舊欄），
    // server 都唔會再送一份「舊欄數值被改」嘅 payload 出街。
    // ⚠️ 唔可以當成 optional 欄位處理：加拆欄而 `online_order_id is null` 仍在
    //    ⇒ offlineQty 永遠等於 qty、onlineQty 永遠 0 ⇒ 兩欄都係假資料。
    const lib = readSrc(LIB);
    assert.ok(lib.includes("rpc-dish-split-on-legacy"), "lib 冇拒收舊欄 dish 拆欄");
    const fn = lib.slice(lib.indexOf("export function validateOfflineReportRpc"));
    assert.ok(fn.includes("DISH_SPLIT_KEYS"), "驗證函式冇用 DISH_SPLIT_KEYS 掃描舊欄");
    // 斷言真係喺 push 舊欄**之前**
    const legacyPush = fn.indexOf("dishes.push({ name, qty: row.qty, revenueAvos: row.revenueAvos })");
    const guard = fn.indexOf("rpc-dish-split-on-legacy");
    assert.ok(legacyPush > 0, "搵唔到舊欄 dishes.push（守衛變空轉）");
    assert.ok(guard > 0 && guard < legacyPush, "🔴 拆欄守衛寫喺 push 之後 —— 已經收咗先驗，冇用");
  });

  it("🔴 dishesByChannel 拆欄加埋必須等於總數（唔等就係 SQL merge 壞咗）", () => {
    const lib = readSrc(LIB);
    assert.ok(
      lib.includes("rpc-dishch-split-qty-mismatch"),
      "lib 冇驗 dishesByChannel 嘅 offlineQty + onlineQty == qty",
    );
    assert.ok(lib.includes("rpc-partial-dishch-split"), "lib 冇區分 dishesByChannel 拆欄全缺／部分缺");
  });

  it("🔴 `ordersByChannel[]` 嘅 channel 係必填（成個 key 就係為咗標示渠道而存在）", () => {
    const lib = readSrc(LIB);
    const fn = lib.slice(lib.indexOf("export function validateOfflineReportRpc"));
    const orderchAt = fn.indexOf("rpc-bad-orderch-channel");
    const legacyAt = fn.indexOf("rpc-bad-order-channel");
    assert.ok(orderchAt > 0 && legacyAt > 0, "守衛變空轉");
    assert.ok(orderchAt !== legacyAt, "🔴 新舊兩個 array 用咗同一個 reason —— 分唔到邊個邊個");
  });

  it("🔴 `onlineIncluded` 呢個 flag 唔准再出現（語意已經錯 —— 舊欄唔再含線上單）", () => {
    const lib = readSrc(LIB);
    const routeSrc = readSrc(ROUTE);
    assert.ok(
      !lib.includes("onlineIncluded"),
      "🔴 flag 名仲係 onlineIncluded，但舊欄已還原，語意講錯嘢（會令 Ledger 以為 orders[] 有線上單）",
    );
    assert.ok(!routeSrc.includes("onlineIncluded"), "route 仲提到 onlineIncluded");
    assert.ok(lib.includes("channelBreakdownAvailable"), "應該用 channelBreakdownAvailable 呢個中性名");
  });

  it("🔴🔴 舊 `OfflineReportDishRow` 型別只准三欄（唔准加 optional 拆欄）", () => {
    // 反證捉到過：有人喺舊型別加 `offlineQty?: number` 當「無害 additive」，
    // 但咁樣 SQL 一旦照加，舊 `dishes[]` 就會**靜靜**多返四個欄位而冇人察覺。
    // ⇒ 型別層就要封死：拆欄只可以出現喺 `OfflineReportDishByChannelRow`。
    const lib = readSrc(LIB).replace(/\r\n/g, "\n");
    const start = lib.indexOf("export type OfflineReportDishRow = {");
    assert.ok(start > 0, "搵唔到 OfflineReportDishRow（守衛變空轉）");
    const seg = lib.slice(start, lib.indexOf("}", start));
    for (const k of ["offlineQty", "offlineRevenueAvos", "onlineQty", "onlineRevenueAvos"]) {
      assert.ok(!seg.includes(k), `🔴 舊 dishes 型別加咗 ${k} —— 拆欄只可以喺 dishesByChannel[]`);
    }
    // 三個舊欄位一個都唔可以少
    for (const k of ["name", "qty", "revenueAvos"]) {
      assert.ok(seg.includes(k), `舊 dishes 型別少咗 ${k}`);
    }
    // 新型別一定要有四拆欄（否則新 key 嘅欄位冇型別保障）
    const chAt = lib.indexOf("export type OfflineReportDishByChannelRow = {");
    assert.ok(chAt > 0, "搵唔到 OfflineReportDishByChannelRow");
    const chSeg = lib.slice(chAt, lib.indexOf("}", chAt));
    for (const k of ["offlineQty", "offlineRevenueAvos", "onlineQty", "onlineRevenueAvos"]) {
      assert.ok(chSeg.includes(k), `新 dishes 型別缺 ${k}（七欄必填）`);
    }
  });

  it("🔴 `buildOfflineReportResponse` 唔可以將拆欄加落舊 `dishes`（型別收窄咗都要 runtime 守住）", () => {
    const lib = readSrc(LIB);
    const fn = lib.slice(lib.indexOf("export function buildOfflineReportResponse"));
    // 舊 dishes 只可以係 `input.dishes` 原樣輸出
    assert.ok(fn.includes("dishes: input.dishes"), "舊 dishes 應該原樣輸出 input.dishes");
    // 🔴 唔可以出現任何「喺舊 dishes 加欄位」嘅痕跡
    const dishAssign = fn.slice(fn.indexOf("dishes: input.dishes"));
    const line = dishAssign.slice(0, dishAssign.indexOf("\n"));
    assert.ok(
      !/offlineQty|onlineQty|offlineRevenueAvos|onlineRevenueAvos/.test(line),
      "🔴 舊 dishes 輸出時加咗拆欄",
    );
  });

  it("🔴 渠道值一定要過白名單（唔可以原樣透傳 SQL 嘅字串）", () => {
    const lib = readSrc(LIB);
    assert.ok(lib.includes("normalizeOfflineReportChannel"), "lib 冇渠道白名單函式");
    const fn = lib.slice(lib.indexOf("export function validateOfflineReportRpc"));
    for (const reason of ["rpc-bad-pb-channel", "rpc-bad-order-channel", "rpc-bad-orderch-channel"]) {
      const at = fn.indexOf(reason);
      assert.ok(at > 0, `搵唔到 ${reason}`);
      assert.ok(
        fn.slice(Math.max(0, at - 300), at).includes("normalizeOfflineReportChannel"),
        `${reason} 之前冇過白名單`,
      );
    }
  });
});

describe("lib 純邏輯：零 `@/` 依賴（新增嘅 channel 模組都唔可以破例）", () => {
  it("OFFLINE_REPORT_CHANNELS 所在嘅檔零 `@/` 依賴", () => {
    const lib = stripJs(readSrc(LIB));
    assert.ok(!lib.includes('from "@/'), "lib 有 @/ 別名 import（node --test 會載入唔到）");
    assert.ok(!lib.includes(".tsx"), "lib 唔應該拖到 tsx");
  });
});

describe("route：caps 標頭 ＋ 截斷權威在 SQL（唔可以自己截）", () => {
  it("🔴 response 一定要帶 `x-pos-offline-report-caps`（v 唔升 ⇒ 靠佢探測能力）", () => {
    assert.ok(routeCode.includes('"x-pos-offline-report-caps"'), "冇 caps 標頭");
    // 🔴 0066 起 caps 要**同時**跟兩個能力位（明細 + 渠道）。
    //    淨跟 hasDetail ⇒ 未跑 0066 嘅環境會宣告 channel token，Ledger 讀唔到欄位。
    //    淨跟 hasChannel ⇒ 未跑 0059 嘅環境會宣告明細 token，但根本冇 orders key。
    assert.ok(
      /offlineReportCapsHeader\(\s*validated\.hasDetail\s*,\s*validated\.hasChannel\s*\)/.test(routeCode),
      "caps 標頭冇跟 RPC 實際能力（hasDetail, hasChannel）—— Ledger 會以為有渠道但其實冇",
    );
    // 唔可以淨傳一個參數（舊 0060 形式）—— 咁 hasChannel 會永遠係 false
    assert.ok(
      !/offlineReportCapsHeader\(\s*validated\.hasDetail\s*\)/.test(routeCode),
      "🔴 caps 標頭仲係單參數（舊形式）—— 渠道 token 永遠唔會宣告",
    );
  });

  it("🔴 `v` 一定係 1（加欄位唔可以升 v）", () => {
    const lib = stripJs(readSrc(LIB));
    assert.ok(lib.includes("OFFLINE_REPORT_VERSION = 1"), "v 唔係 1");
    assert.ok(!/OFFLINE_REPORT_VERSION\s*=\s*[2-9]/.test(lib), "v 被升級咗");
  });

  it("🔴 route 唔可以自己截 orders／dishes（截斷權威只可以喺 SQL）", () => {
    for (const bad of [
      /\.slice\(0,\s*OFFLINE_REPORT_MAX_ORDERS/,
      /\.splice\(0,\s*OFFLINE_REPORT_MAX_ORDERS/,
      /\.slice\(0,\s*OFFLINE_REPORT_MAX_DISHES/,
      /\.splice\(0,\s*OFFLINE_REPORT_MAX_DISHES/,
    ]) {
      assert.ok(!bad.test(routeCode), `route 自己截斷：${bad}`);
    }
    // truncated 要由 SQL 嘅總數推導
    assert.ok(
      routeCode.includes("hasDetail: validated.hasDetail"),
      "route 冇把 hasDetail 交給 payload 組裝",
    );
  });

  it("🔴 上限常數同 0059 SQL 兩邊一致（改咗一邊就會靜默分叉）", () => {
    const lib = readSrc(LIB);
    assert.ok(lib.includes("OFFLINE_REPORT_MAX_ORDERS = 3000"), "lib 嘅 orders 上限唔係 3000");
    assert.ok(lib.includes("OFFLINE_REPORT_MAX_DISHES = 300"), "lib 嘅 dishes 上限唔係 300");
    assert.ok(detailBody.includes("k_max_orders      constant int  := 3000"), "0059 k_max_orders 唔係 3000");
    assert.ok(detailBody.includes("k_max_dishes      constant int  := 300"), "0059 k_max_dishes 唔係 300");
  });

  it("🔴 0059 未跑要優雅降級（唔可以因為缺 key 就 503 死咗 Ledger 現有張卡）", () => {
    const lib = stripJs(readSrc(LIB));
    assert.ok(lib.includes("rpc-partial-detail-keys"), "冇區分「全缺（舊版）」同「只缺部分（bug）」");
    assert.ok(lib.includes("hasDetail"), "lib 冇 hasDetail 概念");
    assert.ok(
      /hasDetail:\s*false/.test(lib) || /presentDetailKeys\.length !== 0/.test(lib),
      "冇實作「四個 key 全缺 = 舊版」嘅判定",
    );
  });
});
