import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 《配對 storeId 驗真》回歸守衛（2026-09-21）。
 *
 * 🔴 背景（實測 bug）：`lookupMerchant()` 以前用 **POS 專案**嘅 `getSupabaseWriteClient()`
 * 去查 `merchants` —— 但 `merchants` 係 **Ledger** 專案嘅表 ⇒ 一定 **404 / `PGRST205`**
 * ⇒ 落入 `INFRA_ERROR_CODES` ⇒ `kind:"unknown"` ⇒ **fail-open 放行**
 * ⇒ 呢道驗真**從未生效**。後果係本檔頂部註釋講嗰個最難 debug 嘅 silent failure：
 * 配一個唔存在嘅 storeId 都會「成功」，但 claim 返 0 列 ⇒ 「顯示已連線但一張都印唔出」。
 *
 * ⚠️ `supabase-ledger-service.ts` 有 `import "server-only"` ⇒ `node --test` **載入唔到**
 * ⇒ 兩個檔都只能用 source 掃描守。
 */
const PAIR = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const SERVICE = readFileSync(
  // 由 `src/app/api/pos/print-agent/pair/` 上 5 層 = `src/`
  new URL("../../../../../lib/ledger/supabase-ledger-service.ts", import.meta.url),
  "utf8",
);

describe("pair route ── storeId 驗真要用 Ledger 專案", () => {
  it("🔴 `lookupMerchant()` 一定要用 `getLedgerServiceClient()`", () => {
    assert.ok(
      /import \{ getLedgerServiceClient \} from "@\/lib\/ledger\/supabase-ledger-service";/.test(
        PAIR,
      ),
      "冇引入 Ledger service client",
    );
    const i = PAIR.indexOf("async function lookupMerchant(");
    assert.ok(i > 0, "搵唔到 lookupMerchant");
    const body = PAIR.slice(i, i + 900);
    assert.ok(/getLedgerServiceClient\(\)/.test(body), "lookupMerchant 冇用 Ledger client");
  });

  it("🔴 `lookupMerchant()` 唔可以再用 POS 專案嘅 client", () => {
    const i = PAIR.indexOf("async function lookupMerchant(");
    const end = PAIR.indexOf("\n}", i);
    const body = PAIR.slice(i, end);
    assert.ok(
      !/getSupabaseWriteClient/.test(body),
      "又用返 POS client ⇒ 會再 404（Ledger 表唔喺 POS 專案）",
    );
    assert.ok(/from\("merchants"\)/.test(body), "查詢本身唔見咗");
  });

  it("🔴 未配置 Ledger service（`null`）→ 一定要早退 fail-open，唔可以 throw", () => {
    const i = PAIR.indexOf("async function lookupMerchant(");
    const body = PAIR.slice(i, i + 900);
    assert.ok(/if \(!ledger\) \{/.test(body), "冇處理 `getLedgerServiceClient()` 回 null");
    assert.ok(/\{ kind: "unknown" \}/.test(body), "null 時唔係 fail-open");
    assert.ok(!/throw /.test(body), "唔可以 throw（會令配對整條路爆）");
  });

  it("`22P02`（型別唔夾 UUID）仍然要當「肯定唔係商戶」擋低", () => {
    assert.ok(
      /INVALID_TYPE_CODES\.has\(code\)[\s\S]{0,120}\{ kind: "missing" \}/m.test(PAIR),
      "型別錯唔再擋 ⇒ 假 storeId 又會配得到對",
    );
  });
});

describe("supabase-ledger-service ── 憑證紀律", () => {
  it("🔴 只讀 `LEDGER_SUPABASE_SERVICE_ROLE_KEY`，**唔可以 fallback**", () => {
    assert.ok(
      /LEDGER_SUPABASE_SERVICE_ROLE_KEY/.test(SERVICE),
      "搵唔到 env 名",
    );
    // 唔可以退去 POS 嘅 service key（URL 係 Ledger ⇒ key 對唔上，會靜默失敗）
    assert.ok(
      !/SUPABASE_SERVICE_ROLE_KEY\s*\?\?\s*process\.env\.SUPABASE_SERVICE_KEY/.test(SERVICE),
      "有 fallback 去 POS service key",
    );
    assert.ok(
      !/NEXT_PUBLIC_SUPABASE_ANON_KEY/.test(SERVICE),
      "唔可以用 anon key 做特權查詢（RLS 會擋 / 靜默失敗）",
    );
  });

  it("🔴 URL 一定用 Ledger 嘅（`NEXT_PUBLIC_SUPABASE_URL`），唔可以用 POS `SUPABASE_URL`", () => {
    assert.ok(
      /process\.env\.NEXT_PUBLIC_SUPABASE_URL/.test(SERVICE),
      "冇用 Ledger URL",
    );
    assert.ok(
      !/process\.env\.SUPABASE_URL\b/.test(SERVICE),
      "用咗 POS 專案 URL ⇒ 又會查唔到 merchants（同原本個 bug 一樣）",
    );
  });

  it("有 `server-only` 保護（唔可以漏落瀏覽器 bundle）", () => {
    assert.ok(/^import "server-only";/m.test(SERVICE), "缺 server-only");
  });

  it("未配置時一定回 `null`（畀呼叫端 fail-open，唔可以 throw）", () => {
    assert.ok(/if \(!url \|\| !key\) return null;/.test(SERVICE), "未配置唔係回 null");
    assert.ok(!/throw /.test(SERVICE), "唔可以 throw");
  });
});
