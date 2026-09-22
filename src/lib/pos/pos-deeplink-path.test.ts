import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * 《收銀台深連結路徑》守衛（2026-09-22）。
 *
 * ## 血淚
 *
 * 2026-09-17「統一入口」改動：`/` 由**收銀台**變成**選擇工作台**頁，收銀台搬去 `/pos`
 * （見 `src/app/page.tsx` 同 `src/app/pos/page.tsx` 檔頭）。
 *
 * 但 `local-orders-panel.tsx` 兩處 `router.push` 冇跟住改，仍然推 `/?tableId=…&orderId=…`：
 *   - 「查看」（未結堂食單）；
 *   - 返結成功之後跳枱面。
 *
 * ⇒ 商家 2026-09-22 回報：「我一按訂單19嘅查看，就會跳到工作台的介面」——
 *   收銀員被掉去「請選擇要進入嘅工作台」，入唔到枱面，亦做唔到返結重結。
 *
 * 另一個同源問題：`PosApp` deep-link 消費完之後會 `history.replaceState(…, "/")` 清 query
 * —— 連**路徑**都改埋，地址列變 `/`，之後任何 reload / 返回 / 分享都會彈去選擇頁。
 *
 * ## 契約（唔可以放寬）
 * 1. Next router **唔可以**推根路徑（`/?…` 或 `"/"`）—— 要推 `/pos`。
 * 2. `history.replaceState` 清 query 一定要保留 `window.location.pathname`。
 *
 * ## 刻意**唔**納入範圍
 * - `window.location.replace("/")`（`auth-guard.tsx` / `login-screen.tsx`）：
 *   登入成功之後送去選擇工作台係**設計**（唔係 bug），所以只捉 Next router。
 * - `window.location.replace("/login?…")` 之類：唔係根路徑。
 *
 * ⚠️ 呢個檔用 `node:test` 直接跑 ⇒ 只可以 import node 內建模組。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `src/` 根（呢個檔喺 `src/lib/pos/`）。 */
const SRC_ROOT = path.resolve(HERE, "..", "..");

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
      continue;
    }
    if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(path.join(dir, entry.name));
  }
  return out;
}

/** 去掉註解（免掃描器捉到自己嘅說明文字）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 每一條都由「Next router / history API 推根路徑」嘅精確形狀砌出，唔可以放寬。 */
const ROOT_NAV_RULES: ReadonlyArray<{ label: string; re: RegExp }> = [
  /** `router.push(`/?…`)` / `router.replace(`/?…`)`（template literal 開頭就係根路徑＋query）。 */
  { label: "router 推 `/?…`", re: /router\.(?:push|replace)\(\s*`\/\?/ },
  /** `router.push("/")` / `router.replace('/')`。 */
  { label: 'router 推 "/"', re: /router\.(?:push|replace)\(\s*["']\/["']/ },
  /** `router.push(`/`)`。 */
  { label: "router 推 `/`", re: /router\.(?:push|replace)\(\s*`\/`/ },
  /** `history.replaceState(null, "", "/")` —— 連路徑都清走。 */
  { label: 'history.replaceState 寫死 "/"', re: /replaceState\([^)]*,\s*["']\/["']\s*\)/ },
];

describe("唔可以再推根路徑（2026-09-17 統一入口之後）", () => {
  it("全 src/ 零個 Next router／history 根路徑導航", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file);
      // 本檔自己嘅 pattern 定義會提及呢啲形狀，跳過。
      if (rel.endsWith(path.join("lib", "pos", "pos-deeplink-path.test.ts"))) continue;
      const src = stripComments(readFileSync(file, "utf8"));
      src.split(/\r?\n/).forEach((line, idx) => {
        for (const rule of ROOT_NAV_RULES) {
          if (rule.re.test(line)) offenders.push(`${rel}:${idx + 1} [${rule.label}] ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(
      offenders,
      [],
      `以下地方仍然推根路徑「/」—— 應該係「/pos」（或者用 window.location.replace 嘅話就要講明原因）：\n${offenders.join("\n")}`,
    );
  });

  it("pos-app.tsx 清 deep-link query 時保留 pathname", () => {
    const src = stripComments(readFileSync(path.join(SRC_ROOT, "components", "pos-app.tsx"), "utf8"));
    assert.match(
      src,
      /history\.replaceState\(null,\s*""\s*,\s*window\.location\.pathname\)/,
      "清 query 必須保留 pathname",
    );
  });
});
