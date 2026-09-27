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
 *
 * ⚠️ `node --test` 只可以 import node 內建模組 ⇒ 用**源碼掃描**（專案慣例）。
 * 🔴 needle 一律字串拼接砌，唔好寫成完整字面量（否則掃到註釋／自己）。
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

const ROUTE = "app/api/integration/ledger/offline-report/route.ts";
const LIB = "lib/pos/offline-report.ts";
const MIGRATION = "supabase/migrations/0058_pos_offline_report_rpc.sql";
const MIGRATION_DETAIL = "supabase/migrations/0059_pos_offline_report_detail.sql";
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

describe("0059 migration：同 0058 同一簽名（唔可以改簽名）", () => {
  it("🔴 `create or replace` 同一簽名 ⇒ 唔使改 grants、舊呼叫唔會斷", () => {
    // 先確保 `sqlBody()` 真係拆到 body（拆唔到就會令下面所有口徑斷言變空轉綠燈）
    assert.ok(detailBody.length > 500, "sqlBody 拆唔到 0059 body —— 下面所有口徑斷言會變空轉");
    assert.ok(
      /create or replace function public\.pos_offline_report\(\s*p_store_id text,\s*p_from\s+date default null,\s*p_to\s+date default null\s*\)/.test(
        detailSql,
      ),
      "0059 改咗簽名 —— 舊 grants／呼叫會失效，必須同 0058 一模一樣",
    );
  });

  it("🔴 只 grant service_role（唔可以開畀 anon，否則繞過 0041 嘅 72 小時窗）", () => {
    assert.ok(
      /revoke all on function public\.pos_offline_report\(text, date, date\) from public, anon, authenticated;/.test(
        detailSql,
      ),
      "0059 冇 revoke anon／authenticated",
    );
    assert.ok(
      /grant execute on function public\.pos_offline_report\(text, date, date\) to service_role;/.test(detailSql),
      "0059 冇 grant service_role",
    );
    assert.ok(!/\bgrant execute\b[^;]*\bto\b[^;]*\banon\b/.test(detailSql), "grant 咗 anon");
  });

  it("🔴 唯讀 stable、唔用 security definer、唔包 transaction", () => {
    assert.ok(detailSql.includes("stable"), "唔係 stable");
    assert.ok(detailSql.includes("security invoker"), "唔係 security invoker");
    assert.ok(!detailSql.includes("security definer"), "出現 security definer");
    assert.ok(!/^\s*begin\s*;/im.test(detailSql), "出現 begin;（商家會誤解 commit = git commit）");
    assert.ok(!/^\s*commit\s*;/im.test(detailSql), "出現 commit;");
    assert.ok(!detailSql.includes("report_ro."), "引用咗 83／94 嘅 report_ro view");
  });
});

describe("0059 migration：orders[] 口徑", () => {
  it("🔴 回四個 key（ordersTotal / orders / dishesTotal / dishes）—— 少一個 route 就 503", () => {
    for (const key of ["'ordersTotal'", "'orders'", "'dishesTotal'", "'dishes'"]) {
      assert.ok(detailBody.includes(key), `0059 回值缺 ${key}`);
    }
  });

  it("🔴 orders 一列只有三個欄位（orderNo / totalAvos / status）", () => {
    for (const key of ["'orderNo'", "'totalAvos'", "'status'"]) {
      assert.ok(detailBody.includes(key), `orders 缺 ${key}`);
    }
  });

  it("🔴 要包未結帳單：只剔除 `cancelled`，**唔可以**收窄到 settled／paid", () => {
    // 2026-09-26 用戶拍板：Ledger 要睇「邊張未埋單」⇒ orders[] ≠ KPI 那批
    assert.ok(detailBody.includes("<> 'cancelled'"), "orders 冇剔除 cancelled");
    assert.ok(detailBody.includes("left(o.local_order_no"), "orders 冇取本地單號");
  });

  it("🔴 排除線上投影單 ＋ 四條時間腿 ＋ Asia/Macau（同 KPI 同一套日歸屬）", () => {
    assert.ok(detailBody.includes("o.online_order_id is null"), "orders 冇排除線上投影單");
    assert.ok(
      detailBody.includes("coalesce(o.settled_at, o.reopened_at, o.updated_at, o.created_at)"),
      "orders 缺四條時間腿",
    );
    assert.ok(detailBody.includes("at time zone k_tz"), "orders 冇轉 Asia/Macau");
  });

  it("🔴 有上限，而且係 SQL 自己截（保留最新：倒序 + limit）", () => {
    assert.ok(detailBody.includes("limit k_max_orders"), "orders 冇 limit");
    assert.ok(/order by p\.ev desc nulls last/.test(detailBody), "orders 唔係最新優先");
    assert.ok(detailBody.includes("count(*) over ()"), "冇用 window count 拎未截斷總數");
  });

  it("金額轉 avos 並夾非負（契約：金額一律非負整數）", () => {
    assert.ok(detailBody.includes("greatest(0, round(coalesce(p.total, 0) * 100))"), "orders 金額冇夾非負 / 冇轉 avos");
  });
});

describe("0059 migration：dishes[] 口徑", () => {
  it("🔴 只計 settled／paid（同 KPI 同一批單）", () => {
    assert.ok(detailBody.includes("o.status in ('settled', 'paid')"), "dishes 冇收窄到可計銷售狀態");
  });

  it("🔴 排除已退菜（voided 只入 voidQty，唔入菜品銷售）", () => {
    assert.ok(detailBody.includes("coalesce(e.it ->> 'voided', 'false') <> 'true'"), "dishes 冇排除已退菜");
  });

  it("🔴 展開 items 要防非陣列（`jsonb_typeof` 守門，唔可以硬 cast）", () => {
    assert.ok(detailBody.includes("jsonb_typeof(o.items) = 'array'"), "items 冇 jsonb_typeof 守門");
    assert.ok(detailBody.includes("jsonb_array_elements"), "冇展開 items");
  });

  it("🔴 聚合 key ＝ `menuItemId|名稱` 快照（同名改價各自一行，歷史唔會失蹤）", () => {
    assert.ok(detailBody.includes("|| '|' ||"), "聚合 key 唔係 menuItemId|名稱");
    assert.ok(detailBody.includes("group by dkey"), "冇按 dkey 分組");
  });

  it("🔴 有上限，而且銷量倒序", () => {
    assert.ok(detailBody.includes("limit k_max_dishes"), "dishes 冇 limit");
    assert.ok(/order by r\.qty_total desc/.test(detailBody), "dishes 唔係銷量倒序");
  });

  it("名稱唔可以空（空字串會令 Ledger 顯示唔到 → route 會拒）", () => {
    assert.ok(detailBody.includes("'(未命名)'"), "冇為空名稱補 fallback");
  });
});

describe("🔴 唔可以回自由文字／顧客個資（契約：不是訂單明細／顧客個資）", () => {
  it("orders／dishes 段一律唔准掂備註類欄位", () => {
    // 呢啲係店員手打，可能寫咗「陳先生」「13xxxxxx」等顧客識別資訊
    for (const needle of ["order_note", "discount_note", "comp_note", "comped_at", "raw_json", "'note'"]) {
      assert.ok(!detailBody.includes(needle), `0059 body 出現疑似個資欄位：${needle}`);
    }
  });

  it("items 逐項展開只准讀 name／menuItemId／quantity／price／voided", () => {
    const used = detailBody.match(/e\.it ->> '([a-zA-Z_]+)'/g) ?? [];
    const allowed = new Set(["menuItemId", "name", "quantity", "price", "voided"]);
    for (const m of used) {
      const field = m.replace(/.*'([a-zA-Z_]+)'/, "$1");
      assert.ok(allowed.has(field), `dishes 讀咗未授權嘅 item 欄位：${field}`);
    }
  });
});

describe("route：caps 標頭 ＋ 截斷權威在 SQL（唔可以自己截）", () => {
  it("🔴 response 一定要帶 `x-pos-offline-report-caps`（v 唔升 ⇒ 靠佢探測能力）", () => {
    assert.ok(routeCode.includes('"x-pos-offline-report-caps"'), "冇 caps 標頭");
    assert.ok(
      routeCode.includes("offlineReportCapsHeader(validated.hasDetail)"),
      "caps 標頭冇跟 RPC 實際能力 —— Ledger 會以為有 orders 但其實冇",
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
