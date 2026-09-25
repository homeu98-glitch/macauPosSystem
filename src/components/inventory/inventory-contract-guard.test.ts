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
    // 2026-09-26：數量由純輸入框改成 stepper ⇒ 數量軌由 5rem 加闊到 10rem。
    assert.ok(
      /sm:grid-cols-\[minmax\(0,1fr\)_7rem_10rem_auto\]/.test(src),
      "品項 row 要係 sm:grid-cols-[minmax(0,1fr)_7rem_10rem_auto]",
    );
    assert.ok(/col-span-2 min-w-0 sm:col-span-1/.test(src), "品名欄窄螢幕要佔一整行");
  });

  it("品名／單價／數量三個欄都要有 aria-label（冇 placeholder 當 label 用）", () => {
    const src = read(VIEW);
    // 收窄到逐個欄名：數量 stepper 嘅「＋／−」按鈕都帶「第 N 項數量…」前綴，
    // 用舊嘅寬鬆寫法會數到 5 個（假紅）。呢度逐個精確比對。
    assert.equal((src.match(/aria-label=\{`第 \$\{i \+ 1\} 項品名`\}/g) ?? []).length, 1);
    assert.equal((src.match(/aria-label=\{`第 \$\{i \+ 1\} 項單價`\}/g) ?? []).length, 1);
    assert.equal((src.match(/aria-label=\{`第 \$\{i \+ 1\} 項數量`\}/g) ?? []).length, 1);
  });

  it("數量要有 stepper（− / ＋），下限 0 而且唔會出負數", () => {
    const src = read(VIEW);
    assert.ok(/const stepQty = \(i: number, delta: number\)/.test(src), "要有 stepQty");
    assert.ok(/Math\.max\(0, Math\.round\(\(base \+ delta\) \* 1000\) \/ 1000\)/.test(src), "下限 0、保留三位小數");
    assert.ok(/aria-label=\{`第 \$\{i \+ 1\} 項數量減一`\}/.test(src));
    assert.ok(/aria-label=\{`第 \$\{i \+ 1\} 項數量加一`\}/.test(src));
  });

  it("收據日期要係 chips（今天／昨天／選日期…），唔可以一開頭就係原生 date input", () => {
    const src = read(VIEW);
    assert.ok(/const yesterdayStr = \(\) =>/.test(src), "要有 yesterdayStr()");
    assert.ok(/label: "今天", value: todayStr\(\)/.test(src));
    assert.ok(/label: "昨天", value: yesterdayStr\(\)/.test(src));
    assert.ok(/選日期…/.test(src));
    assert.ok(/showDatePicker/.test(src), "日曆要收起直到撳「選日期…」");
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

  it("付款方式冇收據時 chip 一樣要出現（0 張都仍然撳得到）", () => {
    const src = read(VIEW);
    assert.ok(/methodCounts\.get\(key\) \?\? 0/.test(src));
    // 2026-09-26：確認稿只顯示「有資料」嘅付款方式，所以零筆數嘅改為默認收埋
    // —— 但**唔係刪走**：仍然要 (a) 撳得到展開、(b) 當前選中嘅唔准收埋。
    // 呢兩點就係守住 2026-09-25「睇唔到有月結」原 bug 嘅防線。
    assert.equal(
      /filter\(\(?[^)]*\)?\s*=>\s*\(?methodCounts\.get/.test(src),
      false,
      "唔可以真係 filter 走 0 張嘅 chip（會令商家以為系統冇呢個付款方式）",
    );
    assert.ok(/count > 0 \|\| key === methodFilter/.test(src), "選中嘅 chip 唔准收埋");
    assert.ok(/methodChipGroups\.zero\.length > 0/.test(src), "零筆數嘅要有展開入口");
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

/* ══════════════════════════════════════════════════════════════════════════
 * 2026-09-26：對齊確認稿 `docs/mockups/inventory-ux-5items-2026-09-25.html`
 * 商家當日問「為什麼 UI 跟你畫的差那麼遠?」之後嘅收口。
 * 呢批守衛嘅目的係：確認稿講好嘅四點（4 個 chips／兩個 panel 並排／
 * 「用過 N 次」／拖 ⠿ 排序）唔會再無聲被簡化返。
 * ══════════════════════════════════════════════════════════════════════════ */

const USAGE_API = "src/app/api/inventory/master-usage/route.ts";
const ORDER_LIB = "src/lib/inventory-order.ts";

describe("設置面板：對齊確認稿（4 個 chips ＋ 兩個 panel 並排）", () => {
  it("要有 4 個區塊：供應商／品類／庫存品／支付方式顯示", () => {
    const panel = read(PANEL);
    assert.ok(/type PanelId = "supplier" \| "category" \| "product" \| "payment"/.test(panel));
    assert.ok(
      /const PANEL_ORDER: PanelId\[\] = \["supplier", "category", "product", "payment"\]/.test(panel),
    );
    for (const label of ["供應商", "品類", "庫存品", "支付方式顯示"]) {
      assert.ok(panel.includes(label), `PANEL_LABEL 缺少「${label}」`);
    }
  });

  it("預設要同時開住「供應商 ＋ 品類」，並且兩個 panel 並排（唔係單選 tab）", () => {
    const panel = read(PANEL);
    assert.ok(/supplier: true,\s*category: true/.test(panel), "預設要開供應商＋品類");
    assert.ok(/md:grid-cols-2/.test(panel), "兩個 panel 要並排");
    // 舊寫法係單選 tab（`tab === t.id`）—— 已經唔可以返去，否則冇得同時睇兩個主檔。
    assert.equal(/const \[tab, setTab\]/.test(panel), false, "唔可以返去單選 tab");
  });

  it("最少要留一個 panel（全部關咗個彈窗會一片空白）", () => {
    const panel = read(PANEL);
    assert.ok(/if \(!PANEL_ORDER\.some\(\(k\) => next\[k\]\)\) return cur;/.test(panel));
  });

  it("「庫存品」panel 要掛現成 InventoryTable（唔可以另寫一套 CRUD）", () => {
    const panel = read(PANEL);
    assert.ok(/import \{ InventoryTable \} from "\.\/inventory-table"/.test(panel));
    assert.ok(/<InventoryTable[\s\S]{0,200}?embedded/.test(panel));
  });

  it("🔴「支付方式顯示」係唯讀：面板唔可以直接寫主檔（主檔歸 expenseRecorder admin）", () => {
    const panel = read(PANEL);
    assert.equal(
      /payment-methods/.test(panel),
      false,
      "支付方式 panel 只可以顯示 props，唔可以呼叫 payment-methods API 寫入",
    );
    const view = read(VIEW);
    assert.ok(/paymentMethods=\{masterMethods\}/.test(view), "主頁要把完整主檔交落面板");
    assert.equal(
      /fetch\(`\/api\/inventory\/payment-methods`[\s\S]{0,120}?method: "(POST|PATCH|DELETE)"/.test(view),
      false,
      "POS 唔可以寫支付方式主檔",
    );
  });

  it("彈窗要保留（商家拍板），但唔可以有「保存」按鈕（改動即時寫入，會誤導）", () => {
    const panel = read(PANEL);
    assert.ok(/fixed inset-0 z-50/.test(panel), "設置要保持彈窗");
    assert.ok(/完成/.test(panel), "右上角應該係「完成」");
    assert.equal(/保存/.test(panel), false, "每項操作都即時寫入，唔可以有「保存」製造錯誤預期");
  });
});

describe("拖 ⠿ 排序：次序要落 PosLocalSettings 白名單", () => {
  it("PosLocalSettings 要有 invSupplierOrder / invCategoryOrder", () => {
    const types = read("src/lib/types.ts");
    assert.ok(/invSupplierOrder: string\[\]/.test(types));
    assert.ok(/invCategoryOrder: string\[\]/.test(types));
  });

  it("defaultPosLocalSettings 要帶兩個新欄", () => {
    const mock = read("src/lib/mock-data.ts");
    assert.ok(/invSupplierOrder: \[\]/.test(mock));
    assert.ok(/invCategoryOrder: \[\]/.test(mock));
  });

  it("🔴 normalizePosLocalSettings 一定要白名單帶返（漏咗 = 拖完一 reload 彈返字母序）", () => {
    const storage = read("src/lib/storage.ts");
    assert.ok(/sanitizeKeyList\(settings\?\.invSupplierOrder\)/.test(storage));
    assert.ok(/sanitizeKeyList\(settings\?\.invCategoryOrder\)/.test(storage));
  });

  it("面板要有 pointer 拖拽（mouse + 觸屏同一套）＋ touch-action:none", () => {
    const panel = read(PANEL);
    assert.ok(/function beginDrag\(/.test(panel));
    assert.ok(/function moveDrag\(/.test(panel));
    assert.ok(/function endDrag\(/.test(panel));
    assert.ok(/setPointerCapture/.test(panel));
    assert.ok(/touch-none/.test(panel), "把手要 touch-action:none，否則手指拖動會被當成捲動");
    assert.ok(/data-drag-row/.test(panel), "行要標記 data-drag-row 先量得到中線");
  });

  it("排序要即時寫入 PosLocalSettings（唔可以只喺本機 state）", () => {
    const view = read(VIEW);
    assert.ok(/onSaveSupplierOrder/.test(view));
    assert.ok(/onSaveCategoryOrder/.test(view));
    assert.ok(/invSupplierOrder: next/.test(view));
    assert.ok(/invCategoryOrder: next/.test(view));
  });

  it("收據 modal 嘅供應商／品類要跟同一份次序（否則設置排好都冇用）", () => {
    const view = read(VIEW);
    assert.ok(/reorderByStored\(categories, categoryOrder/.test(view));
    assert.ok(/reorderByStored\(suppliers, supplierOrder/.test(view));
    assert.ok(/suppliers=\{orderedSuppliers\}/.test(view));
    assert.ok(/categories=\{orderedCategories\}/.test(view));
  });
});

describe("「用過 N 次」：lazy route，唔可以燒 egress", () => {
  it("要有 master-usage route，並以 user_id 做店別 scope", () => {
    const src = read(USAGE_API);
    assert.ok(/export async function GET/.test(src));
    assert.ok(/eq\("user_id", resolved\.userId\)/.test(src));
  });

  it("🔴 只准拉 merchant_id 一個欄，唔可以拉 raw_ocr_data（mg 級 egress）", () => {
    const src = read(USAGE_API);
    assert.ok(/\.select\("merchant_id"/.test(src));
    assert.equal(/raw_ocr_data/.test(src), false, "唔准拉 raw_ocr_data 落 server 只為數次數");
  });

  it("要有上限，並喺回應講明係「近期」（唔可以扮成總數）", () => {
    const src = read(USAGE_API);
    assert.ok(/const SCAN_LIMIT = \d+/.test(src));
    assert.ok(/\.limit\(SCAN_LIMIT\)/.test(src));
    assert.ok(/capped/.test(src));
  });

  it("表未就緒要降級（唔可以令設置面板爆掉）", () => {
    assert.ok(/isMissingColumnOrTable/.test(read(USAGE_API)));
  });

  it("面板要 lazy fetch：只喺供應商 panel 開住嘅時候先叫", () => {
    const panel = read(PANEL);
    assert.ok(/if \(!open \|\| !visible\.supplier \|\| !account\) return;/.test(panel));
    assert.ok(/\/api\/inventory\/master-usage\?account=/.test(panel));
    // 唔可以跟住主頁輪詢：唔應該喺 inventory-view 出現呢支 API。
    assert.equal(
      /master-usage/.test(read(VIEW)),
      false,
      "用量只喺設置面板內 lazy 拉，唔可以混入主頁載入路徑",
    );
  });

  it("純函式要另開零 import 模組（node --test 唔認 @/ alias）", () => {
    const lib = read(ORDER_LIB);
    assert.equal(/^\s*import /m.test(lib), false, "inventory-order.ts 一定要零 import 先可以被測試直接 import");
    assert.ok(/export function reorderByStored/.test(lib));
    assert.ok(/export function moveWithin/.test(lib));
    assert.ok(/export function sanitizeKeyList/.test(lib));
  });
});

describe("主頁：付款方式 chips 只顯示有資料（但唔可以返去 2026-09-25 嘅 bug）", () => {
  it("要分「有資料」同「零筆數」兩組", () => {
    const view = read(VIEW);
    assert.ok(/const methodChipGroups = useMemo\(/.test(view));
    assert.ok(/const withData: Array<\{ key: string; label: string \}> = \[\]/.test(view));
    assert.ok(/const zero: Array<\{ key: string; label: string \}> = \[\]/.test(view));
  });

  it("🔴 當前已選中嘅 key 一定唔可以收埋（否則會出現「篩選中但冇 chip」）", () => {
    const view = read(VIEW);
    assert.ok(/count > 0 \|\| key === methodFilter/.test(view));
  });

  it("零筆數嘅要留一個展開入口（唔可以真係刪走 → 商家以為冇呢個付款方式）", () => {
    const view = read(VIEW);
    assert.ok(/個未用過/.test(view));
    assert.ok(/showZeroMethods/.test(view));
  });

  it("主頁底部要有確認稿嘅 footnote ＋「前往設置 →」", () => {
    const view = read(VIEW);
    assert.ok(/border-dashed border-slate-300/.test(view));
    assert.ok(/已經收埋入「設置」/.test(view));
    assert.ok(/前往設置 →/.test(view));
  });
});

describe("庫存表兩個 instance 唔可以唔同步", () => {
  it("主頁庫存表要用 key 強制重載（設置 panel 改過之後）", () => {
    const view = read(VIEW);
    assert.ok(/productsVersion/.test(view), "要有重載鑰匙");
    assert.ok(/<InventoryTable key=\{productsVersion\}/.test(view));
    assert.ok(/onProductsChanged=\{\(\) => setProductsVersion\(\(n\) => n \+ 1\)\}/.test(view));
  });

  it("InventoryTable 嘅寫入要通知外層（onMutated）", () => {
    const table = read("src/components/inventory/inventory-table.tsx");
    assert.ok(/onMutated\?: \(\) => void/.test(table));
    // 四個寫入點：從收據同步 / 刪除 / 新增編輯 / 盤點
    assert.equal((table.match(/onMutated\?\.\(\)/g) ?? []).length, 4);
  });
});
