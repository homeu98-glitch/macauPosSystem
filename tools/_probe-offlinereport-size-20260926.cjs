/**
 * 唯讀探測（2026-09-26）：估算「線下報表加訂單明細 + 菜品排名」之後嘅 **payload 規模**。
 *
 * 目的：契約 v1 只回 KPI；今次要加 orders[] 同 dishes[]。
 *      需要真實數字回答「會唔會爆 payload／超 Ledger 3 秒 timeout」。
 *
 * 口徑同 0058 一致：status ∈ {settled,paid}、排除 online_order_id 非空、
 * 日歸屬 = coalesce(settled_at, reopened_at, updated_at, created_at) 轉 Asia/Macau。
 *
 * ⚠️ anon 讀取窗只有 72 小時 ⇒ 只能實測「近 3 日」，再按日推算 90 日。
 */
const https = require("node:https");

function get(url, headers) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) } }, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => res({ status: r.statusCode, body: d }));
    }).on("error", rej);
  });
}

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const SITE = "https://macau-pos-system.vercel.app";
const REF = "iyrywzormzisyppkokbi";
const MAIN_STORE = "8291f843-9def-4956-9d0b-1cfef2598306";

const COLS = [
  "id",
  "local_order_no",
  "table_id",
  "table_name",
  "status",
  "items",
  "subtotal",
  "tax_amount",
  "service_charge_amount",
  "discount_amount",
  "total",
  "payment_method",
  "party_size",
  "created_at",
  "settled_at",
  "reopened_at",
  "updated_at",
  "source",
  "external_order_id",
].join(",");

function macauDayKey(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "(bad)";
  return new Date(t + 8 * 3600_000).toISOString().slice(0, 10);
}

function eventInstant(o) {
  for (const raw of [o.settled_at, o.reopened_at, o.updated_at, o.created_at]) {
    if (typeof raw === "string" && raw.trim() && raw !== "0") {
      const t = Date.parse(raw);
      if (Number.isFinite(t) && t > 0) return t;
    }
  }
  return 0;
}

function bytes(v) {
  return Buffer.byteLength(JSON.stringify(v), "utf8");
}

(async () => {
  const chunks = new Set();
  for (const p of ["/prints", "/pos"]) {
    try {
      const r = await get(SITE + p);
      (r.body.match(/\/_next\/static\/[^"'\\\s]+\.js/g) || []).forEach((s) => chunks.add(s));
    } catch {}
  }
  let K = "";
  for (const s of chunks) {
    try {
      const r = await get(SITE + s);
      const m = r.body.match(JWT);
      if (m && m.length) {
        K = m[0];
        break;
      }
    } catch {}
  }
  if (!K) {
    console.log("❌ 抽唔到 anon key");
    return;
  }
  console.log(`anon key: ${K.slice(0, 24)}… (${K.length} chars)\n`);

  const url =
    `https://${REF}.supabase.co/rest/v1/pos_orders` +
    `?select=${COLS}&store_id=eq.${MAIN_STORE}&order=created_at.desc&limit=2000`;

  const r = await get(url, { apikey: K, authorization: `Bearer ${K}` });
  console.log(`HTTP ${r.status}  body ${(r.body.length / 1024).toFixed(1)} KB`);
  if (r.status !== 200) {
    console.log(r.body.slice(0, 600));
    return;
  }
  const rows = JSON.parse(r.body);
  console.log(`拉到 ${rows.length} 行（anon 72h 窗）\n`);

  // ── 逐澳門日：線下可計銷售單 ──
  const byDay = new Map();
  let offlineCount = 0;
  let itemTotal = 0;
  const headerBytes = [];
  const withItemsBytes = [];
  const dishAgg = new Map();

  for (const o of rows) {
    if (o.online_order_id) continue;
    if (o.status !== "settled" && o.status !== "paid") continue;
    const ts = eventInstant(o);
    if (!ts) continue;
    const day = macauDayKey(new Date(ts).toISOString());
    const cur = byDay.get(day) || { offline: 0, online: 0, items: 0 };
    cur.offline += 1;

    const items = Array.isArray(o.items) ? o.items : [];
    cur.items += items.length;

    // 候選「明細單頭」欄位（照 POS 報表 OrderDetailRow 精神，去掉本機才有嘅欄）
    const header = {
      id: o.id,
      orderNo: o.local_order_no,
      table: o.table_name || o.table_id,
      status: o.status,
      receivableAvos: Math.round(
        ((items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 0), 0) || 0) +
          (Number(o.service_charge_amount) || 0) +
          (Number(o.tax_amount) || 0)) *
          100,
      ),
      paidAvos: Math.round((Number(o.total) || 0) * 100),
      discountAvos: Math.round((Number(o.discount_amount) || 0) * 100),
      method: o.payment_method ?? null,
      partySize: o.party_size ?? null,
      itemCount: items.length,
      settledAt: o.settled_at ?? o.reopened_at ?? o.updated_at ?? o.created_at ?? null,
    };
    headerBytes.push(bytes(header));
    withItemsBytes.push(
      bytes({
        ...header,
        items: items.map((it) => ({
          menuItemId: it.menuItemId ?? null,
          name: it.name ?? null,
          qty: Number(it.quantity) || 0,
          priceAvos: Math.round((Number(it.price) || 0) * 100),
          voided: !!it.voided,
          specs: (it.selectedSpecs || []).map((s) => s.optionLabel),
        })),
      }),
    );

    offlineCount += 1;
    itemTotal += items.length;

    for (const it of items) {
      if (it.voided) continue;
      const key = `${it.menuItemId ?? it.name}|${it.name}`;
      const d = dishAgg.get(key) || { key, name: it.name, qty: 0, revenueAvos: 0 };
      const q = Number(it.quantity) || 0;
      d.qty += q;
      d.revenueAvos += Math.round((Number(it.price) || 0) * q * 100);
      dishAgg.set(key, d);
    }
    byDay.set(day, cur);
  }

  console.log("── 逐澳門日（線下可計銷售單）──");
  for (const [day, v] of [...byDay.entries()].sort()) {
    console.log(`  ${day}  線下 ${String(v.offline).padStart(3)} 張  平均 ${(v.items / (v.offline || 1)).toFixed(1)} 行/張`);
  }

  const days = [...byDay.values()];
  const avgPerDay = offlineCount / (days.length || 1);
  const avgItemsPerOrder = itemTotal / (offlineCount || 1);
  const avgHeader = headerBytes.reduce((a, b) => a + b, 0) / (headerBytes.length || 1);
  const avgWithItems = withItemsBytes.reduce((a, b) => a + b, 0) / (withItemsBytes.length || 1);
  const maxHeader = Math.max(...headerBytes);
  const maxWithItems = Math.max(...withItemsBytes);

  console.log(`\n── 結構統計（近 ${days.length} 日，線下 ${offlineCount} 張）──`);
  console.log(`  平均 ${avgPerDay.toFixed(1)} 張/日`);
  console.log(`  平均 ${avgItemsPerOrder.toFixed(2)} 行菜品/張`);
  console.log(`  明細單頭：平均 ${avgHeader.toFixed(0)} B/張、最大 ${maxHeader} B`);
  console.log(`  連逐項菜品：平均 ${avgWithItems.toFixed(0)} B/張、最大 ${maxWithItems} B`);
  console.log(`  菜品排名：${dishAgg.size} 款`);

  // ── 90 日外推 ──
  const N90 = Math.round(avgPerDay * 90);
  const dishesBytes = bytes(
    [...dishAgg.values()].sort((a, b) => b.qty - a.qty).map((d) => ({
      name: d.name,
      qty: d.qty,
      revenueAvos: d.revenueAvos,
    })),
  );
  const kpiBytes = 700; // 現有 v1 payload 實測級數

  console.log("\n── 90 日外推（最壞情況：全期都有單）──");
  console.log(`  預計線下單數 ≈ ${N90} 張`);
  console.log(`  方案 A（只回單頭）      ≈ ${((N90 * avgHeader) / 1024).toFixed(0)} KB`);
  console.log(`  方案 B（單頭 + 逐項）    ≈ ${((N90 * avgWithItems) / 1024).toFixed(0)} KB`);
  console.log(`  菜品排名（現時款數 ×90 日推）≈ ${(dishesBytes / 1024).toFixed(1)} KB`);
  console.log(`  現有 v1 KPI payload      ≈ ${(kpiBytes / 1024).toFixed(1)} KB`);
  console.log(
    `\n  ⇒ A 總計 ≈ ${((kpiBytes + N90 * avgHeader + dishesBytes) / 1024).toFixed(0)} KB` +
      `　B 總計 ≈ ${((kpiBytes + N90 * avgWithItems + dishesBytes) / 1024).toFixed(0)} KB`,
  );

  // ── 抽樣一張單睇實際 JSON ──
  console.log("\n── 抽樣：最新一張線下單嘅 items 形狀 ──");
  const sample = rows.find((o) => !o.online_order_id && (o.status === "settled" || o.status === "paid"));
  if (sample) {
    const its = Array.isArray(sample.items) ? sample.items : [];
    console.log(`  ${sample.local_order_no}  status=${sample.status}  items=${its.length}`);
    if (its[0]) console.log(`  第 1 行 raw: ${JSON.stringify(its[0]).slice(0, 420)}`);
  }
})();
