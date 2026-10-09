#!/usr/bin/env node
/**
 * Batch 7 修正 —— 我原本嘅 `_batch7-apply.cjs` 用咗 `lastIndexOf("\r\n};")`，
 * 結果 8 條新 key 落咗 **SIDEBAR_*_DICT**（檔尾嗰個 object）而唔係主字典。
 * 守衛測試即刻捉到（#33 側欄英文 ≤6 字母、#44 主字典漏 key）。
 *
 * 呢個 script：
 *   ① 由 SIDEBAR_ZH_DICT / SIDEBAR_EN_DICT 刪走嗰 8 條
 *   ② 連同 5 條之前漏咗入字典嘅數字鍵盤 key（清除/歸零/確定/請輸入數字/請輸入文字）
 *      一齊插入 **主字典**（`indexOf` 第一個 "\r\n};" = 主字典收尾）
 *
 * 用法：node tools/_batch7-fix.cjs [--write]
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const WRITE = process.argv.includes("--write");
const log = (...a) => console.log(...a);
let fails = 0;

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const write = (rel, s) => fs.writeFileSync(path.join(ROOT, rel), s, "utf8");

// 8 條 batch-7 key（key 兩本字典一樣都係中文）
const B7 = [
  ["商家下單", "Staff order"],
  ["掃碼下單", "QR order"],
  ["即時通知正常", "Live updates working"],
  [
    "未設定即時連線，訂單要重新載入先會出現",
    "Live updates are not set up. Orders will only appear after a manual reload.",
  ],
  [
    "即時連線指向嘅資料庫冇訂單表（設定指錯專案），訂單要重新載入先會出現",
    "Live updates point at a database with no orders table (wrong project configured). Orders will only appear after a manual reload.",
  ],
  [
    "即時連線嘅金鑰唔正確，訂單要重新載入先會出現",
    "The live-update key is incorrect. Orders will only appear after a manual reload.",
  ],
  [
    "即時連線被資料庫拒絕（讀取權限不足），訂單要重新載入先會出現",
    "The database rejected live updates (read permission denied). Orders will only appear after a manual reload.",
  ],
  [
    "即時連線連唔上，訂單要重新載入先會出現",
    "Cannot connect to live updates. Orders will only appear after a manual reload.",
  ],
];

// 之前 patch 數字鍵盤時包咗 t() 但漏咗入字典嘅 5 條
const PAD = [
  ["清除", "Clear"],
  ["歸零", "Zero"],
  ["確定", "Confirm"],
  ["請輸入數字", "Enter a number"],
  ["請輸入文字", "Enter text"],
];

const PAIRS = [...B7, ...PAD];

// ─────────────────────────────────────────────────────────────────────────────
// ① 由 sidebar 字典刪走 batch-7 嗰 8 條（連 CRLF）
// ─────────────────────────────────────────────────────────────────────────────
function stripFromSidebar(rel, valueOf) {
  let src = read(rel);
  let removed = 0;
  for (const [zh, en] of B7) {
    // ⚠️ en 字典嗰行嘅 value 係英文，唔可以照抄 key。
    const line = `  ${JSON.stringify(zh)}: ${JSON.stringify(valueOf(zh, en))},\r\n`;
    if (src.includes(line)) {
      src = src.replace(line, "");
      removed++;
    } else {
      log(`   ⚠️ ${rel}: 搵唔到 ${JSON.stringify(line.trim())}`);
    }
  }
  log(`   ${rel}: sidebar 刪走 ${removed}/8 條`);
  if (removed !== 8) fails++;
  if (WRITE) write(rel, src);
}

stripFromSidebar("src/lib/i18n-dict-zh.ts", (zh) => zh);
stripFromSidebar("src/lib/i18n-dict-en.ts", (_zh, en) => en);

// ─────────────────────────────────────────────────────────────────────────────
// ② 插入主字典（第一個 "\r\n};"）
// ─────────────────────────────────────────────────────────────────────────────
function insertIntoMainDict(rel, valueOf) {
  let src = read(rel);
  const at = src.indexOf("\r\n};");
  if (at < 0) {
    log(`❌ ${rel}: 搵唔到主字典收尾`);
    fails++;
    return;
  }
  const head = src.slice(0, at);
  const added = [];
  for (const [zh, en] of PAIRS) {
    // 只喺「主字典」範圍內檢查，避免 sidebar 嘅殘留干擾
    if (head.includes(`  ${JSON.stringify(zh)}:`) || head.includes(`\n  ${zh}:`)) {
      log(`   ↷ 已存在，跳過：${zh}`);
      continue;
    }
    added.push(`  ${JSON.stringify(zh)}: ${JSON.stringify(valueOf(zh, en))},`);
  }
  const block = added.join("\r\n");
  src = head + "\r\n" + block + src.slice(at);
  log(`   ${rel}: 主字典新增 ${added.length} 條`);
  if (WRITE) write(rel, src);
}

insertIntoMainDict("src/lib/i18n-dict-zh.ts", (zh) => zh);
insertIntoMainDict("src/lib/i18n-dict-en.ts", (_zh, en) => en);

log(WRITE ? (fails ? `\n❌ ${fails} 個問題` : "\n✅ 修正完成") : "\n（dry-run）");
process.exit(fails ? 1 : 0);
