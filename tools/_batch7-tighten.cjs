#!/usr/bin/env node
/**
 * Batch 7 收尾 —— 收窄 describePosRealtimeProbe() 嘅英文。
 *
 * 原本譯文太長（最長 128 字），實機截圖見到個 11px 琥珀色 toast 撐到 4 行。
 * 呢個 toast 係 `fixed bottom-4` 覆蓋層，太長會蓋住結帳掣。
 * 保留「要做咩」（手動重新載入）同「病因」，刪走重複嘅禮貌字。
 *
 * 用法：node tools/_batch7-tighten.cjs [--write]
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const WRITE = process.argv.includes("--write");
const REL = "src/lib/i18n-dict-en.ts";

const FIX = [
  [
    "Live updates are not set up. Orders will only appear after a manual reload.",
    "Live updates not set up — reload manually to see new orders.",
  ],
  [
    "Live updates point at a database with no orders table (wrong project configured). Orders will only appear after a manual reload.",
    "Live updates point to a database with no orders table (wrong project) — reload manually to see new orders.",
  ],
  [
    "The live-update key is incorrect. Orders will only appear after a manual reload.",
    "Live-update key is incorrect — reload manually to see new orders.",
  ],
  [
    "The database rejected live updates (read permission denied). Orders will only appear after a manual reload.",
    "Database rejected live updates (read permission denied) — reload manually to see new orders.",
  ],
  [
    "Cannot connect to live updates. Orders will only appear after a manual reload.",
    "Cannot connect to live updates — reload manually to see new orders.",
  ],
];

let src = fs.readFileSync(path.join(ROOT, REL), "utf8");
let fails = 0;
for (const [from, to] of FIX) {
  const n = src.split(from).length - 1;
  if (n !== 1) {
    console.log(`❌ 預期 1 命中，實際 ${n}：${from.slice(0, 60)}…`);
    fails++;
    continue;
  }
  src = src.replace(from, to);
  console.log(`ok ${to.length} 字  ← ${from.length} 字`);
}
if (!fails && WRITE) {
  fs.writeFileSync(path.join(ROOT, REL), src, "utf8");
  console.log("✅ 已寫入");
} else if (!WRITE) {
  console.log("（dry-run）");
}
process.exit(fails ? 1 : 0);
