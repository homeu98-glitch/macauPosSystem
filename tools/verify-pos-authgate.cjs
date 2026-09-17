/**
 * 驗證 POS 鑑權閘是否已在生產生效（唯讀、只發 GET）。
 *
 * 用途：改完 `POS_REQUIRE_DEVICE_AUTH` 之後確認
 *   ① 受保護端點對「匿名」已經回 401（閘生效）；
 *   ② 設計上要匿名嘅端點（bootstrap / store-status / order-lookup / sequence）**仍然通**，
 *      否則客人掃碼同自助機會即刻落唔到單；
 *   ③ 順手列出「閘生效後可能連帶打斷」嘅端點（device-config → 中繼機拉唔到打印機 IP）。
 *
 * ⚠️ 只做 GET，唔會寫任何資料。唯一例外說明：需要測 POST 時，請用
 *    `--dry-run-post` 以外嘅方式手動評估，唔好喺營業時間向真店 POST 訂單事件。
 *
 * 用法：
 *   node tools/verify-pos-authgate.cjs [storeId]
 */
const STORE_ID = process.argv[2] || "8291f843-9def-4956-9d0b-1cfef2598306";
const BASE = "https://macau-pos-system.vercel.app";

/** 受保護（有 posRouteAuthGuard）→ 閘生效應該回 401。 */
const GUARDED = [
  ["/api/pos/state", "收銀台狀態／訂單拉取"],
  ["/api/pos/shift", "交班"],
  ["/api/pos/orders", "訂單列表"],
  ["/api/pos/print-jobs/status", "打印任務狀態"],
  ["/api/pos/device-config", "⚠️ 裝置／打印機配置（中繼機用呢條）"],
  ["/api/pos/print-agent/pair-status", "中繼配對狀態"],
  ["/api/pos/print-templates", "打印模板"],
  ["/api/pos/note-presets", "備註預設"],
  ["/api/online-order-settings", "線上接單設定"],
];

/**
 * 設計上必須保持匿名（客人掃碼／自助機）→ 閘生效都應該唔係 401。
 *
 * ⚠️ `/api/pos/kiosk-settings` 係 **GET 匿名、只有 POST 需要憑證**
 * （`kiosk-settings/route.ts:119-122` 刻意開放 + rate limit 120/min；`:236-242` 才驗憑證）。
 * 2026-09-17 修：以前呢條被錯誤列入 GUARDED，佢 normal 回 200 會被計成
 * 「受保護端點仍然放行」→ 總結永遠印「閘尚未生效」，產生**假陰性**。
 */
const ANONYMOUS = [
  ["/api/pos/bootstrap", "餐牌 bootstrap（掃碼／自助機入頁靠佢）"],
  ["/api/pos/kiosk-settings", "自助機設定（只有 GET 匿名；POST 需憑證）"],
  ["/api/pos/store-status", "店內營業狀態（客人端顯示）"],
  ["/api/pos/order-lookup", "客人查本枱未結單"],
];

async function probe(path, note) {
  const url = `${BASE}${path}?storeId=${encodeURIComponent(STORE_ID)}`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "abu-authgate-verify/1.0 (+readonly probe)" },
      signal: AbortSignal.timeout(15000),
    });
    let body = "";
    try {
      body = (await res.text()).slice(0, 140).replace(/\s+/g, " ");
    } catch {}
    return { status: res.status, ms: Date.now() - started, body, error: null };
  } catch (e) {
    return { status: 0, ms: Date.now() - started, body: "", error: e?.message ?? String(e) };
  }
}

function verdict(kind, status) {
  if (status === 0) return "⚠️ 連線失敗";
  if (kind === "guarded") {
    if (status === 401) return "✅ 已擋（閘生效）";
    if (status === 200) return "🔴 仍然放行（未生效？未 Redeploy？）";
    return `ℹ️ ${status}`;
  }
  if (status === 401) return "🔴 被擋（客人／自助機會壞）";
  if (status === 200) return "✅ 仍可匿名";
  return `ℹ️ ${status}`;
}

(async () => {
  console.log(`storeId = ${STORE_ID}`);
  console.log(`target  = ${BASE}\n`);

  console.log("=== A. 受保護端點（期望 401）===");
  let guardedOpen = 0;
  for (const [path, note] of GUARDED) {
    const r = await probe(path);
    if (r.status === 200) guardedOpen += 1;
    console.log(
      `${String(r.status).padStart(3)} ${verdict("guarded", r.status).padEnd(34)} ${path}` +
        `  (${r.ms}ms) ${note}`,
    );
    if (r.body) console.log(`      ↳ ${r.body}`);
  }

  console.log("\n=== B. 匿名端點（唔應該 401）===");
  let anonymousBroken = 0;
  for (const [path, note] of ANONYMOUS) {
    const r = await probe(`${path}`, note);
    if (r.status === 401) anonymousBroken += 1;
    console.log(
      `${String(r.status).padStart(3)} ${verdict("anonymous", r.status).padEnd(34)} ${path}` +
        `  (${r.ms}ms) ${note}`,
    );
  }

  console.log("\n=== 總結 ===");
  console.log(`受保護端點仍然 200：${guardedOpen} / ${GUARDED.length}`);
  console.log(`匿名端點被 401：${anonymousBroken} / ${ANONYMOUS.length}`);
  if (guardedOpen === 0) {
    console.log("⇒ 閘已生效：匿名已無法讀寫店舖資料。");
  } else {
    console.log("⇒ 閘尚未生效：請確認 Vercel 已 Redeploy（改 env 唔會套用到現有 deployment）。");
  }
  if (anonymousBroken > 0) {
    console.log("⇒ ⚠️ 有匿名端點被擋：客人掃碼／自助機落單可能已經壞，優先處理。");
  }
})();
