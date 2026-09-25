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

const ROUTE = "app/api/integration/ledger/offline-report/route.ts";
const LIB = "lib/pos/offline-report.ts";
const MIGRATION = "supabase/migrations/0058_pos_offline_report_rpc.sql";
const ENV_EXAMPLE = ".env.example";

const ENV_SECRET = `${"LEDGER_OFFLINE"}_REPORT_HMAC_SECRET`;
const WEBHOOK_SECRET = `${"LEDGER_WEBHOOK"}_SECRET`;
const FUNC = `${"pos_offline"}_report`;

const route = readSrc(ROUTE);
const routeCode = stripJs(route);
const migration = readRepo(MIGRATION);
const migrationCode = stripSql(migration);

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
