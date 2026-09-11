// 自檢：確認「瀏覽器 Realtime 應該連去邊個 Supabase 專案、該專案是否 realtime-ready」。
//
// 背景（2026-09-10 收銀台「冇即時通知、新單唔自動彈出」根因）：
//   server 寫 pos_orders 用 SUPABASE_URL（POS 自有專案）；
//   瀏覽器 Realtime 訂閱用 NEXT_PUBLIC_SUPABASE_URL（實案 = Ledger 專案 zymdemjflsckicwcinxl，冇 pos_* 表）
//   → 訂一張唔存在嘅表，Supabase **唔會報錯**（channel 照樣 SUBSCRIBED）→ 靜默失效，
//     只有 F5 reload（行 server 端 /api/pos/state）先見到單。
//
// 用法（推薦）：先由 Vercel 拉真 env，再跑本腳本
//   cd macauPosSystem
//   npx vercel env pull .env.local
//   node --env-file=.env.local tools/2026-09-11-check-pos-realtime.mjs
//
// 或者手動指定（值 = POS 專案，即 SUPABASE_URL / SUPABASE_ANON_KEY 嗰對）：
//   node tools/2026-09-11-check-pos-realtime.mjs \
//     --url https://xxxx.supabase.co --anon <pos-anon-key>
//
// 亦可加 --watch 20 邊聽邊試：腳本會訂閱 pos_orders，期間你用手機掃碼落一張測試單，
// 收到事件就代表即時推送真正打通（呢個係唯一可信嘅 end-to-end 驗證）。

import { createClient } from "@supabase/supabase-js";

const REQUIRED_TABLES = ["pos_orders", "pos_print_jobs", "pos_soldout"];
const OPTIONAL_TABLES = ["pos_online_order_settings"];

// PostgREST 未認證就回 401，**唔會**查到表 → 錯 key 時判斷唔到表存在與否，
// 一定要同「key 有效但 anon 冇 select（42501 / permission denied）」分開，
// 否則會誤報「表存在但被拒」，帶錯排查方向。（實測：錯 key → Invalid API key）
function isBadApiKeyBody(body) {
  return /invalid api key|no api key|invalid jwt|jwt expired|invalid signature/i.test(body);
}

function parseArgs(argv) {
  const out = { watch: 0, store: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") out.url = argv[++i];
    else if (arg === "--anon") out.anon = argv[++i];
    else if (arg === "--store") out.store = argv[++i];
    else if (arg === "--watch") out.watch = Number(argv[++i]) || 0;
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`用法：
  node tools/2026-09-11-check-pos-realtime.mjs [--url <POS專案URL>] [--anon <POS anon key>] [--store <storeId>] [--watch <秒>]

唔傳 --url/--anon 時會讀 env（依次）：SUPABASE_URL / SUPABASE_ANON_KEY。
--watch N：訂閱 pos_orders N 秒，期間用手機落一張測試單即可驗證即時推送。`);
  process.exit(0);
}

const url = (args.url ?? process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
const anon = (args.anon ?? process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();

if (!url || !anon) {
  console.error("❌ 未提供 Supabase URL / anon key。");
  console.error("   請先 `npx vercel env pull .env.local`，再用 `node --env-file=.env.local` 執行本腳本。");
  process.exit(1);
}

const host = (() => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
})();

let failed = false;
const base = url.replace(/\/+$/, "");

console.log(`\n=== POS Realtime 自檢 ===`);
console.log(`目標專案：${host}\n`);

// ── 1) 表存在 + anon 讀得到（Realtime 靠 anon SELECT + RLS 過濾才推得落嚟）──
console.log("【1】表存在 / anon 可讀（postgres_changes 嘅前提）");
for (const table of [...REQUIRED_TABLES, ...OPTIONAL_TABLES]) {
  const required = REQUIRED_TABLES.includes(table);
  let line;
  try {
    const res = await fetch(`${base}/rest/v1/${table}?select=*&limit=1`, {
      headers: { apikey: anon, Authorization: `Bearer ${anon}` },
    });
    const body = await res.text();
    if (res.ok) {
      line = `✅ ${table}：存在，anon 可讀`;
    } else if (res.status === 404 || body.includes("PGRST205")) {
      line = `${required ? "❌" : "⚠️ "} ${table}：**表唔存在**（PGRST205）→ 呢個專案唔係 POS 專案`;
      if (required) failed = true;
    } else if (isBadApiKeyBody(body)) {
      // key 唔啱：PostgREST 未認證就拒絕，根本冇查表 → 唔可以推論表存在與否
      line = `${required ? "❌" : "⚠️ "} ${table}：**金鑰唔正確**（${body.slice(0, 60)}）→ 判斷唔到表存在與否，請先換正確 anon key`;
      if (required) failed = true;
    } else if (res.status === 401 || res.status === 403 || body.includes("42501")) {
      line = `${required ? "❌" : "⚠️ "} ${table}：key 有效但 anon 被拒（${res.status}）→ 檢查 0016 有冇 grant select`;
      if (required) failed = true;
    } else {
      line = `${required ? "❌" : "⚠️ "} ${table}：HTTP ${res.status} ${body.slice(0, 100)}`;
      if (required) failed = true;
    }
  } catch (error) {
    line = `❌ ${table}：請求失敗 ${error instanceof Error ? error.message : String(error)}`;
    if (required) failed = true;
  }
  console.log(`   ${line}`);

  // 金鑰唔啱係全域性問題：後面幾張表一定一樣失敗，冇必要繼續刷版，
  // 而且要即刻講清楚「判斷唔到表存在與否」，避免被誤讀成「表存在但被拒」。
  if (line.includes("金鑰唔正確")) {
    console.log(`\n⛔ anon key 唔正確，自檢無法繼續（唔可以推論表存在與否）。`);
    console.log(`   請去 POS 專案 Dashboard → Settings → API 取 anon public key，再重跑本腳本。\n`);
    process.exit(1);
  }
}

if (failed) {
  console.log(`\n❌ 結論：呢個專案唔可以作為 Realtime 目標（見上面 ❌）。`);
  console.log(`   請改用 POS 專案（= server 端 SUPABASE_URL 嗰個），並設：`);
  console.log(`     NEXT_PUBLIC_POS_SUPABASE_URL=${url}`);
  console.log(`     NEXT_PUBLIC_POS_SUPABASE_ANON_KEY=<同上 anon key>`);
  console.log(`   ⚠️ 改完一定要重新部署（NEXT_PUBLIC_* 係 build-time inline）。\n`);
  process.exit(1);
}

// ── 2) Realtime 渠道狀態 ──
// ⚠️ 注意：SUBSCRIBED **唔代表**推送正常（訂錯專案一樣 SUBSCRIBED）。
//    呢步只可以捉「連唔上」，唔可以當健康證明。
console.log("\n【2】Realtime 渠道");
const filter = args.store ? `store_id=eq.${args.store}` : undefined;

const client = createClient(url, anon, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { params: { eventsPerSecond: 5 } },
});

let eventCount = 0;
const channel = client
  .channel(`pos-realtime-selfcheck:${args.store ?? "all"}`)
  .on(
    "postgres_changes",
    { event: "*", schema: "public", table: "pos_orders", ...(filter ? { filter } : {}) },
    (payload) => {
      eventCount += 1;
      const row = payload.new ?? {};
      console.log(
        `   📩 收到事件 #${eventCount}：${payload.eventType} id=${row.id ?? "?"} table=${row.table_name ?? "?"} status=${row.status ?? "?"}`,
      );
    },
  );

const status = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve("TIMEOUT(10s)"), 10_000);
  channel.subscribe((s) => {
    if (s === "SUBSCRIBED" || s === "CHANNEL_ERROR" || s === "TIMED_OUT") {
      clearTimeout(timer);
      resolve(s);
    }
  });
});
console.log(`   渠道狀態：${status}`);
if (status !== "SUBSCRIBED") {
  console.log("   ❌ 連唔上 Realtime（檢查專案地區 / anon key / 網絡）。");
  await client.removeChannel(channel);
  process.exit(1);
}
console.log("   ⚠️ 提醒：SUBSCRIBED 唔等於推送正常，下面第 3 步才是真正驗證。");

// ── 3) 真實事件驗證（可選）──
if (args.watch > 0) {
  console.log(`\n【3】邊聽邊試 ${args.watch} 秒…`);
  console.log("   請而家用手機掃碼落一張測試單（或喺收銀台改一張單）。");
  const started = Date.now();
  while (Date.now() - started < args.watch * 1000 && eventCount === 0) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (eventCount > 0) {
    console.log(`\n✅ 結論：即時推送已打通（收到 ${eventCount} 個 pos_orders 事件）。`);
  } else {
    console.log(`\n⚠️ ${args.watch} 秒內冇收到任何事件。可能原因：`);
    console.log("   · 期間真係冇人落單（再試一次）");
    console.log("   · pos_orders 未加入 supabase_realtime publication");
    console.log("     → Supabase Dashboard → SQL Editor：");
    console.log("       select tablename from pg_publication_tables where pubname='supabase_realtime';");
    console.log("       ALTER PUBLICATION supabase_realtime ADD TABLE pos_orders;");
    console.log("   · store filter 唔中（--store 傳錯，或者該店冇新單）");
  }
} else {
  console.log("\n（想真正做到 end-to-end 驗證，加 --watch 20 再落一張測試單。）");
}

await client.removeChannel(channel);
console.log("\n完成。\n");
