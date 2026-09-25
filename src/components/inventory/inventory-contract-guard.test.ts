import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * 《庫存模組》契約守衛（2026-09-25）。
 *
 * ## 背景（實案，唔係假想）
 *
 * 1. **品名欄被壓到 0 寬**：`fieldCls` 內含 `w-full`，品項 row 以前寫
 *    `` `${fieldCls} w-28` `` —— 邊個生效取決於 Tailwind 產生 CSS 嘅**先後**
 *    （實測 idx `w-28`=4693 < `w-full`=4745 ⇒ `w-full` 勝）⇒ 品名欄實寬 0。
 * 2. **供應商 duplicate key**：`merchants.name` 係**全表唯一**，而 POS 用
 *    `onConflict:"user_id, name"` ⇒ 兩間店唔可以各自有同名供應商。
 * 3. **「睇唔到有月結」**：付款方式以前係 POS 硬編碼常數，且篩選 chip 由
 *    「當前資料出現過嘅付款方式」反推 ⇒ 當月結收據 = 0 張，chip 完全唔出現。
 * 4. **支付方式主檔**：改為 admin 統一設置 → POS 經
 *    `GET /api/inventory/payment-methods` 讀，唔可以再喺介面硬編碼清單。
 *
 * ## 掃原始碼前一定要剝註釋
 * 呢個檔自己嘅註解就提及 `${fieldCls} w-28`，唔剝會自己撞自己
 * （本專案已中過最少兩次，見 `build-header-contract.test.ts`）。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** repo 根（呢個檔喺 `src/components/inventory/`）。 */
const ROOT = path.resolve(HERE, "..", "..", "..");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function read(rel: string): string {
  return stripComments(readFileSync(path.join(ROOT, rel), "utf8"));
}

const VIEW = "src/components/inventory/inventory-view.tsx";
const PANEL = "src/components/inventory/inventory-settings-panel.tsx";
const STATS = "src/lib/inventory-stats.ts";
const MERCHANTS = "src/app/api/inventory/merchants/route.ts";
const METHODS_API = "src/app/api/inventory/payment-methods/route.ts";
const ITEMS_API = "src/app/api/inventory/receipt-items/route.ts";

describe("品項 row：唔可以再出現 w-full 同 w-<number> 打架", () => {
  it("庫存頁原始碼唔可以有 `${…Cls} w-<number>` 寫法", () => {
    const src = read(VIEW);
    // 例如 `${fieldCls} w-28` / `${fieldCls} w-20`
    const bad = /\$\{[^}]*[Cc]ls\}\s+w-\d/.test(src);
    assert.equal(bad, false, "發現 `${…Cls} w-<number>`：w-full 會壓過 w-<number>（cascade 地雷）");
  });

  it("品項 row 一律用 grid 固定軌寬（flex + 百分比 basis 會搶位）", () => {
    const src = read(VIEW);
    assert.ok(
      /sm:grid-cols-\[minmax\(0,1fr\)_7rem_5rem_auto\]/.test(src),
      "品項 row 要係 sm:grid-cols-[minmax(0,1fr)_7rem_5rem_auto]",
    );
    assert.ok(/col-span-2 min-w-0 sm:col-span-1/.test(src), "品名欄窄螢幕要佔一整行");
  });

  it("品名／單價／數量三個 input 都要有 aria-label（冇 placeholder 當 label 用）", () => {
    const src = read(VIEW);
    assert.equal((src.match(/aria-label=\{`第 \$\{i \+ 1\} 項/g) ?? []).length, 3);
  });
});

describe("供應商欄：下拉選單 + merchant_id", () => {
  it("唔可以再用 datalist 反推收據入面嘅供應商", () => {
    const src = read(VIEW);
    assert.equal(/<datalist/.test(src), false, "datalist 應已由 select（讀 merchants 表）取代");
    assert.equal(/supplier-list/.test(src), false);
  });

  it("收據 payload 要帶 merchant_id（server 直接用 ⇒ 唔行 upsert ⇒ 唔會撞 unique）", () => {
    const src = read(VIEW);
    assert.ok(/merchant_id: form\.merchant_id \|\| undefined/.test(src));
    assert.ok(/merchant_name: form\.merchant_name\.trim\(\) \|\| undefined/.test(src));
  });

  it("供應商清單要由 GET /api/inventory/merchants 讀全量（唔受 range 篩選影響）", () => {
    const src = read(VIEW);
    assert.ok(/\/api\/inventory\/merchants\?account=/.test(src));
    assert.equal(
      /const suppliers = useMemo\(\(\) => \{[\s\S]*?receipts/.test(src),
      false,
      "供應商唔可以再由 receipts 反推（冇收據嘅供應商會消失）",
    );
  });

  it("供應商 CRUD 要收進「設置」面板，主頁唔可以再直接攤出嚟", () => {
    const view = read(VIEW);
    const panel = read(PANEL);
    assert.ok(/<InventorySettingsPanel/.test(view), "主頁要掛住設置面板");
    // 舊寫法：主頁有個標題叫「供應商（新增 / 修改 / 刪除）」嘅 section 直接攤喺中間。
    assert.equal(
      /供應商（新增 \/ 修改 \/ 刪除）/.test(view),
      false,
      "供應商管理區唔應該再掛喺庫存主頁（已搬入設置面板）",
    );
    // 改名 / 刪除嘅 API 呼叫要喺面板，唔喺主頁。
    // ⚠️ 唔可以用 `method: "DELETE"` 做判別 —— 主頁自己刪「收據」都係 DELETE，
    //    要用 URL 路徑區分（merchants vs receipts）。
    assert.ok(/fetch\(`\/api\/inventory\/merchants\/\$\{id\}`/.test(panel), "面板要有改名（PATCH）");
    assert.ok(/method: "DELETE"/.test(panel), "面板要有刪除（DELETE）");
    assert.equal(
      /api\/inventory\/merchants\/\$\{/.test(view),
      false,
      "主頁唔應該再直接改／刪供應商（已搬入設置面板）",
    );
  });

  it("刪除供應商要兩步確認（觸屏誤觸成本高）", () => {
    const panel = read(PANEL);
    assert.ok(/confirmDeleteSupplierId/.test(panel));
    assert.ok(/確定刪除/.test(panel));
  });

  it("新增收據時要可以即時建立供應商（唔使跳出 modal）", () => {
    const view = read(VIEW);
    assert.ok(/createSupplier/.test(view), "收據 modal 要有即時新增供應商");
    // ALREADY_EXISTS 要自動選用而唔係當錯誤（用戶目標係「用呢個供應商」）
    assert.ok(/json\.code === "ALREADY_EXISTS"/.test(view));
  });
});

describe("付款方式：admin 主檔驅動（唔可以再硬編碼）", () => {
  it("唔可以再喺介面寫死付款方式常數", () => {
    const view = read(VIEW);
    assert.equal(
      /const PAYMENT_METHODS = \[/.test(view),
      false,
      "付款方式清單一定要由 admin 主檔嚟（GET /api/inventory/payment-methods）",
    );
    assert.equal(/const METHOD_FILTER_KEYS = \[/.test(view), false, "篩選鍵要由主檔 ∪ 資料動態產生");
  });

  it("收據 modal 嘅付款方式要行 paymentMethodsForScope（scope=purchase）", () => {
    const view = read(VIEW);
    assert.ok(/paymentMethodsForScope\(masterMethods, "purchase"\)/.test(view));
    assert.ok(/paymentMethods=\{purchaseMethods\}/.test(view));
  });

  it("收據 modal 要用 chip 而唔係下拉（觸屏）", () => {
    const view = read(VIEW);
    // 付款方式區塊要用 chipCls 渲染按鈕
    assert.ok(/const chipCls = \(active: boolean\)/.test(view));
    assert.equal(
      /value=\{form\.payment_method\}[\s\S]{0,200}?<option/.test(view),
      false,
      "付款方式唔應該再用 <select>/<option>（觸屏要 chip）",
    );
  });

  it("內建預設要認得 monthly（月結）", () => {
    const src = read(STATS);
    assert.ok(/monthly: "月結"/.test(src), "缺少 monthly → 月結收據只會顯示英文 key");
    assert.ok(/label: "月結"/.test(src), "DEFAULT_PAYMENT_METHODS 要包月結");
  });

  it("主檔讀唔到時要 fallback 內建預設（唔可以令庫存頁爆掉）", () => {
    const src = read(STATS);
    assert.ok(/export const DEFAULT_PAYMENT_METHODS/.test(src));
    const api = read(METHODS_API);
    assert.ok(/methods: DEFAULT_PAYMENT_METHODS/.test(api), "API 讀唔到時要回內建預設");
    assert.ok(/source: "unavailable"/.test(api));
  });

  it("「未設定」同「設定成空清單」一定要分得開（否則 admin 清極都清唔走）", () => {
    // 兩邊（admin 儲存層 + POS 讀取層）都要用 Array.isArray 判斷
    const api = read(METHODS_API);
    assert.ok(/Array\.isArray\(payload\?\.paymentMethods\)/.test(api));
    const src = read(STATS);
    assert.ok(
      /export function normalizePaymentMethods\(raw: unknown\): PaymentMethodDef\[\] \{\s*if \(!Array\.isArray\(raw\)\) return DEFAULT_PAYMENT_METHODS;/.test(
        src,
      ),
      "normalizePaymentMethods：唔係陣列才回預設，空陣列要照用",
    );
  });

  it("中文標籤要同 canonical key 互通（expenseRecorder 舊資料有機會直接存中文）", () => {
    const src = read(STATS);
    assert.ok(/export function normalizePaymentMethod/.test(src));
    assert.ok(/export function normalizePaymentStatus/.test(src));
    assert.ok(/月結/.test(src) && /已付款/.test(src));
  });

  it("收據讀取／寫入都要行 normalizer（否則篩選同 paid/unpaid 會靜默計錯）", () => {
    const list = read("src/app/api/inventory/receipts/route.ts");
    assert.ok(/payment_method: normalizePaymentMethod\(getRaw\("payment_method"\)\)/.test(list));
    assert.ok(/payment_status: normalizePaymentStatus\(getRaw\("payment_status"\)\)/.test(list));
    const patch = read("src/app/api/inventory/receipts/[id]/route.ts");
    assert.ok(/raw\.payment_method = normalizePaymentMethod\(/.test(patch));
    assert.ok(/raw\.payment_status = normalizePaymentStatus\(/.test(patch));
  });

  it("篩選 chip = 主檔全部 code ∪ 當前資料出現過嘅 code", () => {
    const view = read(VIEW);
    assert.ok(/for \(const m of masterMethods\) push\(m\.code\)/.test(view), "主檔 code 一定要有 chip");
    assert.ok(
      /for \(const r of receipts\) push\(normalizePaymentMethod\(r\.payment_method\)\)/.test(view),
      "資料出現過嘅 code 亦要保留（admin 停用後舊單據仍要篩得到）",
    );
  });

  it("付款方式冇收據時 chip 一樣要出現（0 張都顯示）", () => {
    const src = read(VIEW);
    assert.ok(/methodCounts\.get\(m\) \?\? 0/.test(src));
    assert.ok(!/filter\(\([^)]*\) => \(methodCounts\.get/.test(src), "唔可以因為 0 張就隱藏 chip");
  });

  it("篩選後 KPI 要跟住重算（用 buildPurchaseSummary，唔可以繼續用 server 全量 summary）", () => {
    const src = read(VIEW);
    assert.ok(/buildPurchaseSummary\(visibleReceipts\)/.test(src));
  });

  it("舊單據嘅付款方式唔喺主檔時，要顯示得到而唔係變裸英文／靜靜被改走", () => {
    const view = read(VIEW);
    assert.ok(/!paymentMethods\.some\(\(m\) => m\.code === form\.payment_method\)/.test(view));
    assert.ok(/labelMap\[form\.payment_method\] \?\? form\.payment_method/.test(view));
  });
});

describe("品項快速選取（歷史品項）", () => {
  it("要有獨立的歷史品項 API，唔可以靠當前 range 反推", () => {
    const api = read(ITEMS_API);
    assert.ok(/export async function GET/.test(api));
    assert.ok(/\.eq\("user_id", resolved\.userId\)/.test(api), "一定要以 user_id 做店別 scope");
    assert.ok(/order\("created_at", \{ ascending: false \}\)/.test(api), "要按時間新→舊");
  });

  it("撳建議要用 onPointerDown + preventDefault（onClick 永遠撳唔到）", () => {
    const view = read(VIEW);
    assert.ok(
      /onPointerDown=\{\(e\) => \{\s*e\.preventDefault\(\);/.test(view),
      "input 會先 blur，onBlur 收埋清單 ⇒ 一定要用 onPointerDown + preventDefault",
    );
  });

  it("自動填價唔可以蓋走用戶已改嘅單價", () => {
    const view = read(VIEW);
    assert.ok(/unit_price: form\.items\[i\]\?\.unit_price\?\.trim\(\)/.test(view));
  });
});

describe("品類：納入「設置」，並要頂得住 whitelist normalize", () => {
  it("PosLocalSettings 要有 invCategories", () => {
    assert.ok(/invCategories: string\[\]/.test(read("src/lib/types.ts")));
  });

  it("defaultPosLocalSettings 要帶 invCategories", () => {
    assert.ok(/invCategories: \[\]/.test(read("src/lib/mock-data.ts")));
  });

  it("🔴 normalizePosLocalSettings 一定要白名單帶返 invCategories（漏咗會被靜靜剷走）", () => {
    const storage = read("src/lib/storage.ts");
    assert.ok(
      /invCategories: Array\.isArray\(settings\?\.invCategories\)/.test(storage),
      "storage.ts 逐欄重建 PosLocalSettings，漏咗 invCategories 就會 reload 時被剷走",
    );
  });

  it("品類要喺設置面板管理，並喺新增收據時可揀", () => {
    const panel = read(PANEL);
    assert.ok(/categories: string\[\]/.test(panel));
    assert.ok(/onSaveCategories/.test(panel));
    const view = read(VIEW);
    assert.ok(/categoryOptions/.test(view), "收據 modal 要有品類選項");
  });

  it("舊收據嘅自由文字品類唔可以喺選單消失（否則一儲存就被改走）", () => {
    const view = read(VIEW);
    assert.ok(/if \(current && !list\.includes\(current\)\) list\.push\(current\)/.test(view));
  });
});

describe("merchants API：duplicate key 要轉做中文明確提示", () => {
  it("POST 要捕捉 23505 / 42P10，並區分 ALREADY_EXISTS 同 NAME_TAKEN", () => {
    const src = read(MERCHANTS);
    assert.ok(/ALREADY_EXISTS/.test(src));
    assert.ok(/NAME_TAKEN/.test(src));
    assert.ok(/23505/.test(src) && /42P10/.test(src));
  });

  it("NAME_TAKEN（跨店同名）唔可以回傳嗰個 supplier id（唔畀掛起第二間店）", () => {
    const src = read(MERCHANTS);
    const nameTakenBlock = /code: "NAME_TAKEN"[\s\S]{0,400}/.exec(src)?.[0] ?? "";
    assert.ok(nameTakenBlock.length > 0, "搵唔到 NAME_TAKEN 分支");
    assert.equal(/merchant:/.test(nameTakenBlock), false, "NAME_TAKEN 唔可以帶 merchant id");
  });

  it("要有 GET（全量供應商）先至有 dropdown 資料來源", () => {
    const src = read(MERCHANTS);
    assert.ok(/export async function GET/.test(src));
    assert.ok(/eq\("user_id", resolved\.userId\)/.test(src), "GET 一定要以 user_id 做店別 scope");
  });

  it("🔴 要濾走 expenseRecorder 嘅保留名（__shop_settings__ / __global_settings__）", () => {
    const src = read(MERCHANTS);
    assert.ok(/isReservedMerchantName/.test(src));
    assert.ok(/name\.startsWith\("__"\)/.test(src), "保留名一律 __ 開頭，要濾走");
    assert.ok(
      /\.filter\(\(m\) => m\.id && m\.name && !isReservedMerchantName\(m\.name\)\)/.test(src),
      "GET 回傳前一定要過濾，否則下拉會出現假供應商",
    );
  });

  it("保留名唔可以用嚟做供應商名（要喺入口擋，唔好等 unique 衝突）", () => {
    const src = read(MERCHANTS);
    assert.ok(/name\.startsWith\("__"\)/.test(src));
    assert.ok(/不可以「__」開頭/.test(src));
  });

  it("表／欄未就緒（42P01 / 42703）要降級而唔係 500", () => {
    assert.ok(/export function isMissingColumnOrTable/.test(read("src/lib/expense-inventory.ts")));
    assert.ok(/isMissingColumnOrTable\(/.test(read(MERCHANTS)));
  });
});
