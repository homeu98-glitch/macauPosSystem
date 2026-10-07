/**
 * 🔴 權威唯讀取證（2026-10-07）· 一次性定案全部基線，**唔准再用呢支以外嘅探針落結論**。
 *
 * 背景：之前五支探針各自報唔同嘅 dishesTotal（58/59）同 dishesByChannelTotal（63/64），
 * 但 Σqty／Σrev 完全一樣。根因唔係數據變，係**探針抓資料唔完整**：
 *   · PostgREST 有 `db-max-rows` 服務端上限，`limit=1000` 唔保證真係 1000；
 *   · 舊探針用 `order=created_at.desc` 而 `created_at` 有大量並列 ⇒ 每次返回次序可唔同；
 *   · 冇用 `Prefer: count=exact`／`Content-Range` 驗證過到底有冇漏行。
 *
 * 呢支探針嘅三重保險：
 *   ① `Prefer: count=exact` + 讀 `Content-Range` ⇒ 知道 server 端總行數；
 *   ② `order=id.asc`（id 唯一 ⇒ 全序）⇒ 結果可重現；
 *   ③ 逐段 `Range` 分頁直到抓齊，並斷言「抓到的 == Content-Range 聲稱的」。
 *
 * 輸出全部用恆等式交叉驗證，最後 print 一個 JSON 畀文件直接引用。
 */
const https = require("node:https");
const fs = require("node:fs");

const REF = "iyrywzormzisyppkokbi";
const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";
const BASE = `https://${REF}.supabase.co/rest/v1`;
const FROM = "2026-07-10";
const TO = "2026-10-07";

const SEL = [
  "id", "status", "total", "online_order_id", "source", "local_order_no",
  "items", "settled_at", "reopened_at", "updated_at", "created_at",
].join(",");

function req(url, headers) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) } }, (r) => {
      // 🔴🔴 必須先Buffer.concat 再 toString("utf8")。
      //   舊寫法 `d += c` 會對每個 chunk 個別toString()，而中文係 3 bytes UTF-8：
      //   一個字剛好跨 chunk 邊界就會被切爛成 U+FFFD（`�`）⇒ 菜名變咗另一個字串
      //   ⇒ dish 聚合多一行／少一行 ⇒ dishesTotal 58 vs 59 嘅假象。
      //   （本輪 2026-10-07 產勘真實踩到：同一份數據報過 58 / 59 / 64 / 63 四個值。）
      const cs = [];
      r.on("data", (c) => cs.push(c));
      r.on("end", () => {
        const buf = Buffer.concat(cs);
        res({ status: r.statusCode, body: buf.toString("utf8"), bytes: buf.length, cr: r.headers["content-range"] || "" });
      });
    }).on("error", rej);
  });
}

const btrim = (s) => String(s ?? "").replace(/^\s+/, "").replace(/\s+$/, "");
const nn = (s, d) => { const t = btrim(s); return t === "" ? d : t; };
const N = (s) => (/^-?[0-9]+(\.[0-9]+)?$/.test(String(s)) ? Number(s) : 0);
const macauDay = (t) => (t ? new Date(new Date(t).getTime() + 8 * 3600_000).toISOString().slice(0, 10) : null);
const evOf = (o) => o.settled_at || o.reopened_at || o.updated_at || o.created_at || null;
const ch = (o) => {
  const s = String(o.source || "");
  if (s === "aomi" || s === "mfood") return "online_platform";
  if (o.online_order_id) return "online_projection";
  return "offline";
};

(async () => {
  // ① 抽 anon key
  const chunks = new Set();
  for (const p of ["/prints", "/pos"]) {
    try { const r = await req(`https://macau-pos-system.vercel.app${p}`, {}); (r.body.match(/\/_next\/static\/[^"'\s]+\.js/g) || []).forEach((s) => chunks.add(s)); } catch {}
  }
  let K = "";
  for (const s of chunks) {
    try { const r = await req(`https://macau-pos-system.vercel.app${s}`, {}); const m = r.body.match(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g); if (m && m.length) { K = m[0]; break; } } catch {}
  }
  if (!K) { console.log(JSON.stringify({ ok: false, reason: "no-anon-key" })); return; }
  const H = { apikey: K, authorization: `Bearer ${K}`, prefer: "count=exact" };

  // ② 抓全店（唔設日期上限），id.asc 全序 + Range 分頁
  const rows = [];
  let claimed = -1;
  const STEP = 500;
  for (let off = 0; ; off += STEP) {
    const url = `${BASE}/pos_orders?select=${SEL}&store_id=eq.${STORE}&order=id.asc`;
    const r = await req(url, { ...H, range: `${off}-${off + STEP - 1}` });
    if (r.status >= 400) { console.log(JSON.stringify({ ok: false, reason: "http", status: r.status, body: r.body.slice(0, 300) })); return; }
    const g = r.cr.match(/\/(\d+)$/);
    if (g) claimed = Number(g[1]);
    const batch = JSON.parse(r.body);
    rows.push(...batch);
    if (batch.length < STEP) break;
    if (rows.length > 5000) break;
  }
  const byId = new Map();
  for (const o of rows) byId.set(o.id, o);
  const all = [...byId.values()];
  console.log(`抓取：Content-Range 聲稱 ${claimed}｜實際抓到 ${all.length}｜去重後 ${byId.size}`);
  if (claimed !== byId.size) console.log(`🔴🔴 唔一致！聲稱 ${claimed} 但去重後 ${byId.size} ⇒ 有漏行或重覆`);

  // ③ 窗口
  const win = all.filter((o) => { const d = macauDay(evOf(o)); return d && d >= FROM && d <= TO; });
  const days = [...new Set(win.map((o) => macauDay(evOf(o))))].sort();
  console.log(`窗口 ${FROM}→${TO}：${win.length} 張，涉日 ${JSON.stringify(days)}`);
  const outOfWin = all.filter((o) => !win.includes(o));
  if (outOfWin.length) console.log(`🔴 窗口外 ${outOfWin.length} 張：${JSON.stringify(outOfWin.map((o) => macauDay(evOf(o))))}`);

  const sold = win.filter((o) => o.status === "settled" || o.status === "paid");
  const legacySold = sold.filter((o) => !o.online_order_id);
  const legacyOrders = win.filter((o) => !o.online_order_id && String(o.status || "").trim() !== "cancelled");

  const avos = (list) => list.reduce((s, o) => s + Math.round((Number(o.total) || 0) * 100), 0);

  // ④ 菜品聚合（SQL 逐字）
  function dish(orders) {
    const g = new Map();
    for (const o of orders) {
      for (const it of Array.isArray(o.items) ? o.items : []) {
        if (!it || typeof it !== "object") continue;
        if (String(it.voided ?? "false") === "true") continue;
        const name = nn(it.name, "(未命名)");
        const key = `${nn(it.menuItemId, "")}|${name}`;
        const cur = g.get(key) || { name, qty: 0, rev: 0 };
        cur.qty += N(it.quantity);
        cur.rev += N(it.price) * N(it.quantity);
        g.set(key, cur);
      }
    }
    return [...g.values()].map((d) => ({
      name: d.name,
      qty: Math.max(0, Math.round(d.qty)),
      revenueAvos: Math.max(0, Math.round(d.rev * 100)),
    })).sort((a, b) => b.revenueAvos - a.revenueAvos || a.name.localeCompare(b.name));
  }
  function dishCh(orders) {
    const g = new Map();
    for (const o of orders) {
      for (const it of Array.isArray(o.items) ? o.items : []) {
        if (!it || typeof it !== "object") continue;
        if (String(it.voided ?? "false") === "true") continue;
        const name = nn(it.name, "(未命名)");
        const key = `${nn(it.menuItemId, "")}|${name}`;
        const c = ch(o);
        const cur = g.get(key) || { name, qty: 0, rev: 0, oq: 0, orv: 0, nq: 0, nrv: 0 };
        const q = N(it.quantity), rv = N(it.price) * N(it.quantity);
        cur.qty += q; cur.rev += rv;
        if (c === "offline") { cur.oq += q; cur.orv += rv; } else { cur.nq += q; cur.nrv += rv; }
        g.set(key, cur);
      }
    }
    return [...g.values()].map((d) => ({
      name: d.name,
      qty: Math.max(0, Math.round(d.qty)),
      revenueAvos: Math.max(0, Math.round(d.rev * 100)),
      offlineQty: Math.max(0, Math.round(d.oq)),
      offlineRevenueAvos: Math.max(0, Math.round(d.orv * 100)),
      onlineQty: Math.max(0, Math.round(d.nq)),
      onlineRevenueAvos: Math.max(0, Math.round(d.nrv * 100)),
    })).sort((a, b) => b.revenueAvos - a.revenueAvos || a.name.localeCompare(b.name));
  }

  const dOld = dish(legacySold);
  const dNew = dishCh(sold);
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);

  // ⑤ 恒等式
  const checks = [];
  const ck = (name, got, want) => checks.push({ name, got, want, pass: got === want });

  ck("全店 rows", all.length, 94);
  ck("窗口 rows", win.length, 94);
  ck("settled/paid（全渠道）", sold.length, 93);
  ck("kpi.orderCount（v1）", legacySold.length, avos(legacySold) > 0 ? legacySold.length : -1);
  ck("kpi.revenueAvos（v1）", avos(legacySold), 547100);
  ck("ordersTotal（v1）", legacyOrders.length, 74);
  ck("ordersByChannelTotal（全渠道）", win.filter((o) => String(o.status || "").trim() !== "cancelled").length, 93);
  ck("dishesTotal", dOld.length, 58);
  ck("dishes Σqty", sum(dOld, (x) => x.qty), 198);
  ck("dishes Σrev", sum(dOld, (x) => x.revenueAvos), 549900);
  ck("dishesByChannelTotal", dNew.length, 63);
  ck("dishesByChannel Σqty", sum(dNew, (x) => x.qty), 225);
  ck("dishesByChannel Σrev", sum(dNew, (x) => x.revenueAvos), 667600);
  ck("拆欄數量守恆（全部行）", dNew.filter((x) => x.offlineQty + x.onlineQty === x.qty).length, dNew.length);
  ck("拆欄金額守恆（全部行）", dNew.filter((x) => x.offlineRevenueAvos + x.onlineRevenueAvos === x.revenueAvos).length, dNew.length);
  // 🔴🔴 正確關係（2026-10-07 產勘推翻咗舊契約寫法）：
  //   舊 `dishes[]`  = `online_order_id is null`  ＝ offline **＋ online_platform**（平台單冇 online_order_id）
  //   `dishesByChannel[].offline*` = 純 offline channel（channel = 'offline'）
  //   ⇒ 兩者**唔會**逐行相等（旧 dishes[] 仲包埋平台單菜品）。
  //
  // 正確不變量（三條都係單向包含，方向唔可以搞反）：
  //   ① `dishes[]` 嘅名 **全部** 都喺 `dishesByChannel[]` 出現（舊 ⊂ 新）
  //   ② `dishesByChannel[]` 可以有多出嚟嘅名（純線上投影菜品，實測 5 款）
  //   ③ 同名行：`dishes[].qty >= dishesByChannel[].offlineQty`（因為舊 = offline + platform）
  const legacyByName = new Map(dOld.map((x) => [x.name, x]));
  const newByName = new Map(dNew.map((x) => [x.name, x]));
  const legacyMiss = dOld.filter((x) => !newByName.has(x.name));
  const onlyOnline = dNew.filter((x) => !legacyByName.has(x.name));
  const overlap = dNew.filter((x) => legacyByName.has(x.name));
  ck("舊 dishes[] 每個名都喺 dishesByChannel[] 出現（舊 ⊂ 新）", legacyMiss.length, 0);
  ck("dishesByChannel[] 多出嘅名全部 offlineQty=0（純線上菜）",
    onlyOnline.filter((x) => x.offlineQty === 0 && x.offlineRevenueAvos === 0).length, onlyOnline.length);
  ck("同名行：dishes[].qty >= dishesByChannel[].offlineQty（全部行）",
    overlap.filter((x) => legacyByName.get(x.name).qty >= x.offlineQty).length, overlap.length);
  ck("同名行：dishes[].revenueAvos >= dishesByChannel[].offlineRevenueAvos（全部行）",
    overlap.filter((x) => legacyByName.get(x.name).revenueAvos >= x.offlineRevenueAvos).length, overlap.length);
  ck("Σdishes[].qty − ΣofflineQty ＝ 平台單菜品 qty", sum(dOld, (x) => x.qty) - sum(dNew, (x) => x.offlineQty), 14);
  ck("Σdishes[].rev − ΣofflineRev ＝ 平台單菜品 rev", sum(dOld, (x) => x.revenueAvos) - sum(dNew, (x) => x.offlineRevenueAvos), 72700);
  ck("平台單菜品 rev − 平台單 kpi rev ＝ 平台抽成差（對 paymentBreakdown 外賣平台 diffAvos）",
    (sum(dOld, (x) => x.revenueAvos) - sum(dNew, (x) => x.offlineRevenueAvos))
      - avos(win.filter((o) => ch(o) === "online_platform" && (o.status === "settled" || o.status === "paid"))), 2800);
  console.log(`\n（供文件引用）只喺新 key 出現嘅純線上菜品 ${onlyOnline.length} 款：`);
  for (const x of onlyOnline.sort((a, b) => b.revenueAvos - a.revenueAvos)) {
    console.log(`   ${x.name.padEnd(24)} qty=${x.qty} rev=${x.revenueAvos}（全部 onlineQty=${x.onlineQty}）`);
  }
  ck("ordersByChannelTotal − ordersTotal = online_projection 張數",
    win.filter((o) => String(o.status || "").trim() !== "cancelled").length - legacyOrders.length,
    win.filter((o) => ch(o) === "online_projection" && String(o.status || "").trim() !== "cancelled").length);
  ck("kpi.offline + onlinePlatform = v1 kpi",
    avos(win.filter((o) => ch(o) === "offline" && (o.status === "settled" || o.status === "paid")))
      + avos(win.filter((o) => ch(o) === "online_platform" && (o.status === "settled" || o.status === "paid"))),
    547100);
  ck("全渠道 revenue = offline+projection+platform",
    avos(sold),
    avos(win.filter((o) => ch(o) === "offline" && (o.status === "settled" || o.status === "paid")))
      + avos(win.filter((o) => ch(o) === "online_projection" && (o.status === "settled" || o.status === "paid")))
      + avos(win.filter((o) => ch(o) === "online_platform" && (o.status === "settled" || o.status === "paid"))));
  ck("舊 orders[] 出現 online_projection 嘅行數",
    legacyOrders.filter((o) => ch(o) === "online_projection").length, 0);
  ck("舊 dishes[] 冇任何 qty===42", dOld.filter((x) => x.qty === 42).length, 0);
  ck("舊 dishes[] 冇任何 rev===84000", dOld.filter((x) => x.revenueAvos === 84000).length, 0);
  ck("舊 dishes[] 冇任何 rev===108000", dOld.filter((x) => x.revenueAvos === 108000).length, 0);
  ck("全店冇「凍檸茶」", dOld.filter((x) => /檸茶/.test(x.name)).length, 0);
  ck("dishes 排序單調不升", dOld.every((x, i) => i === 0 || dOld[i - 1].revenueAvos >= x.revenueAvos), true);

  console.log("\n=== 恆等式逐條 ===");
  for (const c of checks) {
    console.log(`  ${c.pass ? "OK  " : "🔴 X "} ${c.name.padEnd(44)} got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`);
  }
  const bad = checks.filter((c) => !c.pass);
  console.log(`\n總計 ${checks.length} 條，失敗 ${bad.length} 條`);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    store: STORE,
    range: [FROM, TO],
    days,
    totalRows: all.length,
    claimedByContentRange: claimed,
    v1: { orderCount: legacySold.length, revenueAvos: avos(legacySold), ordersTotal: legacyOrders.length, dishesTotal: dOld.length, dishesSumQty: sum(dOld, (x) => x.qty), dishesSumRevenue: sum(dOld, (x) => x.revenueAvos) },
    allChannel: { settledPaid: sold.length, revenueAvos: avos(sold), ordersByChannelTotal: win.filter((o) => String(o.status || "").trim() !== "cancelled").length, dishesByChannelTotal: dNew.length, dishesSumQty: sum(dNew, (x) => x.qty), dishesSumRevenue: sum(dNew, (x) => x.revenueAvos) },
    dishes: dOld,
    dishesByChannel: dNew,
    failedChecks: bad,
  };
  fs.writeFileSync("tools/_probe-offlinereport-truth-20261007.json", JSON.stringify(snapshot, null, 2), "utf8");
  console.log("\n已寫 tools/_probe-offlinereport-truth-20261007.json");
})();
