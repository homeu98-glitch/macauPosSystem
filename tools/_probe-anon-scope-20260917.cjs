/**
 * 確認 anon 對 pos_orders 嘅**可讀欄位範圍**。
 *
 * 目的：唔靠猜 —— 直接試讀 `items` / `table_name` / `total`，
 * 睇 anon policy 係「只開部分欄」定「開晒成張表」。
 */
const BASE = "https://macau-pos-system.vercel.app";
const POS = "https://iyrywzormzisyppkokbi.supabase.co";
const REF = "iyrywzormzisyppkokbi";

async function anonKey() {
  const jwtRe = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
  const chunks = new Set();
  for (const r of ["/login", "/staff"]) {
    const html = await (await fetch(BASE + r)).text();
    for (const m of html.matchAll(/\/_next\/static\/[^"'\\\s]+\.js/g)) chunks.add(m[0]);
  }
  for (const cu of chunks) {
    const js = await (await fetch(BASE + cu)).text();
    for (const j of js.match(jwtRe) || []) {
      try {
        const p = JSON.parse(
          Buffer.from(j.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
        );
        if (p.role === "anon" && p.ref === REF) return j;
      } catch {}
    }
  }
  return null;
}

async function tryRead(key, label, query) {
  const res = await fetch(`${POS}/rest/v1/${query}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const n = Array.isArray(body) ? body.length : 0;
  console.log(`\n── ${label}`);
  console.log(`   HTTP ${res.status}${n ? ` （${n} 行）` : ""}`);
  if (Array.isArray(body) && body[0]) {
    const o = body[0];
    console.log(`   欄位: ${Object.keys(o).join(", ")}`);
    console.log(`   樣本: ${JSON.stringify(o).slice(0, 260)}`);
  } else {
    console.log(`   ${JSON.stringify(body).slice(0, 240)}`);
  }
  return res.status;
}

(async () => {
  const key = await anonKey();
  console.log("anon key:", key ? key.slice(0, 26) + "…" : "❌ 抽唔到");
  if (!key) return;

  await tryRead(key, "A. 摘要欄位（對照：確認真係讀得到）",
    "pos_orders?select=local_order_no,status,total&order=created_at.desc&limit=1");

  await tryRead(key, "B. 敏感：枱號 + 金額 + 菜品明細",
    "pos_orders?select=local_order_no,table_name,total,order_note,items&order=created_at.desc&limit=1");

  await tryRead(key, "C. 敏感：會員扣款 / 會員 id",
    "pos_orders?select=local_order_no,member_customer_id,member_deduction_avos&order=created_at.desc&limit=1");

  await tryRead(key, "D. 跨店：有冇 store 過濾（睇 distinct store_id）",
    "pos_orders?select=store_id&limit=30");

  console.log("\n判讀：");
  console.log("  B / C 若回 200 ⇒ anon 讀得到**明細、枱號、會員欄位**（唔止摘要）");
  console.log("  D 若見到多過一個 store_id ⇒ **冇店舖隔離**，一間店讀得到全平台");
})();
