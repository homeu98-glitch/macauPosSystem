#!/usr/bin/env node
/**
 * 把一批 `{ "中文": "English" }` 加入兩本字典嘅**主字典**。
 *
 * 🔴 為咩要有呢支工具（2026-10-08 血淚）：
 *   兩個字典檔各有 **3 個** top-level object（`EN_DICT` → `SHORT_EN_DICT` → `SIDEBAR_EN_DICT`）。
 *   用 `lastIndexOf("\r\n};")` 會命中**側欄字典**，新 key 靜靜落錯地方。
 *   呢支工具**只用 `indexOf`（第一個）**，而且寫入後**自我驗證**位置。
 *
 * 用法：
 *   node tools/_add-i18n-keys.cjs tools/_orders-pairs.json           # dry-run
 *   node tools/_add-i18n-keys.cjs tools/_orders-pairs.json --write
 *
 * 自動跳過主字典已存在嘅 key（避免 `TS1117 duplicate property`）。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const PAIRS_FILE = args.find((a) => !a.startsWith("--"));

if (!PAIRS_FILE) {
  console.error("用法：node tools/_add-i18n-keys.cjs <pairs.json> [--write]");
  process.exit(1);
}

const pairs = JSON.parse(fs.readFileSync(path.resolve(ROOT, PAIRS_FILE), "utf8"));
const entries = Object.entries(pairs);
const log = (...a) => console.log(...a);

const DICTS = [
  { rel: "src/lib/i18n-dict-zh.ts", marker: "export const ZH_HANT_DICT", valueOf: (zh) => zh },
  { rel: "src/lib/i18n-dict-en.ts", marker: "export const EN_DICT", valueOf: (_zh, en) => en },
];

let fails = 0;

/** 主字典 = marker 之後嘅第一個 "\r\n};"。 */
function mainDictEnd(src, marker) {
  const m = src.indexOf(marker);
  if (m < 0) return -1;
  return src.indexOf("\r\n};", m);
}

for (const { rel, marker, valueOf } of DICTS) {
  const p = path.join(ROOT, rel);
  let src = fs.readFileSync(p, "utf8");

  const end = mainDictEnd(src, marker);
  if (end < 0) {
    log(`❌ ${rel}: 搵唔到主字典（marker=${marker}）`);
    fails++;
    continue;
  }
  const head = src.slice(0, end);
  const tail = src.slice(end);

  const added = [];
  const skipped = [];
  for (const [zh, en] of entries) {
    // 只喺主字典範圍內檢查（側欄字典有同名 key 唔算「已存在」）
    if (head.includes(`\r\n  ${JSON.stringify(zh)}:`) || head.includes(`\r\n  ${zh}:`)) {
      skipped.push(zh);
      continue;
    }
    added.push(`  ${JSON.stringify(zh)}: ${JSON.stringify(valueOf(zh, en))},`);
  }

  const next = head + "\r\n" + added.join("\r\n") + tail;
  log(`\n### ${rel}`);
  log(`  新增 ${added.length} 條 · 已存在跳過 ${skipped.length} 條`);
  if (skipped.length) log(`  ↷ ${skipped.join(" / ")}`);

  if (WRITE) {
    fs.writeFileSync(p, next, "utf8");

    // ── 自我驗證：新 key 一定要落喺主字典嘅 start~end 之間 ──
    const check = fs.readFileSync(p, "utf8");
    const startLine = check.slice(0, check.indexOf(marker)).split("\n").length;
    const endLine = check.slice(0, mainDictEnd(check, marker)).split("\n").length;
    const bad = [];
    for (const line of added) {
      const key = line.trim().split(":")[0];
      const lineNo = check.split(/\r?\n/).findIndex((l) => l.trim().startsWith(key + ":")) + 1;
      if (lineNo < startLine || lineNo > endLine) {
        bad.push(`${key} @ L${lineNo}（主字典 L${startLine}-${endLine}）`);
      }
    }
    if (bad.length) {
      log(`  ❌ 落錯位置：${bad.join(" / ")}`);
      fails++;
    } else {
      log(`  ✅ 已寫入並驗證位置（主字典 L${startLine}-${endLine}）`);
    }
  }
}

log(WRITE ? (fails ? `\n❌ ${fails} 個問題` : "\n✅ 完成") : "\n（dry-run，加 --write 才落盤）");
process.exit(fails ? 1 : 0);
