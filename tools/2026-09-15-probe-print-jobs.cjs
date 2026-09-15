/**
 * 2026-09-15 唯讀探測：打印中心截圖之後，雲端 pos_print_jobs 到底係咩狀態。
 *
 * 用途：商家貼出截圖（8 行全部「失敗」）之後，唔靠目測、直接查 DB 得出：
 *   · 各 status 分佈（今天 / 24h 窗）
 *   · failed 行嘅 attempts / last_error（分辨「作廢」vs「真失敗」）
 *   · 仍然 pending 嘅有幾多（＝會唔會一次過爆紙）
 *   · 中繼機最後心跳
 *
 * 用法（唔需要 secrets，用公開 anon key 唯讀探測；RLS 只放行 24h 窗）：
 *   node tools/2026-09-15-probe-print-jobs.cjs
 *
 * 找 key：專案 README / .env.example / 之前跑過嘅探測輸出。
 */

const url = (process.env.POS_SUPABASE_URL || "https://iyrywzormzisyppkokbi.supabase.co").replace(/\/+$/, "");
const anon = (process.env.POS_SUPABASE_ANON_KEY || "").trim();

if (!anon) {
  console.error("缺少 POS_SUPABASE_ANON_KEY（唯讀探測用；anon key 本身係公開值）");
  process.exit(1);
}

const H = { apikey: anon, Authorization: `Bearer ${anon}` };

async function get(path) {
  const res = await fetch(`${url}/rest/v1/${path}`, { headers: H });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const MACAU = (iso) =>
  new Date(iso).toLocaleString("zh-HK", { timeZone: "Asia/Macau", hour12: false });

(async () => {
  console.log(`探測目標：${url}\n`);

  // 1) 24h 窗內 status 分佈
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = await get(
    `pos_print_jobs?select=id,store_id,order_no,status,attempts,claimed_by,claimed_at,finished_at,last_error,created_at,updated_at&created_at=gte.${since24h}&order=created_at.desc&limit=400`,
  );

  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  console.log(`【24 小時窗】共 ${rows.length} 行`);
  console.log("  status 分佈：", byStatus);

  // 2) 🔴 仍未印完 = 重啟中繼機後會唔會一次過爆紙
  const open = rows.filter((r) => r.status === "pending" || r.status === "printing");
  console.log(`\n【仍未印完（pending / printing）】${open.length} 行 ← 🔴 中繼機上線就會印呢批`);
  for (const r of open.slice(0, 30)) {
    console.log(
      `  ${MACAU(r.created_at)}  ${r.order_no ?? "?"}  ${r.status}  attempts=${r.attempts}  claimed_by=${r.claimed_by ?? "-"}`,
    );
  }

  // 3) failed 行：分辨「作廢」vs「真失敗」
  const failed = rows.filter((r) => r.status === "failed");
  const voided = failed.filter((r) => (r.last_error ?? "").includes("作廢") || (r.last_error ?? "").startsWith("VOID_STALE") || r.attempts === 5);
  const agentFailed = failed.filter((r) => (r.last_error ?? "").includes("AGENT_FAILED"));
  console.log(`\n【failed 行】${failed.length} 行`);
  console.log(`  · 作廢類（attempts=5 / 作廢文字）：${voided.length}`);
  console.log(`  · AGENT_FAILED（打印機真出事）：${agentFailed.length}`);
  const noReason = failed.filter((r) => !r.last_error);
  console.log(`  · 冇 last_error（＝「失敗原因 —」）：${noReason.length}`);
  for (const r of noReason.slice(0, 10)) {
    console.log(`     ${MACAU(r.created_at)}  ${r.order_no ?? "?"}  attempts=${r.attempts}`);
  }

  // 4) 今日（澳門）分佈
  const macauToday = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Macau" });
  const today = rows.filter(
    (r) => new Date(r.created_at).toLocaleDateString("en-CA", { timeZone: "Asia/Macau" }) === macauToday,
  );
  const todayStatus = {};
  for (const r of today) todayStatus[r.status] = (todayStatus[r.status] || 0) + 1;
  console.log(`\n【今日 ${macauToday}（澳門）】共 ${today.length} 行 → ${JSON.stringify(todayStatus)}`);

  // 5) 中繼機心跳
  try {
    const agents = await get("pos_print_agents?select=agent_id,store_id,last_seen_at&order=last_seen_at.desc&limit=10");
    console.log(`\n【中繼機心跳】${agents.length} 部`);
    for (const a of agents) {
      const mins = Math.round((Date.now() - Date.parse(a.last_seen_at)) / 60000);
      console.log(`  ${a.agent_id} @ ${a.store_id}：${MACAU(a.last_seen_at)}（${mins} 分鐘前）`);
    }
  } catch (e) {
    console.log(`\n【中繼機心跳】查唔到（${String(e).slice(0, 120)}）`);
  }

  console.log("\n完（全部唯讀）。");
})().catch((e) => {
  console.error("探測失敗：", e.message);
  process.exit(1);
});
