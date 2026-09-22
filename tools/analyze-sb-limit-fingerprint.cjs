/**
 * 《bundle 新舊指紋》分析器（2026-09-22）。
 *
 * ## 用途
 *
 * 判斷「有邊部裝置跑緊舊 bundle」—— **唔需要 Vercel log**。
 *
 * ## 原理
 *
 * `skipQueue=1` 係由 **client** 傳嘅 query param（`isOutboxV2Enabled()` 為 true 時），
 * 而 `/api/pos/state` 收唔到時會查 `limit=300`、收到時查 `limit=0`：
 *
 * ```ts
 * const queueQuery = !skipQueue && storeId
 *   ? supabase.from("pos_queue_events").select("*")….limit(300)
 *   : supabase.from("pos_queue_events").select("*").limit(0);
 * ```
 *
 * ⇒ 喺 Supabase log 睇 `pos_queue_events` GET 嘅 `limit=` 值就分得出：
 *
 * | `limit` | bundle | 單次全量 bytes |
 * |---|---|---|
 * | **300** | **舊**（唔識傳 skipQueue）| **846 KB** |
 * | **0** | **新**（傳咗 skipQueue=1）| 424 KB |
 *
 * ## 用法
 *
 * ```bash
 * node tools/analyze-sb-limit-fingerprint.cjs "<supabase_logs.csv>"
 * ```
 *
 * 唯讀，唔會改任何東西。
 */
const fs = require("fs");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQ = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else inQ = false;
      } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const path = process.argv[2];
if (!path) {
  console.error("用法：node tools/analyze-sb-limit-fingerprint.cjs \"<supabase_logs.csv>\"");
  process.exit(1);
}

const rows = parseCsv(fs.readFileSync(path, "utf8")).slice(1).filter((r) => r.length > 1);
const head = rows[0] ? null : null; // header 已 slice 走

const macau = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(11, 19);
const parseTs = (line) => {
  const m = /"(\d{4}-\d\d-\d\dT[\d:.]+Z)"/.exec(line.join(","));
  return m ? Date.parse(m[1]) : NaN;
};

const classic = { old: [], neu: [], other: 0 };
for (const r of rows) {
  const line = r.join(",");
  if (!/GET \| \d+ \| .*pos_queue_events/.test(line)) continue;
  const decoded = decodeURIComponent(line);
  const m = /limit=(\d+)/.exec(decoded);
  if (!m) {
    classic.other += 1;
    continue;
  }
  const t = parseTs(r);
  if (!Number.isFinite(t)) continue;
  if (m[1] === "300") classic.old.push(t);
  else if (m[1] === "0") classic.neu.push(t);
  else classic.other += 1;
}

function report(label, list, perCallBytes, note) {
  list.sort((a, b) => a - b);
  if (list.length === 0) {
    console.log(`\n${label}：0 次`);
    return;
  }
  const gaps = [];
  for (let i = 1; i < list.length; i += 1) gaps.push((list[i] - list[i - 1]) / 1000);
  const med = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;
  const span = (list[list.length - 1] - list[0]) / 1000;
  console.log(`\n${label}：${list.length} 次${note}`);
  console.log(`  時間：${macau(list[0])} → ${macau(list[list.length - 1])}（澳門）  跨度 ${span.toFixed(0)}s`);
  if (gaps.length) {
    console.log(
      `  間隔：中位 ${med.toFixed(2)}s  最小 ${Math.min(...gaps).toFixed(2)}s  最大 ${Math.max(...gaps).toFixed(1)}s`,
    );
  }
  const mb = ((list.length * perCallBytes) / 1048576).toFixed(1);
  console.log(`  成本：${list.length} × ${Math.round(perCallBytes / 1024)} KB ≈ ${mb} MB`);
  if (gaps.length && med < 10) {
    console.log(`  🔴 間隔中位 < 10 秒 ⇒ **迴圈指紋**（唔係正常 mount / 手動拉取）`);
  }
}

console.log(`檔案：${path}`);
console.log(`行數：${rows.length}`);
console.log("\n================ pos_queue_events GET 指紋 ================");
report("🔴 舊 bundle（limit=300）", classic.old, 846_000, "（唔識傳 skipQueue）");
report("✅ 新 bundle（limit=0）", classic.neu, 424_000, "（skipQueue=1）");
if (classic.other > 0) console.log(`\n（其他 limit 值 / 冇 limit：${classic.other} 次）`);

console.log("\n--- 點解讀 ---");
console.log("· 舊 bundle 有「間隔中位 <10 秒」嘅連續段 ⇒ 嗰部機**仍然跑舊 JS**，要完全閂掉視窗再開。");
console.log("· 新 bundle 通常只有零星 1~2 次（mount / 手動）⇒ 拉一次就停 ＝ 修正生效。");
console.log("· 搵係邊部機：叫商家逐部開設置頁睇「版本」一行（會自動出過期警示），");
console.log("  或者用 Vercel log 睇 `[pos/state] 🔴 偵測到疑似舊版 bundle … ip=`。");
console.log("\nDONE");
