import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * print-agent 驗證層嘅**語義守衛**（2026-09-21 請求數優化）。
 *
 * ## 背景
 *
 * `pos_print_agents` 實測 24 分鐘 **114 次**請求：44 次 PATCH（heartbeat 專用嘅
 * `last_seen_at` 更新）＋ 70 次 GET（`verifyAgent`）⇒ 每次心跳要 **2 個 query**。
 * 但 `claim` / `result` 每次都會做同一個驗證 ⇒ **成功嘅 claim 本身已構成心跳**。
 * 所以加咗 `verifyAgent(..., { recordActivity: true })`：一個 `update … returning`
 * 同時「驗證 + 蓋章」，心跳由 2 query 變 1 query。
 *
 * ## 🔴🔴 為何要用測試鎖死「GET 唔可以 recordActivity」
 *
 * `device-config` 同 `print-agent/pair` **都有 GET 路由**會用同一個 helper 驗 agent。
 * GET 必須**安全／可快取／可 prefetch**；喺 GET 內寫入係 HTTP 語義錯誤 ——
 * 瀏覽器預取、爬蟲、代理重試都會意外改寫 `last_seen_at`，
 * 令「中繼機在線」判斷失真（而 `last_seen_at` 正是配對／排障時唯一嘅存活證據）。
 *
 * 呢個 module 冇辦法喺 runtime 知 HTTP method（helper 只收 agentId），
 * 所以唯一可靠嘅守衛係**掃 source**：新增 GET 呼叫端時唔小心傳咗 flag，測試即刻紅。
 *
 * ⚠️ 呢個測試係刻意的「笨」—— 佢唔證明行為正確，只證明「冇人喺 GET 加咗寫入」。
 */

/** 相對 `src/lib/` 嘅路徑。 */
const GET_ROUTE_FILES = [
  "../app/api/pos/device-config/route.ts",
  "../app/api/pos/print-agent/pair/route.ts",
  "../app/api/pos/print-agent/pair-status/route.ts",
];

const POST_ROUTE_FILES = [
  "../app/api/pos/print-agent/heartbeat/route.ts",
  "../app/api/pos/print-agent/claim/route.ts",
  "../app/api/pos/print-agent/result/route.ts",
];

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

describe("print-agent 驗證：只准 POST 路由記錄活動", () => {
  it("🔴 GET 路由一律唔可以出現 recordActivity（否則 GET 會寫入）", () => {
    for (const rel of GET_ROUTE_FILES) {
      const src = read(rel);
      assert.ok(
        !src.includes("recordActivity"),
        `${rel} 竟然用咗 recordActivity —— GET 路由唔可以寫 DB（見 print-agent-server.ts 說明）`,
      );
    }
  });

  it("三個 agent POST 路由都必須用 recordActivity: true（令 claim/result 兼任心跳）", () => {
    for (const rel of POST_ROUTE_FILES) {
      const src = read(rel);
      assert.ok(
        src.includes("recordActivity: true"),
        `${rel} 冇用 recordActivity: true —— 咁 claim/result 就唔會蓋 last_seen_at`,
      );
      assert.ok(
        // ⚠️ 唔可以用 `s` flag（tsconfig target 早過 ES2018）；`[^)]*` 本身就跨行。
        /verifyAgent\([^)]*recordActivity:\s*true/.test(src),
        `${rel} 嘅 recordActivity 唔係傳落 verifyAgent()`,
      );
    }
  });

  it("heartbeat 唔應該再自己做獨立 UPDATE（已經併入 verify）", () => {
    const src = read("../app/api/pos/print-agent/heartbeat/route.ts");
    assert.ok(
      !/\.from\("pos_print_agents"\)[\s\S]{0,80}\.update\(/.test(src),
      "heartbeat route 仍然有獨立嘅 pos_print_agents update ⇒ 應該已經併入 verifyAgent",
    );
  });

  it("verifyAgent 一定要 .select() 先會有 returning（唔可以盲寫）", () => {
    const src = readFileSync(new URL("./print-agent-server.ts", import.meta.url), "utf8");
    const block = src.slice(src.indexOf("if (options.recordActivity) {"));
    const head = block.slice(0, block.indexOf("} else {"));
    assert.ok(head.includes(".update("), "recordActivity 分支應該係 update");
    assert.ok(head.includes(".select(PAIRED_AGENT_COLUMNS)"), "update 之後一定要 .select() 攞 returning");
    assert.ok(head.includes(".maybeSingle()"), "要用 maybeSingle（0 行 = 驗證失敗，唔係 throw）");
  });

  it("蓋章失敗一定要降級為純讀（唔可以誤判成 401 — 401 會令 APK 清配對）", () => {
    const src = readFileSync(new URL("./print-agent-server.ts", import.meta.url), "utf8");
    const i = src.indexOf("if (options.recordActivity) {");
    const block = src.slice(i, i + 2000);
    assert.ok(
      block.includes("res.error") && block.includes("fallback"),
      "recordActivity 分支缺少「update 失敗 → 純讀 fallback」嘅降級保護",
    );
  });
});
