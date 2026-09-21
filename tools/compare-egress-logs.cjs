/**
 * Supabase log CSV before/after 對比（2026-09-21 egress 優化驗收，唯讀）。
 *
 * 用法：
 *   node tools/compare-egress-logs.cjs <before.csv> <after.csv>
 *
 * 為何要有：Supabase log 冇 bytes 欄，但 `event_message` 帶**完整 URL**（含 query params），
 * 所以可以用「查詢形狀 × 次數」反推 egress。改動前後各自跑一次，逐項核對預期。
 *
 * 基準（2026-09-21 12:00 澳門，改動前 26.4 分鐘窗口）：
 *   pos_orders 218（其中 limit=5000 三腿 30、limit=200 三腿 132）
 *   pos_queue_events GET limit=300 → 44
 *   pos_print_jobs GET limit=200 → 44
 */
const fs = require("fs");

function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** 由一份 CSV 抽出統計。 */
function analyze(path) {
  const rows = parseCsv(fs.readFileSync(path, "utf8"));
  const header = rows[0];
  const ix = Object.fromEntries(header.map((h, i) => [h, i]));
  const data = rows.slice(1).filter((r) => r.length > 3 && r[ix.timestamp]);

  const times = data.map((r) => r[ix.timestamp]).sort();
  const t0 = Date.parse(times[0].replace(" ", "T") + "Z");
  const t1 = Date.parse(times[times.length - 1].replace(" ", "T") + "Z");
  const minutes = Math.max((t1 - t0) / 60000, 0.1);

  const byPath = new Map();
  const shapes = new Map();
  for (const r of data) {
    const p = r[ix.pathname] || "(empty)";
    byPath.set(p, (byPath.get(p) || 0) + 1);

    const msg = r[ix.event_message] || "";
    const url = (msg.match(/https?:\/\/\S+/) || [""])[0];
    const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
    let shape = null;
    if (p === "/rest/v1/pos_orders") {
      const params = new URLSearchParams(qs);
      const order = (params.get("order") || "-").split(".")[0];
      const limit = params.get("limit") || "-";
      const hasStart = ["created_at", "updated_at", "reopened_at"].some((c) => params.get(c));
      shape = `pos_orders ${r[ix.method]} order=${order} limit=${limit} ${hasStart ? "有時間下限" : "無時間下限"}`;
    } else if (p.startsWith("/rest/v1/rpc/")) {
      shape = `${p} ${r[ix.method]}`;
    } else if (p === "/rest/v1/pos_queue_events") {
      const params = new URLSearchParams(qs);
      shape = `queue_events ${r[ix.method]} limit=${params.get("limit") || "-"}`;
    } else if (p === "/rest/v1/pos_print_jobs") {
      const params = new URLSearchParams(qs);
      shape = `print_jobs ${r[ix.method]} limit=${params.get("limit") || "-"}`;
    } else if (p === "/rest/v1/pos_online_order_settings") {
      const params = new URLSearchParams(qs);
      const sel = params.get("select") || "";
      shape = `online_order_settings GET ${sel.includes("merchant_enabled") ? "5欄" : "4欄(legacy)"}`;
    }
    if (shape) shapes.set(shape, (shapes.get(shape) || 0) + 1);
  }

  return { path, count: data.length, minutes, byPath, shapes };
}

/** 由形狀 map 抽出「每個「組」嘅次數」——三腿要 ÷3、兩查詢要 ÷2。 */
function pick(shapes, predicate) {
  let n = 0;
  for (const [k, v] of shapes) if (predicate(k)) n += v;
  return n;
}

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error("用法：node tools/compare-egress-logs.cjs <before.csv> <after.csv>");
  process.exit(1);
}

const before = analyze(beforePath);
const after = analyze(afterPath);

console.log("========== 樣本窗口 ==========");
for (const s of [before, after]) {
  console.log(
    `${s === before ? "BEFORE" : "AFTER "}  ${s.count} 筆 / ${s.minutes.toFixed(1)} 分鐘 = ${(s.count / s.minutes).toFixed(1)} 請求/分鐘`,
  );
}

const METRICS = [
  {
    name: "🔴 守護全店拉取（limit=5000 三腿）",
    get: (s) => pick(s.shapes, (k) => k.includes("limit=5000")) / 3,
    unit: "次",
    expect: "大幅下降（應該接近 0）",
    better: "down",
  },
  {
    name: "🔴 全量 state 訂單（limit=200 三腿）",
    get: (s) => pick(s.shapes, (k) => /pos_orders GET order=.* limit=200 /.test(k)) / 3,
    unit: "次",
    expect: "變 0（被 RPC 取代）",
    better: "down",
  },
  {
    name: "✅ RPC pos_orders_page（新）",
    get: (s) => pick(s.shapes, (k) => k.includes("pos_orders_page")),
    unit: "次",
    expect: ">0（0046 生效）",
    better: "up",
  },
  {
    name: "🔴 報表 limit=2000 三腿",
    get: (s) => pick(s.shapes, (k) => k.includes("limit=2000")) / 3,
    unit: "次",
    expect: "變 0（被 RPC 取代）",
    better: "down",
  },
  {
    name: "🔴 queue_events POST（per-event upsert）",
    get: (s) => pick(s.shapes, (k) => k.startsWith("queue_events POST")),
    unit: "次",
    expect: "批次化後應由「每事件一次」變成「每批一次」⇒ 大降",
    better: "down",
  },
  {
    name: "queue_events GET limit=300（白拉）",
    get: (s) => pick(s.shapes, (k) => k.startsWith("queue_events GET")),
    unit: "次",
    expect: "變 0（skipQueue）",
    better: "down",
  },
  {
    name: "online_order_settings 4欄(legacy 重試)",
    get: (s) => pick(s.shapes, (k) => k.includes("4欄(legacy)")),
    unit: "次",
    expect: "變 0（0036 跑了 → 唔再撞 42703）",
    better: "down",
  },
  {
    name: "print_jobs GET limit=200（未優化）",
    get: (s) => pick(s.shapes, (k) => k.startsWith("print_jobs GET")),
    unit: "次",
    expect: "持平（本批未動）",
    better: "same",
  },
];

console.log("\n========== 逐項對比（已換算成「實際呼叫次數」）==========");
console.log("指標".padEnd(38) + "BEFORE".padStart(9) + "AFTER".padStart(9) + "  判定");
let pass = 0;
let fail = 0;
for (const m of METRICS) {
  const b = m.get(before);
  const a = m.get(after);
  const perMin = (x, s) => (x / s.minutes) * 60; // 換成每小時，兩份樣本窗口長度不同都可以比
  const bh = perMin(b, before);
  const ah = perMin(a, after);
  let verdict = "—";
  if (m.better === "down") {
    const ok = ah < bh * 0.5;
    verdict = ok ? "✅ 明顯下降" : ah <= bh ? "⚠️ 略降／未達預期" : "❌ 反而上升";
    ok || a <= b ? pass++ : fail++;
  } else if (m.better === "up") {
    const ok = a > 0;
    verdict = ok ? "✅ 已生效" : "❌ 完全冇出現（0046 可能未生效）";
    ok ? pass++ : fail++;
  } else {
    const ok = Math.abs(ah - bh) <= Math.max(bh * 0.4, 2);
    verdict = ok ? "✅ 持平（符合預期）" : "⚠️ 變化偏大";
    ok ? pass++ : fail++;
  }
  console.log(
    m.name.padEnd(38) + String(Math.round(b)).padStart(9) + String(Math.round(a)).padStart(9) + "  " + verdict,
  );
  console.log(`${"".padEnd(38)}${m.expect}`);
}

console.log("\n========== AFTER 見到嘅 pos_orders / RPC 形狀（全部）==========");
for (const [k, v] of [...after.shapes.entries()].sort((x, y) => y[1] - x[1])) {
  if (k.includes("pos_orders")) console.log(`${String(v).padStart(6)} 次  ${k}`);
}

console.log(`\n合計：${pass} 項符合預期 / ${fail} 項要跟進`);
console.log("⚠️ 注意：兩份樣本窗口長度同「時段」唔同（午市 vs 其他），所以上面已換成「每小時次數」比較。");
