import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * 《版本標頭契約》守衛（2026-09-23）。
 *
 * ## 背景
 *
 * `build-stale-banner.tsx`（收銀台「版本過期」橫幅）要有
 * 「**本機 JS 版本 ≠ 線上最新版本**」先會出現。「本機版本」建置時內聯，但
 * 「線上最新」只可以經**回應標頭** `x-pos-build` 得知。
 *
 * 原本只有 `/api/pos/state` 帶呢個標頭，而佢係**純事件驅動、冇週期輪詢**
 * ⇒ 一部開住嘅收銀機可能幾個鐘都唔會再拉 state ⇒ 明明跑住舊 bundle，
 * 橫幅一直唔出（而「開住舊分頁靜靜燒 egress」正正係橫幅想防嘅事）。
 *
 * ## 呢個檔守三件事
 *
 * 1. **覆蓋面**：`/api/pos/sync`（pending 時每 30 秒）同 `/api/pos/shift`（每 180 秒）
 *    兩個**本來就會打**嘅週期請求，回應一定要帶標頭。
 *    ⇒ 用手寫 `NextResponse.json()` 一定會漏（sync 13 個 return、shift 28 個），
 *      而漏嘅後果係**靜默**（橫幅唔出，零錯誤）⇒ 一律要用 `buildJson()`。
 * 2. **client 側要真係讀**（route 帶咗但冇人讀＝白做）。
 * 3. 🔴 **零新增請求**：**唔准**為咗版本偵測加 endpoint／輪詢／加快間隔。
 *    （本專案對請求數同 egress 極敏感，見 docs/113。）
 *
 * ⚠️ 掃原始碼前一定要剝註釋 —— 解釋性註解本身會提及 `fetch(`／`NextResponse.json(`，
 *   唔剝就會自己撞自己（本專案中過最少兩次）。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** repo 根（呢個檔喺 `src/lib/pos/`）。 */
const ROOT = path.resolve(HERE, "..", "..", "..");

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

/** 剝行註解同塊註解（保留程式碼）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const SYNC_ROUTE = "src/app/api/pos/sync/route.ts";
const SHIFT_ROUTE = "src/app/api/pos/shift/route.ts";
const SERVER_HELPER = "src/lib/build-info-server.ts";
const OBSERVE_HELPER = "src/lib/build-info-observe.ts";
const POS_APP = "src/components/pos-app.tsx";
const SYNC_FLUSH = "src/lib/pos/sync-flush.ts";
const SHIFT_SYNC = "src/lib/shift-sync.ts";

describe("版本標頭契約 ── 回應側", () => {
  it("🔴 `/api/pos/sync` 唔可以再出現裸 `NextResponse.json(`（一定會漏標頭）", () => {
    const src = stripComments(read(SYNC_ROUTE));
    const offenders = src
      .split(/\r?\n/)
      .map((line, i) => ({ line, n: i + 1 }))
      .filter((x) => /NextResponse\s*\.\s*json\s*\(/.test(x.line));
    assert.deepEqual(
      offenders.map((o) => `${o.n}: ${o.line.trim()}`),
      [],
      "全部回應改為 buildJson()；漏一個就係靜默（橫幅唔出、零錯誤）",
    );
    assert.match(src, /buildJson\(/, "完全冇用 buildJson");
  });

  it("🔴 `/api/pos/shift` 唔可以再出現裸 `NextResponse.json(`", () => {
    const src = stripComments(read(SHIFT_ROUTE));
    const offenders = src
      .split(/\r?\n/)
      .map((line, i) => ({ line, n: i + 1 }))
      .filter((x) => /NextResponse\s*\.\s*json\s*\(/.test(x.line));
    assert.deepEqual(
      offenders.map((o) => `${o.n}: ${o.line.trim()}`),
      [],
      "全部回應改為 buildJson()",
    );
    assert.match(src, /buildJson\(/, "完全冇用 buildJson");
  });

  it("🔴 `buildJson()` 一定要落 `POS_BUILD_HEADER`（唔可以用字面字串）", () => {
    const src = stripComments(read(SERVER_HELPER));
    assert.match(src, /import\s*\{[^}]*POS_BUILD_HEADER[^}]*\}\s*from\s*"@\/lib\/pos\/session-record"/, "標頭名要由 session-record 嚟（單一真源）");
    assert.match(src, /headers\.set\(\s*POS_BUILD_HEADER\s*,/, "冇 set 標頭");
    assert.match(src, /readServerBuildId\(\)/, "冇讀伺服器版本");
    assert.ok(
      !/"x-pos-build"/.test(src),
      "唔可以喺呢度寫死 \"x-pos-build\" 字面值（會同 POS_BUILD_HEADER 漂移）",
    );
  });

  it("🔴 `readServerBuildId()` 一定要喺 server 端用（client 只會拎到 dev）", () => {
    const src = read(SERVER_HELPER);
    assert.match(src, /import\s*"server-only"/, "缺 server-only ⇒ 可能被打包入瀏覽器 bundle");
  });
});

describe("版本標頭契約 ── 讀取側", () => {
  it("🔴 三個讀取點都要用共用讀取器（唔可以各自寫死標頭字串）", () => {
    for (const [rel, why] of [
      [POS_APP, "`/api/pos/state`（事件驅動）"],
      [SYNC_FLUSH, "`/api/pos/sync`（有 pending 時每 30 秒）"],
      [SHIFT_SYNC, "`/api/pos/shift`（每 180 秒）"],
    ] as const) {
      const src = stripComments(read(rel));
      assert.ok(
        /observeServerBuildFromResponse\s*\(/.test(src),
        `${rel} 冇讀版本標頭 —— 咁 ${why} 帶嘅標頭等於白帶`,
      );
    }
  });

  it("🔴 讀取器要對「讀唔到／例外」靜默（唔可以影響落單流程）", () => {
    const src = stripComments(read(OBSERVE_HELPER));
    assert.match(src, /try\s*\{/, "冇 try ⇒ 一個意外就可能拖冧落單／同步路徑");
    assert.match(src, /catch/, "冇 catch");
    assert.match(src, /POS_BUILD_HEADER/, "標頭名要由 session-record 嚟");
  });

  it("`build-info.ts` 仍然零 import（`node --test` 要直接載入）", () => {
    const src = stripComments(read("src/lib/build-info.ts"));
    const offenders = src
      .split(/\r?\n/)
      .filter((l) => /^\s*import\s/.test(l) || /require\s*\(/.test(l));
    assert.deepEqual(
      offenders,
      [],
      `build-info.ts 出現 import —— 佢必須保持零依賴：\n${offenders.join("\n")}`,
    );
  });
});

describe("版本標頭契約 ── 🔴 零新增請求", () => {
  it("版本相關模組**唔可以有** `fetch(` / `setInterval` / XHR", () => {
    for (const rel of [SERVER_HELPER, OBSERVE_HELPER, "src/lib/build-info.ts"]) {
      const src = stripComments(read(rel));
      assert.ok(!/\bfetch\s*\(/.test(src), `${rel} 出現 fetch —— 版本偵測唔准增加任何請求`);
      assert.ok(!/setInterval\s*\(/.test(src), `${rel} 出現 setInterval —— 唔准加輪詢`);
      assert.ok(!/XMLHttpRequest/.test(src), `${rel} 出現 XHR`);
    }
  });

  it("sync / shift route 嘅標頭係「附帶」而唔係「另開請求」（兩個 route 都唔准 fetch 自己）", () => {
    for (const rel of [SYNC_ROUTE, SHIFT_ROUTE]) {
      const src = stripComments(read(rel));
      // route 內部對自己／其他 POS endpoint 嘅內部 fetch 會令請求數翻倍
      assert.ok(
        !/\bfetch\s*\(\s*[`"']\/api\/pos\//.test(src),
        `${rel} 內部 fetch 咗自己嘅 API —— 咁樣就唔係零新增請求`,
      );
    }
  });
});
