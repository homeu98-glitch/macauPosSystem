"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  loadAuthSession,
  loadDeviceConfig,
  loadPosLocalSettings,
  normalizePosLocalSettings,
  savePosLocalSettings,
} from "@/lib/storage";
import type { PosLocalSettings } from "@/lib/types";
// 🔴 推雲前必須剝走返結 temp 枱（見 `table-scope.ts` 鐵律表：唔剝會永久升級做真實枱）。
import { stripReopenTempTables } from "@/lib/pos/table-scope";
// 🔴 門店設定推雲要帶 POS 終端憑證（會自動續期；`/api/pos/device-config` 已加鑑權閘）。
import { posDeviceAuthHeadersFresh } from "@/lib/pos/pos-sync-auth";
// 主檔顯示次序（拖 ⠿）嘅純函式：設置面板排序 + 收據 modal 嘅品類 chips 都要跟同一份次序。
import { reorderByStored } from "@/lib/inventory-order";
import { REPORT_RANGE_OPTIONS, reportRangeLabel, splitReportRangeArg, type ReportRangeArg, type ReportRangeKey } from "@/lib/ledger/report-period";
import { DateRangeFilterChips } from "@/components/date-range-filter-chips";
import {
  buildPurchaseSummary,
  normalizePaymentMethod,
  paymentMethodLabelMap,
  paymentMethodsForScope,
  DEFAULT_PAYMENT_METHODS,
  type PaymentMethodDef,
  type PurchaseSummary,
} from "@/lib/inventory-stats";
import { AreaChart } from "./charts/AreaChart";
import { DonutChart } from "./charts/DonutChart";
import { LineChart } from "./charts/LineChart";
import { InventoryTable } from "./inventory-table";
import { ItemAnalysisView } from "./item-analysis-view";
import { InventorySettingsPanel, type Supplier } from "./inventory-settings-panel";
import { formatReceiptStamp, isBackdatedReceipt, receiptStampLabel } from "@/lib/receipt-timestamp";
import { compressImage } from "@/lib/image-compress";
import { humanSize } from "@/lib/image-compress-plan";
// 歷史品項建議嘅型別（同 API route 共用；該模組零 import，先可以被 node --test 直接測）。
import type { ItemSuggestion } from "@/lib/inventory-item-suggestions";

type ReceiptItem = {
  id: string;
  name: string;
  unit_price: number;
  quantity: number;
  /** 單位（kg／包／罐…）；舊資料／欄位未補時為空字串。 */
  quantity_unit?: string;
};

type Receipt = {
  id: string;
  total_amount: number;
  receipt_date: string;
  merchant_id?: string | null;
  merchant_name: string;
  payment_method: string;
  payment_status: string;
  category?: string;
  raw_ocr_data?: { receipt_number?: string; payment_method?: string; payment_status?: string; category?: string } | null;
  /**
   * 🔴 錄入時間（`receipts.created_at`，Supabase timestamptz）。
   *
   * 由 `/api/inventory/receipts` 嘅 GET 帶出（`enriched` 組裝時補上）。
   * 2026-10-07 起用嚟顯示「年月日時分秒」—— `receipt_date` 係 date 型別，
   * **本身冇時分秒**，唯一有時分秒嘅來源就係呢個欄位。
   *
   * ⚠️ 舊資料／未部署新版 API 時可能係 `undefined` ⇒ 顯示降級為只出日期。
   */
  created_at?: string | null;
  /**
   * 收據相片（Storage path，**唔係 URL**）。
   *
   * 由 `/api/inventory/receipts` GET 抽自 `raw_ocr_data.photo_paths`。
   * ⚠️ bucket 係 private ⇒ 唔可以直接 `<img src={path}>`，
   *    要經 `/api/inventory/receipt-photos/url` 換 signed URL（見 `ReceiptPhotos`）。
   */
  photo_paths?: string[];
  items: ReceiptItem[];
};

type ReceiptsResponse = {
  ok: boolean;
  matched?: boolean;
  schemaReady?: boolean;
  range?: ReportRangeKey;
  receipts?: Receipt[];
  summary?: PurchaseSummary;
  message?: string;
  error?: string;
};

/*
 * 🔴 歷史品項建議（`GET /api/inventory/receipt-items`）嘅型別 ＝ `ItemSuggestion`，
 *    2026-10-08 起由 `@/lib/inventory-item-suggestions` import 入嚟。
 *    搬去 lib 嘅原因：聚合邏輯一定要可以被 `node --test` 直接測，而嗰個 runner
 *    唔認 `.tsx`／`@/` alias ⇒ 型別同純函式必須一齊擺喺零 import 模組。
 */

const money = (n: number) =>
  `MOP ${Number(n || 0).toLocaleString("zh-MO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const todayStr = () => new Date().toLocaleDateString("en-CA");
/**
 * 昨日（`YYYY-MM-DD`）。
 *
 * ⚠️ 唔可以用 `new Date(Date.now() - 86400000)` 再 `toISOString()`：嗰個係 UTC，
 * 澳門（UTC+8）凌晨 0–8 點會算錯一日。用本地 `Date.setDate()` ＋ `en-CA` 先正確。
 */
const yesterdayStr = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("en-CA");
};

const ALL_METHODS = "all";

/* ---------------- 收據表單（置中 modal，可編輯/刪除） ---------------- */

/**
 * 收據品項行。
 * 🔴 2026-10-06：新增 `unit`（單位，如 kg／包／罐）。舊收據冇此值 ⇒ 空字串，
 * UI 照顯示空框，商家可補填。寫入 expenseRecorder `receipt_items.quantity_unit`。
 */
type FormItem = { name: string; unit_price: string; quantity: string; unit: string };
type FormState = {
  id?: string;
  /** 由下拉選單揀選時帶 id（server 直接用，唔行 upsert ⇒ 唔會撞 unique）。 */
  merchant_id: string;
  /** 手動輸入／新增時用（server 會 upsert 建立）。 */
  merchant_name: string;
  date: string;
  receipt_number: string;
  category: string;
  payment_method: string;
  payment_status: string;
  items: FormItem[];
  /**
   * 已上傳成功嘅相片路徑（expenseRecorder Storage）。
   *
   * 🔴 只放**已經上傳成功**嘅 path —— 未上傳完嘅係 `pendingPhotos`（本地 blob），
   *    兩者分開令「儲存收據」唔使等相片。
   * 🔴 三態語意：提交時**一定**會帶 `photo_paths`（可能係 `[]`）。
   *    帶 `[]` = 商家刪光相片，server 要覆蓋成空（見 PATCH route 嘅 `!== undefined`）。
   */
  photo_paths: string[];
};

/** 本地待上傳相片（已壓縮、未上傳）。`previewUrl` 係 objectURL，用完要 revoke。 */
type PendingPhoto = {
  id: string;
  blob: Blob;
  previewUrl: string;
  /** 壓縮後大小（byte）。顯示用 + 上傳前把關。 */
  size: number;
};

function emptyForm(paymentMethods: PaymentMethodDef[]): FormState {
  return {
    merchant_id: "",
    merchant_name: "",
    date: todayStr(),
    receipt_number: "",
    category: "",
    // 第一個可用嘅進貨付款方式做預設（主檔次序 = 商家想嘅優先次序）。
    payment_method: paymentMethods[0]?.code ?? "on_delivery",
    payment_status: "unpaid",
    items: [{ name: "", unit_price: "", quantity: "1", unit: "" }],
    photo_paths: [],
  };
}

function formFromReceipt(r: Receipt): FormState {
  return {
    id: r.id,
    merchant_id: r.merchant_id ?? "",
    merchant_name: r.merchant_name,
    date: r.receipt_date,
    receipt_number: r.raw_ocr_data?.receipt_number ?? "",
    category: r.category ?? "",
    payment_method: r.payment_method,
    payment_status: r.payment_status,
    items: r.items.length
      ? r.items.map((it) => ({
          name: it.name,
          unit_price: String(it.unit_price),
          quantity: String(it.quantity),
          unit: it.quantity_unit ?? "",
        }))
      : [{ name: "", unit_price: "", quantity: "1", unit: "" }],
    photo_paths: r.photo_paths ?? [],
  };
}

/**
 * 把 Storage path 換成 signed URL（private bucket，唔可以直接 `<img src>`）。
 *
 * 🔴 為何唔喺 GET `/api/inventory/receipts` 就簽好？
 *   清單可能有幾十張收據 × 每張幾張相 ⇒ 幾百次簽名呼叫，但商家根本冇打開睇。
 *   而且 signed URL 有 TTL（1 小時）⇒ 擺喺清單資料度會過期。
 *   ⇒ 按需簽名（打開相片檢視器嘅一刻）。
 *
 * ⚠️ 簽唔到嘅 path **唔會出現喺回傳 map** ⇒ 呼叫方要自己出「無法載入」佔位，
 *    唔可以當佢係空白（否則商家以為冇相）。
 */
function useSignedPhotoUrls(account: string | null, paths: string[]) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  /** path 排序後串埋做 key，避免 array identity 每次都變而無限重跑。 */
  const key = paths.join("\u0000");

  useEffect(() => {
    if (!account || paths.length === 0) {
      setUrls({});
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch(
          `/api/inventory/receipt-photos/url?account=${encodeURIComponent(account)}&paths=${encodeURIComponent(paths.join(","))}`,
        );
        const json = (await res.json()) as { ok?: boolean; urls?: Record<string, string> };
        if (cancelled) return;
        setUrls(json.ok && json.urls ? json.urls : {});
      } catch {
        if (!cancelled) setUrls({});
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // 🔴 deps 用 `key`（字串）而唔係 `paths`（陣列）：陣列每次 render 都係新 identity
    //    ⇒ 直接放 `paths` 會令 effect 每次都重跑 = 無限請求迴圈。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, key]);

  return { urls, loading };
}

/**
 * 已存相片縮圖列（讀取用，private bucket ⇒ 要 signed URL）。
 *
 * 用喺兩處：① 收據卡片（唯讀縮圖，一撳開大圖）；② 收據 modal（可刪）。
 */
function StoredPhotoStrip({
  account,
  paths,
  onRemove,
  onOpen,
  size = "h-16 w-16",
  nowrap = false,
}: {
  account: string | null;
  paths: string[];
  onRemove?: (path: string) => void;
  onOpen?: (path: string) => void;
  size?: string;
  /**
   * `true` = 單行橫向排列（唔換行），由外層 `overflow-x-auto` 捲動。
   *
   * 🔴 收據 modal 內一定要開：modal 高度有限，換行會把下面嘅
   *    品項／合計／儲存掣推出可視範圍（實測被裁切）。
   */
  nowrap?: boolean;
}) {
  const { urls, loading } = useSignedPhotoUrls(account, paths);
  if (paths.length === 0) return null;

  return (
    <div className={nowrap ? "flex shrink-0 flex-nowrap gap-2" : "flex flex-wrap gap-2"}>
      {paths.map((p) => {
        const url = urls[p];
        return (
          <div key={p} className="relative shrink-0">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpen?.(p);
              }}
              className={`block overflow-hidden rounded-xl ring-1 ring-slate-200 ${size} bg-slate-100`}
              aria-label="檢視單據相片"
            >
              {url ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={url} alt="單據相片" className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-[10px] text-slate-400">
                  {loading ? "載入…" : "無法載入"}
                </span>
              )}
            </button>
            {onRemove && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(p);
                }}
                className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-red-600 text-xs font-bold text-white ring-2 ring-white"
                aria-label="移除這張相片"
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}


/**
 * 單張已存相片嘅大圖檢視器（自己簽 URL）。
 *
 * 為何唔用 `StoredPhotoStrip`？strip 係「一排縮圖」，而開大圖係「一張」——
 * 兩者需要嘅資料形狀唔同。硬用同一個元件反而要傳一大堆唔關事嘅 props。
 */
function PhotoViewer({ account, path, onClose }: { account: string | null; path: string; onClose: () => void }) {
  const { urls, loading } = useSignedPhotoUrls(account, [path]);
  const url = urls[path];
  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-black/80 p-4"
      onClick={onClose}
    >
      {url ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={url}
          alt="單據相片"
          className="max-h-[80vh] max-w-full rounded-xl bg-white object-contain"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <p className="rounded-xl bg-white px-4 py-3 text-sm text-slate-600">
          {loading ? "載入中…" : "無法載入相片"}
        </p>
      )}
      <button
        type="button"
        onClick={onClose}
        className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-slate-800"
      >
        關閉
      </button>
    </div>
  );
}

function ReceiptFormModal({
  open,
  initial,
  suppliers,
  categories,
  units,
  paymentMethods,
  labelMap,
  recentItems,
  account,
  onClose,
  onSaved,
  onSuppliersChanged,
}: {
  open: boolean;
  initial: Receipt | null;
  suppliers: Supplier[];
  categories: string[];
  /**
   * 單位選單（`PosLocalSettings.invUnits`，經「庫存 → 設置 → 單位」維護）。
   *
   * ⚠️ 空陣列都係合法狀態（商家未建過單位）⇒ 品項 row 會退回自由輸入，
   *    唔會因為清單空咗就鎖死欄位（同一個取態：`invCategories`）。
   */
  units: string[];
  /** 進貨可見嘅付款方式（已按 scope 過濾，保持主檔次序）。 */
  paymentMethods: PaymentMethodDef[];
  labelMap: Record<string, string>;
  recentItems: ItemSuggestion[];
  account: string;
  onClose: () => void;
  onSaved: () => void;
  onSuppliersChanged: () => void | Promise<void>;
}) {
  const [form, setForm] = useState<FormState>(() => emptyForm(paymentMethods));
  const [err, setErr] = useState<string | null>(null);
  /**
   * 🔴 2026-10-08：驗證失敗時要標紅嘅欄位（`null` = 全部正常）。
   *
   * 為何要逐欄標紅而唔止出一句 banner：收據 modal 係 `max-h-[92vh] overflow-y-auto`
   * 嘅長表單，商家唔一定睇得到 banner 講嘅係邊一行 —— 紅框 ＋
   * 「第 N 項「魚」的單位必填」兩者一齊，先算「明確嘅驗證提示」。
   */
  const [fieldErr, setFieldErr] = useState<
    | { kind: "supplier" }
    | { kind: "payment_method" }
    | { kind: "payment_status" }
    | { kind: "item"; row: number; field: "name" | "quantity" | "unit" }
    | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [askDelete, setAskDelete] = useState(false);

  /** 即時新增供應商（唔使跳出 modal 去「設置」）。 */
  const [showNewSupplier, setShowNewSupplier] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState("");
  const [creatingSupplier, setCreatingSupplier] = useState(false);
  const [supplierHint, setSupplierHint] = useState<{ ok: boolean; text: string } | null>(null);

  /** 品類「其他…」手動輸入模式。 */
  const [manualCategory, setManualCategory] = useState(false);

  /**
   * 🔴 2026-10-07：品項「單位」嘅**逐行**手動輸入模式（`{ 行號: 開 }`）。
   *
   * 點解唔用一個全域 toggle（品類嗰個就係）：單位係**每個品項各自一個欄**，
   * 同一張單可以「豬肉＝kg、膠袋＝包」。一個全域掣會迫住全部品項一齊切換。
   */
  const [manualUnitRows, setManualUnitRows] = useState<Record<number, boolean>>({});

  /** `<select>` 嘅「手動輸入」哨兵值（唔可能撞到真實單位名）。 */
  const CUSTOM_UNIT = "__custom_unit__";

  /** 目前展開歷史品項建議嘅品項行（-1 = 冇）。 */
  const [pickerIndex, setPickerIndex] = useState<number>(-1);

  /**
   * 🔴 2026-10-08：**目前所選供應商**嘅歷史品項
   * （`GET /api/inventory/receipt-items?account=…&merchantId=…`）。
   *
   * 需求：揀咗「大大超市」之後，品項建議只可以出喺大大超市買過嘅嘢。
   *
   * 為何要 `key`（= merchant_id）＋ `ready` 兩個欄位而唔係單純一個 array：
   * - `key` 令切換供應商時唔會誤用上一個供應商嘅結果（race）；
   * - `ready` 區分「仲未載入完」同「真係零歷史」——
   *   🔴 未載入完**唔可以**退回全店清單，否則商家會見到一批
   *      明明唔係呢個供應商買過嘅品項閃出嚟，比空白更誤導。
   */
  const [scopedItems, setScopedItems] = useState<{ key: string; items: ItemSuggestion[]; ready: boolean }>({
    key: "",
    items: [],
    ready: false,
  });

  /**
   * 商家主動撳「顯示全部品項」嘅逃生門（只喺該供應商確認冇歷史時出現）。
   *
   * ⚠️ 呢個 flag 只係**顯示開關**，唔會改 `form.merchant_id` —— 供應商一改
   *    （或重開 modal）就會自動重置，避免商家帶住「全店清單」嘅錯誤預期落第二張單。
   */
  const [showAllItems, setShowAllItems] = useState(false);

  /**
   * 收據日期：確認稿係 chips（今天／昨天／選日期…），唔係一開頭就一個原生 date input。
   * 觸屏日曆揀日期要兩步（開日曆 → 揀日），而實際九成單都係「今天／昨天」，
   * 所以預設收起日曆，撳「選日期…」先展開（舊值仍然會顯示喺 chip 上面）。
   */
  const [showDatePicker, setShowDatePicker] = useState(false);

  /* ---------------- 單據相片（P3） ---------------- */

  /** 隱藏嘅 file input（撳「📷 上傳單據照片」時由按鈕觸發）。 */
  const photoInputRef = useRef<HTMLInputElement>(null);
  /** 已壓縮、**未上傳**嘅相片。 */
  const [pendingPhotos, setPendingPhotos] = useState<PendingPhoto[]>([]);
  /** 相片相關提示（上傳進度／失敗原因）。**唔會**阻擋儲存。 */
  const [photoMsg, setPhotoMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  /** 大圖檢視器（本地待上傳 blob URL）。 */
  const [lightbox, setLightbox] = useState<{ url: string; label: string } | null>(null);
  /** 大圖檢視器（已存 path，需要簽名 ⇒ 交給 `PhotoViewer` 處理）。 */
  const [storedViewer, setStoredViewer] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(initial ? formFromReceipt(initial) : emptyForm(paymentMethods));
      setErr(null);
      setFieldErr(null);
      setAskDelete(false);
      setShowNewSupplier(false);
      setNewSupplierName("");
      setSupplierHint(null);
      setManualCategory(false);
      setPickerIndex(-1);
      setShowDatePicker(false);
      // 2026-10-08：「顯示全部品項」嘅逃生門唔可以跨單殘留。
      setShowAllItems(false);
      /*
       * 🔴 每次開 modal 一定要清相片狀態。
       *   若唔清，上一張收據嘅待上傳相片會「跟」到下一張
       *   ⇒ 商家開 B 單卻見到 A 單未上傳嘅相，一儲存就上錯單。
       */
      setPendingPhotos((prev) => {
        // objectURL 要主動釋放，否則連續開關 modal 會累積記憶體（iPad Safari 緊）。
        for (const p of prev) URL.revokeObjectURL(p.previewUrl);
        return [];
      });
      setPhotoMsg(null);
      setLightbox(null);
      setStoredViewer(null);
    }
    // paymentMethods 唔列入 deps：開 modal 一刻嘅主檔就夠，途中變更唔應該重設用戶輸入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial]);

  /**
   * 🔴 2026-10-08：拉「目前所選供應商」嘅歷史品項
   * （`GET /api/inventory/receipt-items?...&merchantId=…`）。
   *
   * 需求：商家揀咗「大大超市」，品項彈窗只應該出喺大大超市買過嘅嘢。
   *
   * 三個死穴（唔可以簡化）：
   * ① **`merchant_id` 一定要真係喺 `suppliers` 清單入面**先拉 ——
   *    「其他（手動輸入）」冇 id，冇得查歷史 ⇒ 維持全店「最近用過」。
   * ② **一定要 `cancelled` 守衛**：商家快速切幾個供應商時，慢嗰個回應會覆蓋
   *    快嗰個嘅結果 ⇒ 彈窗出另一個供應商嘅品項（同 Realtime hook 同一種病灶）。
   * ③ 配對用 `scopedItems.key === 當前 id`，**配唔中就當「載入中」而唔係 fallback
   *    落全店清單** —— 否則切換供應商時會閃出一批唔屬於呢個供應商嘅品項。
   *
   * ⚠️ egress：同一個 modal session 內同一供應商只打一次（`ready` 快取），
   *    商家打字係本機過濾，唔會再打 server。
   */
  useEffect(() => {
    if (!open || !account) return;
    const key = suppliers.some((s) => s.id === form.merchant_id) ? form.merchant_id : "";
    if (!key) return; // 未揀供應商／手動輸入 ⇒ 沿用全店清單
    if (scopedItems.key === key && scopedItems.ready) return; // 已快取

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/inventory/receipt-items?account=${encodeURIComponent(account)}&merchantId=${encodeURIComponent(key)}`,
        );
        const json = (await res.json()) as { ok?: boolean; items?: ItemSuggestion[] };
        if (cancelled) return;
        setScopedItems({ key, items: json.ok && Array.isArray(json.items) ? json.items : [], ready: true });
      } catch {
        if (cancelled) return;
        // 網絡失敗 ⇒ 當「零歷史」（唔會退回全店，見上面 ③）。
        setScopedItems({ key, items: [], ready: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, account, form.merchant_id, suppliers, scopedItems]);

  if (!open) return null;

  const setItem = (i: number, patch: Partial<FormItem>) =>
    setForm((f) => ({ ...f, items: f.items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) }));

  const total = form.items.reduce((s, it) => s + (Number(it.unit_price) || 0) * (Number(it.quantity) || 1), 0);

  /** 收據日期係唔係「今天／昨天」（兩個快選 chip 之一）。 */
  const isQuickDate = form.date === todayStr() || form.date === yesterdayStr();

  /**
   * 數量 stepper（− / ＋）。
   *
   * 空白 = 當 0（唔係 1）：用戶撳「＋」應該由 0 變 1，唔係由 1 變 2。
   * 保留三位小數（食材按 kg 落 0.5 / 1.25 都常見），同樣唔會出負數。
   */
  const stepQty = (i: number, delta: number) => {
    const raw = form.items[i]?.quantity ?? "";
    const base = raw.trim() === "" ? 0 : Number(raw.replace(/,/g, "")) || 0;
    const next = Math.max(0, Math.round((base + delta) * 1000) / 1000);
    setItem(i, { quantity: String(next) });
  };

  // 供應商：優先認 id。若收據嘅 merchant_id 唔喺清單入面（例如已被刪／未同步），
  // 兜去「手動輸入」模式用 name 顯示，避免 select 顯示空白。
  const knownSupplier = Boolean(form.merchant_id) && suppliers.some((s) => s.id === form.merchant_id);
  const supplierSelectValue = knownSupplier ? form.merchant_id : form.merchant_name ? "__custom__" : "";
  const showManualSupplier = supplierSelectValue === "__custom__";

  /**
   * 品類選單：設置清單 ∪ 現有值。
   * 舊收據嘅品類可能係自由文字（設置清單未加過），唔可以令佢喺選單消失
   * —— 否則用戶一改其他欄位儲存就會靜靜將品類改走。
   *
   * ⚠️ 刻意**唔用 `useMemo`**：呢個檔上面有 `if (!open) return null` early return，
   * 喺佢之後再呼叫 hook 會直接違反 rules-of-hooks（lint error）。
   * 呢個計算是 O(n) 而且 n 係品類數（幾個），完全冇需要 memo。
   */
  const categoryOptions = (() => {
    const list = [...categories];
    const current = form.category.trim();
    if (current && !list.includes(current)) list.push(current);
    return list;
  })();

  /**
   * 某個品項嘅單位選項（2026-10-07）＝設置清單 ∪ 該項現有值。
   *
   * 🔴 同 `categoryOptions` **同一個理由**：舊收據嘅單位可能係自由文字
   *    （2026-10-06 之前冇得揀），亦可能單位已經喺「設置」被改名／刪除。
   *    如果唔補返現有值落選項，`<select>` 會顯示空白，而**React 讀到嘅值**
   *    仍然係舊字串 ⇒ 使用者以為冇咗，一儲存就靜靜變咗另一個單位。
   */
  const unitOptionsFor = (current: string): string[] => {
    const list = [...units];
    const cur = current.trim();
    if (cur && !list.includes(cur)) list.push(cur);
    return list;
  };

  /**
   * 品項建議嘅來源（2026-10-08）。
   *
   * - **已揀到具體供應商**（`merchant_id` 真係喺 `suppliers` 清單，唔係手動輸入）
   *   ⇒ 只出該供應商嘅歷史品項。仲未載入完／確認零歷史時**唔會**退回全店清單
   *   （只可以由商家主動撳「顯示全部品項」）。
   * - **未揀供應商／「其他（手動輸入）」** ⇒ 沿用全店「最近用過」（＝原本行為）。
   */
  const supplierScopeId = knownSupplier ? form.merchant_id : "";
  const scopedReady = Boolean(supplierScopeId) && scopedItems.key === supplierScopeId && scopedItems.ready;
  const suggestionSource: ItemSuggestion[] =
    !supplierScopeId || showAllItems ? recentItems : scopedReady ? scopedItems.items : [];
  /** 已揀供應商 ＋ 確認真係零歷史（唔係載入中）＋ 未撳「顯示全部品項」。 */
  const scopedEmpty = Boolean(supplierScopeId) && scopedReady && scopedItems.items.length === 0 && !showAllItems;
  /** 供應商名（建議清單標題／空狀態文案用）。 */
  const supplierScopeName = suppliers.find((s) => s.id === form.merchant_id)?.name ?? form.merchant_name;

  const suggestionsFor = (query: string): ItemSuggestion[] => {
    const q = query.trim().toLowerCase();
    const list = q ? suggestionSource.filter((i) => i.name.toLowerCase().includes(q)) : suggestionSource;
    return list.slice(0, 8);
  };

  const applySuggestion = (i: number, s: ItemSuggestion) => {
    setItem(i, {
      name: s.name,
      // 只喺單價空白時才自動填：唔好蓋走用戶已經改過嘅價錢。
      unit_price: form.items[i]?.unit_price?.trim() ? form.items[i].unit_price : String(s.unit_price || ""),
      // 2026-10-08：單位同單價**同一口徑** —— 只喺空白時帶入歷史單位，
      // 唔會蓋走商家編輯舊單時已經揀好嘅單位。
      // ⚠️ 歷史單位未必喺「設置 → 單位」主檔內，但 `unitOptionsFor()` 會自動補入
      //    `<select>` 選項 ⇒ 一定顯示得到，唔會出現「有值但個框空白」幽靈狀態。
      unit: form.items[i]?.unit?.trim() ? form.items[i].unit : s.unit || "",
    });
    setPickerIndex(-1);
  };

  const createSupplier = async () => {
    const name = newSupplierName.trim();
    if (!name || creatingSupplier) return;
    setCreatingSupplier(true);
    setSupplierHint(null);
    try {
      const res = await fetch(`/api/inventory/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, name }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        id?: string;
        error?: string;
        code?: string;
        merchant?: { id: string; name: string };
      };
      await onSuppliersChanged();

      if (json.ok && json.id) {
        setForm((f) => ({ ...f, merchant_id: String(json.id), merchant_name: name }));
        setShowNewSupplier(false);
        setNewSupplierName("");
        setSupplierHint({ ok: true, text: `已新增並選用「${name}」。` });
      } else if (json.code === "ALREADY_EXISTS" && json.merchant?.id) {
        // 本店已有同名 → 直接選用，唔當錯誤（用戶目標只係「用呢個供應商」）。
        setForm((f) => ({ ...f, merchant_id: String(json.merchant!.id), merchant_name: json.merchant!.name }));
        setShowNewSupplier(false);
        setNewSupplierName("");
        setSupplierHint({ ok: true, text: `「${json.merchant.name}」已經存在，已自動選用。` });
      } else {
        // NAME_TAKEN = 其他帳號已用同名（全表唯一），要講清楚唔係本店嘅問題。
        setSupplierHint({ ok: false, text: json.error || "新增供應商失敗" });
      }
    } catch {
      setSupplierHint({ ok: false, text: "網絡錯誤" });
    } finally {
      setCreatingSupplier(false);
    }
  };

  /* ---------------- 相片：揀檔 → 壓縮 → 入待上傳列 ---------------- */

  /**
   * 使用者揀完相片。
   *
   * 🔴 呢個 handler 內**只做壓縮**，唔即刻上傳。
   *    上傳留到「儲存收據」一刻（`uploadPendingPhotos()`），原因：
   *    ① 分開之後，「儲存」掣嘅語意單純（唔會有一半相上咗、一半冇）；
   *    ② 商家可以揀完相、睇清楚先刪走唔想要嘅，避免上傳白費流量。
   */
  const handlePhotoPick = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setPhotoMsg(null);
    setPhotoBusy(true);
    const added: PendingPhoto[] = [];
    const failed: string[] = [];
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) {
          failed.push(`${file.name}：唔係圖片`);
          continue;
        }
        const r = await compressImage(file, (stage) => setPhotoMsg({ ok: true, text: stage }));
        if (!r.ok) {
          failed.push(`${file.name}：${r.error}`);
          continue;
        }
        added.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          blob: r.blob,
          previewUrl: URL.createObjectURL(r.blob),
          size: r.blob.size,
        });
      }
      if (added.length > 0) setPendingPhotos((prev) => [...prev, ...added]);
      if (failed.length > 0) {
        setPhotoMsg({ ok: false, text: failed.join("；") });
      } else if (added.length > 0) {
        const total = added.reduce((s, p) => s + p.size, 0);
        setPhotoMsg({ ok: true, text: `已加入 ${added.length} 張（共 ${humanSize(total)}），儲存時自動上傳。` });
      }
    } finally {
      setPhotoBusy(false);
      // 🔴 清空 input.value：否則連續揀**同一張**相唔會觸發 change（瀏覽器認為值冇變）。
      if (photoInputRef.current) photoInputRef.current.value = "";
    }
  };

  const removePendingPhoto = (id: string) => {
    setPendingPhotos((prev) => {
      const hit = prev.find((p) => p.id === id);
      if (hit) URL.revokeObjectURL(hit.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  };

  /** 移除一張**已上傳／已存在**嘅相片（改 `form.photo_paths`；真正刪檔喺儲存時）。 */
  const removeStoredPhoto = (path: string) => {
    setForm((f) => ({ ...f, photo_paths: f.photo_paths.filter((p) => p !== path) }));
  };

  /**
   * 把待上傳相片逐張上傳，回傳成功嘅 path 陣列。
   *
   * 🔴 **失敗唔阻擋儲存**（J 拍板）：收據本身（金額／品項／品類）係主體，
   *    商家填咗一堆品項，唔可以因為相片上唔到而白費。
   *    ⇒ 上傳失敗只記錄喺 `photoMsg`，照樣帶住已成功嘅 path 去儲存。
   */
  const uploadPendingPhotos = async (): Promise<{ paths: string[]; failed: number }> => {
    if (pendingPhotos.length === 0) return { paths: [], failed: 0 };
    let failed = 0;
    const paths: string[] = [];
    for (let i = 0; i < pendingPhotos.length; i++) {
      const p = pendingPhotos[i];
      setPhotoMsg({ ok: true, text: `上傳相片 ${i + 1}/${pendingPhotos.length}…` });
      try {
        const fd = new FormData();
        fd.append("account", account);
        // 🔴 副檔名一定要 `.jpg`：`compressImage()` 一定輸出 JPEG，
        //    但 server 係認 `file.type` 推副檔名 —— 所以呢度要明確指定型別，
        //    否則 FormData 會用 blob 預設嘅 `application/octet-stream` 而被 415 拒絕。
        fd.append("file", p.blob, `receipt-${i + 1}.jpg`);
        const res = await fetch("/api/inventory/receipt-photos", { method: "POST", body: fd });
        const json = (await res.json()) as { ok?: boolean; path?: string; error?: string };
        if (json.ok && json.path) paths.push(json.path);
        else {
          failed += 1;
          if (failed === 1) setPhotoMsg({ ok: false, text: json.error || "相片上傳失敗" });
        }
      } catch {
        failed += 1;
      }
    }
    return { paths, failed };
  };

  const save = async () => {
    setErr(null);
    setFieldErr(null);
    if (!form.merchant_id && !form.merchant_name.trim()) {
      setFieldErr({ kind: "supplier" });
      return setErr("請選擇供應商（必填）");
    }
    if (!form.date) return setErr("請選擇收據日期（必填）");
    // 🔴 2026-10-07 J 拍板：品類必填。
    // 舊收據（品類為空）一經編輯儲存就會被要求補揀 —— 呢個係預期行為，
    // 因為品項分析／品類報表要靠品類分組，空品類會出現「未分類」黑洞。
    if (!form.category.trim()) return setErr("請選擇品類（必填）");

    /*
     * 🔴 2026-10-08 J 拍板：付款方式／付款狀態／品項／數量／單位一律必填，
     *    而且**包含編輯模式**（唔止新增）。
     *
     * ⚠️ 呢個係**推翻** 2026-10-07「單位保持選填」嘅拍板。副作用（J 已確認接受）：
     *    所有舊收據（單位為空）一經編輯儲存就會被要求補齊單位。
     *    同步已改寫 `inventory-contract-guard.test.ts` 嗰條守舊口徑嘅守衛。
     */
    if (!form.payment_method) {
      setFieldErr({ kind: "payment_method" });
      return setErr("請選擇付款方式（必填）");
    }
    if (!form.payment_status) {
      setFieldErr({ kind: "payment_status" });
      return setErr("請選擇付款狀態（必填）");
    }

    /*
     * 品項驗證：
     * - **完全空白**嘅行（連品名都冇）照舊被丟棄 —— 「＋ 品項」撳多咗一行係常態，
     *   唔應該因為一行空殼而擋住成張單（同原本 `.filter(it => it.name.trim())` 一致）。
     * - 但只要有**品名**，該行嘅數量同單位就一律要填。
     *   ⚠️ 數量空白／0 都要當「未填」：`Number("") || 1` 會靜靜變 1，
     *      唔可以靠原本嘅 `|| 1` 做驗證。
     */
    const namedRows = form.items.map((it, idx) => ({ it, idx })).filter((x) => x.it.name.trim());
    if (namedRows.length === 0) {
      setFieldErr({ kind: "item", row: 0, field: "name" });
      return setErr("請至少輸入一個品項（必填）");
    }
    const badQty = namedRows.find((x) => !(Number((x.it.quantity || "").replace(/,/g, "")) > 0));
    if (badQty) {
      setFieldErr({ kind: "item", row: badQty.idx, field: "quantity" });
      return setErr(`第 ${badQty.idx + 1} 項「${badQty.it.name.trim()}」的數量必填（要大於 0）`);
    }
    const badUnitRow = namedRows.find((x) => !x.it.unit.trim());
    if (badUnitRow) {
      setFieldErr({ kind: "item", row: badUnitRow.idx, field: "unit" });
      return setErr(`第 ${badUnitRow.idx + 1} 項「${badUnitRow.it.name.trim()}」的單位必填`);
    }

    const items = form.items
      .filter((it) => it.name.trim())
      .map((it) => ({
        name: it.name.trim(),
        unit_price: Number(it.unit_price) || 0,
        quantity: Number(it.quantity) || 1,
        // 2026-10-06：單位（kg／包／罐…）。2026-10-08 起必填（上面已驗）。
        quantity_unit: it.unit.trim(),
      }));
    setSaving(true);
    /*
     * 🔴 2026-10-07（P3）：先上傳相片，再存收據。
     *
     * 次序：**上傳相片 → 儲存收據**。
     *   反過黎（先存收據再上傳）會有兩個問題：
     *   ① 收據已存在但相片路徑要再 PATCH 一次 ⇒ 多一次往返、多一個失敗點；
     *   ② 上傳途中商家關咗 modal ⇒ 收據已存但相片永遠上唔到（幽靈狀態）。
     *
     * ⚠️ 相片上傳失敗**唔會** return，只係 `failedPhotoCount > 0`，
     *    最後喺成功提示帶一句警告（見下面）。呢個係 J 拍板嘅明確要求。
     */
    const upload = await uploadPendingPhotos();
    const failedPhotoCount = upload.failed;
    // 🔴 `pendingPhotos` 內**成功嘅** path ＋ 原有（未被移除嘅）`form.photo_paths`。
    //    ⚠️ 一定要**明確傳** `photo_paths`（即使係空陣列）：
    //       PATCH 靠 `!== undefined` 判斷「商家主動刪光相片」，
    //       唔傳就等於「唔想改相片」⇒ 刪相會靜默失效。
    const photoPaths = [...form.photo_paths, ...upload.paths];
    const payload = {
      account,
      // 有 id 就送 id（server 直接採用，唔會 upsert by name ⇒ 唔會撞 unique）；
      // 冇 id（手動輸入／新供應商）先至送 name。
      merchant_id: form.merchant_id || undefined,
      merchant_name: form.merchant_name.trim() || undefined,
      receipt_number: form.receipt_number || undefined,
      category: form.category.trim() || undefined,
      payment_method: form.payment_method,
      payment_status: form.payment_status,
      date: form.date,
      total_amount: Math.round(total * 100) / 100,
      items,
      photo_paths: photoPaths,
    };
    try {
      const res = form.id
        ? await fetch(`/api/inventory/receipts/${form.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/inventory/receipts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      const json = await res.json();
      if (!json.ok) setErr(json.error || "儲存失敗");
      else {
        /*
         * 相片上傳失敗但收據已存 ⇒ 唔可以當「一切都好」靜默收場，
         * 否則商家以為相片都上咗。用 `window.alert` 係因為 modal 即將閂，
         * 冇地方擺提示（POS 其他流程亦有用 alert 做不可忽略嘅通知）。
         * ⚠️ 只喺**有失敗**時才彈，成功唔彈（唔好煩擾）。
         */
        if (failedPhotoCount > 0) {
          window.alert(`收據已儲存，但有 ${failedPhotoCount} 張相片上傳失敗。\n可以重新開啟這張收據再上傳一次。`);
        }
        onSaved();
        onClose();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "網絡錯誤");
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    if (!form.id || !account) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/inventory/receipts/${form.id}?account=${encodeURIComponent(account)}`, { method: "DELETE" });
      const json = await res.json();
      if (!json.ok) setErr(json.error || "刪除失敗");
      else {
        onSaved();
        onClose();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "網絡錯誤");
    } finally {
      setSaving(false);
      setAskDelete(false);
    }
  };

  // 加大輸入框：py-3.5 + text-base，品項 row 用 grid 對齊讓格寬合理
  const fieldCls =
    "w-full rounded-xl border border-slate-200 bg-white px-4 py-3.5 text-base text-slate-900 outline-none focus:border-slate-400";
  /**
   * 🔴 單位欄專用樣式（2026-10-07 修「揀完單位顯示不全」）。
   *
   * 病根：品項 row 嘅 grid 軌當初畀單位 **5.5rem（88px）**，而格內仲要並排
   * 一個 `✎` 按鈕（`px-3` ≈ 40px）。`fieldCls` 另有 `px-4`（左右各 16px＝32px），
   * 88 − 32 − 40 − 4(gap) ≈ **12px** 文字空間，再加 native `<select>` 自己
   * 嘅下拉箭咀（≈ 20px）⇒ 淨剩唔到 0 ⇒ **淨係見到個箭咀，揀咗乜都睇唔到**。
   *
   * ⇒ 三個動作：① 軌闊到 8rem；② `px-3`（原生 select 右邊本身已有箭咀空間，
   *   唔使再靠 padding 預留）；③ **移走多餘嘅 `✎` 按鈕** —— `<select>` 內
   *   已經有「其他…」（`CUSTOM_UNIT`）做同一件事，兩個入口係純粹重複。
   *
   * ⚠️ 唔可以直接用 `fieldCls`：咁樣 `px-4` 會令 8rem 軌再度被夾窄。
   */
  const unitFieldCls =
    "w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-3.5 text-base text-slate-900 outline-none focus:border-slate-400";
  /**
   * 單位欄嘅「模式切換」細掣（手動輸入 ⇄ 從清單揀）。
   *
   * 🔴 必須係 **固定 40px 方形**，唔可以用 `px-3` 加文字：品項 row 嘅單位軌
   *    得 8rem，掣一闊就會再次把輸入框／下拉夾到顯示不全（就係原本 `✎` 咁嘅病）。
   *    40px 亦啱好係觸屏點擊目標下限。
   * ⚠️ 圖示語意：`▾` ＝ 從清單揀（同一個 select 自己嘅下拉箭咀），
   *    唔使靠 `title`／aria-label 以外嘅提示；兩個模式都靠 `aria-label` 講明。
   */
  const unitToggleCls =
    "grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-100 text-sm text-slate-600 ring-1 ring-slate-200 hover:bg-slate-200";
  /** 觸屏 chip：付款方式／品類都用呢個，唔用下拉（下拉喺觸屏要兩步、選項細）。 */
  const chipCls = (active: boolean) =>
    `rounded-xl px-4 py-3 text-base font-medium transition ${
      active ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"
    }`;
  const labelCls = "mb-1.5 block text-sm font-medium text-slate-700";

  /**
   * 驗證失敗欄位嘅紅框（2026-10-08）。
   *
   * ⚠️ 用 `ring` 而**唔可以**用 `border`：`fieldCls`／`unitFieldCls` 本身已經有
   *    `border border-slate-200`，而 Tailwind v4 嘅 `border-*` 顏色係同一個 property，
   *    兩個邊個贏係睇**產生次序**而唔係 class 字串次序 ⇒ 加 `border-red-400`
   *    隨時被 `border-slate-200` 蓋過（同 `.w-full` 壓 `.w-28` 係同一種地雷）。
   *    `ring` 係獨立 property，一定唔會打架。
   */
  const errRing = (on: boolean) => (on ? " ring-2 ring-red-300" : "");
  /** 該品項行嘅某個欄位係唔係驗證失敗。 */
  const itemFieldErr = (idx: number, field: "name" | "quantity" | "unit") =>
    fieldErr?.kind === "item" && fieldErr.row === idx && fieldErr.field === field;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3"
      onClick={onClose}
    >
      <div
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white p-5 pb-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-xl font-semibold text-slate-900">{form.id ? "編輯收據" : "新增收據"}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200"
          >
            關閉
          </button>
        </div>

        <div className="space-y-5">
          {/* ── 供應商：下拉（已有）＋ 即時新增 ── */}
          <div>
            <label className={labelCls}>供應商</label>
            <div className="flex gap-2">
              <select
                className={fieldCls + errRing(fieldErr?.kind === "supplier")}
                value={supplierSelectValue}
                onChange={(e) => {
                  const v = e.target.value;
                  // 2026-10-08：一改供應商就收返「顯示全部品項」嘅逃生門 ——
                  // 否則商家切到下一個供應商仍然望住全店清單，會誤以為嗰啲都買過。
                  setShowAllItems(false);
                  if (v === "__custom__") setForm({ ...form, merchant_id: "", merchant_name: form.merchant_name });
                  else if (!v) setForm({ ...form, merchant_id: "", merchant_name: "" });
                  else {
                    const hit = suppliers.find((s) => s.id === v);
                    setForm({ ...form, merchant_id: v, merchant_name: hit?.name ?? "" });
                  }
                }}
              >
                <option value="">— 選擇供應商 —</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                <option value="__custom__">其他（手動輸入）</option>
              </select>
              <button
                type="button"
                onClick={() => {
                  setShowNewSupplier((v) => !v);
                  setSupplierHint(null);
                }}
                className="shrink-0 rounded-xl bg-slate-900 px-4 py-3.5 text-sm font-semibold text-white"
              >
                ＋ 新增
              </button>
            </div>

            {showNewSupplier && (
              <div className="mt-2 flex gap-2">
                <input
                  autoFocus
                  className={fieldCls}
                  value={newSupplierName}
                  onChange={(e) => setNewSupplierName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void createSupplier();
                  }}
                  placeholder="新供應商名稱，撳「建立」"
                  aria-label="新供應商名稱"
                />
                <button
                  type="button"
                  onClick={() => void createSupplier()}
                  disabled={creatingSupplier}
                  className="shrink-0 rounded-xl bg-emerald-600 px-4 py-3.5 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {creatingSupplier ? "建立中…" : "建立"}
                </button>
              </div>
            )}

            {showManualSupplier && (
              <input
                className={`${fieldCls} mt-2`}
                value={form.merchant_name}
                onChange={(e) => setForm({ ...form, merchant_id: "", merchant_name: e.target.value })}
                placeholder="輸入供應商名稱（新的會自動建立）"
                aria-label="供應商名稱"
              />
            )}

            {supplierHint && (
              <p
                className={`mt-2 rounded-xl px-3 py-2 text-xs font-medium ${
                  supplierHint.ok ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"
                }`}
              >
                {supplierHint.text}
              </p>
            )}

            <p className="mt-1.5 text-xs text-slate-400">
              {suppliers.length === 0
                ? "尚無供應商，撳「＋ 新增」即時建立。"
                : "由已建立的供應商選擇；揀現有供應商唔會重複建立。"}
            </p>
          </div>

          {/* ── 品類：chip 直接揀（觸屏），清單由「設置」管理 ── */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              {/* 🔴 2026-10-07 J 拍板：「品類」改必填（原本可留空 = 不指定）。
                  舊收據冇品類 ⇒ 一撳入去編輯、儲存時會被要求補揀（見 save() 驗證）。 */}
              <label className="text-sm font-medium text-slate-700">
                品類 <span className="text-red-500">*</span>
              </label>
              <button
                type="button"
                onClick={() => {
                  setManualCategory((v) => !v);
                  if (manualCategory) setForm((f) => ({ ...f, category: "" }));
                }}
                className="text-xs font-medium text-slate-500 underline"
              >
                {manualCategory ? "改為揀清單" : "其他（手動輸入）"}
              </button>
            </div>
            {manualCategory || categoryOptions.length === 0 ? (
              <>
                <input
                  className={fieldCls}
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  placeholder="輸入品類（必填，例如：食材）"
                  aria-label="品類"
                  required
                />
                {categoryOptions.length === 0 && (
                  <p className="mt-1.5 text-xs text-slate-400">
                    未建立品類清單。可以喺「庫存 → 設置 → 品類」建立，之後就唔使每次手打。
                  </p>
                )}
              </>
            ) : (
              <div className="flex flex-wrap gap-2">
                {/* 🔴 2026-10-07：「不指定」chip 已移除 —— 品類改必填。
                    冇咗呢個 chip 之後，未揀品類時係「一個都冇選中」嘅狀態，
                    唔會誤導用戶以為已經揀咗一個有效值。 */}
                {categoryOptions.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={chipCls(form.category === c)}
                    onClick={() => setForm({ ...form, category: c })}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className={labelCls}>收據編號</label>
              <input
                className={fieldCls}
                value={form.receipt_number}
                onChange={(e) => setForm({ ...form, receipt_number: e.target.value })}
                placeholder="選填"
              />
            </div>
            <div>
              <label className={labelCls}>收據日期</label>
              {/* 確認稿：chips（今天／昨天／選日期…）。原生日曆要兩步先揀到一日，
                  而實際九成單都係「今天」，所以收起日曆直到撳「選日期…」。 */}
              <div className="flex flex-wrap gap-2">
                {[
                  { key: "today", label: "今天", value: todayStr() },
                  { key: "yesterday", label: "昨天", value: yesterdayStr() },
                ].map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className={chipCls(form.date === c.value)}
                    onClick={() => {
                      setForm({ ...form, date: c.value });
                      setShowDatePicker(false);
                    }}
                  >
                    {c.label}
                  </button>
                ))}
                <button
                  type="button"
                  className={chipCls(!isQuickDate)}
                  onClick={() => setShowDatePicker(true)}
                >
                  {isQuickDate ? "選日期…" : form.date}
                </button>
              </div>
              {showDatePicker && (
                <input
                  type="date"
                  className={`${fieldCls} mt-2`}
                  value={form.date}
                  autoFocus
                  onChange={(e) => setForm({ ...form, date: e.target.value })}
                  aria-label="收據日期"
                />
              )}
              {/* 🔴 2026-10-07：顯示「錄入時間」（年月日時分秒）。
                  單據日期係商家填嘅；錄入時間係系統寫入嘅，兩者係唔同概念 ——
                  補登舊單時一定唔同日，所以要寫明係邊個時間，唔可以混淆。 */}
              {initial?.created_at && (
                <p className="mt-2 text-xs text-slate-500 tabular-nums">
                  錄入時間：{formatReceiptStamp(initial.receipt_date, initial.created_at)}
                  {isBackdatedReceipt(initial.receipt_date, initial.created_at) && (
                    <span className="ml-1 text-amber-600">（補登，非當日錄入）</span>
                  )}
                </p>
              )}
            </div>
          </div>

          {/* ── 付款方式：chip（主檔驅動） ── */}
          <div>
            <label className={labelCls}>付款方式</label>
            <div className={"flex flex-wrap gap-2 rounded-xl" + errRing(fieldErr?.kind === "payment_method")}>
              {paymentMethods.length === 0 ? (
                <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  系統未設定任何「進貨」付款方式，請聯絡管理員喺後台設定。
                </p>
              ) : (
                paymentMethods.map((m) => (
                  <button
                    key={m.code}
                    type="button"
                    className={chipCls(form.payment_method === m.code)}
                    onClick={() => setForm({ ...form, payment_method: m.code })}
                  >
                    {m.label}
                  </button>
                ))
              )}
            </div>
            {/* 舊收據嘅付款方式若唔喺主檔（已停用／被改），仍然要顯示得到，否則一儲存就靜靜改走。 */}
            {form.payment_method &&
              !paymentMethods.some((m) => m.code === form.payment_method) && (
                <p className="mt-1.5 text-xs text-amber-700">
                  原本係「{labelMap[form.payment_method] ?? form.payment_method}」（呢個方式已停用或唔喺主檔）。
                  揀上面任何一個就會覆蓋。
                </p>
              )}
          </div>

          <div>
            {/*
             * 🔴 付款狀態標題同「月結」提示**必須排成同一行**。
             *    POS 係觸屏，modal 高度得 92vh；獨立一行提示會把
             *    下方「單據照片」區推出可視範圍（實測溢出 58px）。
             *    收埋做標題右側一行細字＝零額外高度，商家照樣睇得到。
             */}
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <label className={labelCls}>付款狀態</label>
              <span className="text-xs leading-snug text-slate-400">
                「月結」通常先記「未付款」，月底結算後記得返嚟改做「已付款」。
              </span>
            </div>
            <div className={"flex flex-wrap gap-2 rounded-xl" + errRing(fieldErr?.kind === "payment_status")}>
              {([
                { code: "unpaid", label: "未付款" },
                { code: "paid", label: "已付款" },
              ] as const).map((s) => (
                <button
                  key={s.code}
                  type="button"
                  className={chipCls(form.payment_status === s.code)}
                  onClick={() => setForm({ ...form, payment_status: s.code })}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── 單據相片（P3・非必填） ── */}
          <div>
            <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <label className="text-sm font-medium text-slate-700">
                單據照片
                <span className="ml-1.5 text-xs font-normal text-slate-400">（選填）</span>
              </label>
              {form.photo_paths.length + pendingPhotos.length > 0 ? (
                <span className="text-xs text-slate-400">
                  共 {form.photo_paths.length + pendingPhotos.length} 張・虛線＝未上傳
                </span>
              ) : (
                <span className="text-xs leading-snug text-slate-400">自動壓縮至 200KB 以下</span>
              )}
            </div>

            {/*
             * 🔴 file input **唔可以加 `capture="environment"`**。
             *    加了之後 iOS 會直接開相機、跳過「相片圖庫／瀏覽檔案」選項，
             *    咁就連「上傳已影好嘅相」都做唔到（J 要求係「拍照**或**上傳」）。
             *    唔加就係 iOS 標準三選單（拍照／圖庫／瀏覽）。
             *
             * 🔴🔴 唔可以用 Tailwind `sr-only` 嚟隱藏！
             *    本專案**未有任何地方用過** `sr-only`，Tailwind v4 只會為實際出現過嘅
             *    class 生成 CSS —— 實測 dev server 產出嘅 CSS **完全冇 `.sr-only`**，
             *    所以個原生 file input 會**原樣顯示**（連「未選擇任何檔案」都出埋）。
             *    ⇒ 用 inline style 直接令佢「存在但唔可見／唔佔位」，唔靠任何 utility class。
             */}
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0,0,0,0)", whiteSpace: "nowrap", border: 0 }}
              onChange={(e) => void handlePhotoPick(e.target.files)}
              aria-label="選擇單據照片"
            />

            <button
              type="button"
              disabled={photoBusy}
              onClick={() => photoInputRef.current?.click()}
              className="w-full rounded-xl bg-slate-100 px-4 py-3.5 text-base font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-200 disabled:opacity-60"
            >
              {photoBusy ? "處理中…" : "📷 上傳單據照片"}
            </button>

            {/*
             * 🔴 相片縮圖用**單一行橫向捲動**（`flex-nowrap overflow-x-auto`）。
             *
             * 為何唔用 `flex-wrap`（換行）：
             *   收據 modal 有 `max-h-[92vh] overflow-y-auto`，而上面已經有供應商／品類／
             *   日期／付款方式／付款狀態五大區。若縮圖會換行，加到第 4–5 張就會把
             *   **下面嘅品項／合計／儲存掣**推到 modal 可視範圍以外 ——
             *   實測第一版就係咁：縮圖 bottom 918px > 面板 bottom 864px，被裁切。
             *   ⇒ 橫向捲動令高度**永遠只有一行**（56px），唔受張數影響。
             */}
            {(form.photo_paths.length > 0 || pendingPhotos.length > 0) && (
              <div className="mt-3 flex flex-nowrap items-start gap-2 overflow-x-auto pb-1">
                {/* 已存在（private bucket ⇒ signed URL） */}
                {form.photo_paths.length > 0 && (
                  <StoredPhotoStrip
                    account={account}
                    paths={form.photo_paths}
                    onRemove={removeStoredPhoto}
                    size="h-12 w-12"
                    nowrap
                    onOpen={(p) => setStoredViewer(p)}
                  />
                )}

                {/* 待上傳（本地已壓縮，尚未上傳） */}
                {pendingPhotos.map((p) => (
                  <div key={p.id} className="relative shrink-0">
                    <button
                      type="button"
                      onClick={() => setLightbox({ url: p.previewUrl, label: `待上傳・${humanSize(p.size)}` })}
                      className="block h-12 w-12 overflow-hidden rounded-xl border border-dashed border-slate-300 bg-white"
                      aria-label="檢視待上傳相片"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.previewUrl} alt="待上傳單據相片" className="h-full w-full object-cover" />
                    </button>
                    <span className="absolute bottom-0 left-0 rounded-br-xl rounded-tl-md bg-black/60 px-1.5 text-[10px] font-medium text-white tabular-nums">
                      {humanSize(p.size)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removePendingPhoto(p.id)}
                      className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-red-600 text-xs font-bold text-white ring-2 ring-white"
                      aria-label="移除這張待上傳相片"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            {photoMsg && (
              <p
                className={`mt-2 rounded-xl px-3 py-2 text-xs font-medium ${
                  photoMsg.ok ? "bg-slate-100 text-slate-600" : "bg-amber-50 text-amber-800"
                }`}
              >
                {photoMsg.text}
              </p>
            )}

            {/*
             * 🔴 呢個區**唔可以再加任何獨立一行嘅說明文字**。
             *    收據 modal 係 `max-h-[92vh] overflow-y-auto`，而上面已有供應商／
             *    品類／日期／付款方式／付款狀態五區。第一版寫咗三段說明（移除提示／
             *    虛線框含義／200KB 說明）＝ +48px，正好把上傳掣同縮圖推出可視範圍
             *    （實測縮圖 bottom 922 > 面板 bottom 864，被裁切）。
             *    ✅ 現行做法＝把所有提示**併入標題行**（`共 N 張・虛線＝未上傳`／
             *       `自動壓縮至 200KB 以下`），零額外高度。
             *    POS 係觸屏，商家唔會為睇說明而捲；提示要短、要貼住標題。
             */}
          </div>

          {/* ── 品項：支援歷史品項快速選取 ── */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-sm font-medium text-slate-700">品項</label>
              <button
                type="button"
                className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
                onClick={() => setForm({ ...form, items: [...form.items, { name: "", unit_price: "", quantity: "1", unit: "" }] })}
              >
                ＋ 品項
              </button>
            </div>
            <div className="space-y-3">
              {form.items.map((it, i) => {
                const suggestions = pickerIndex === i ? suggestionsFor(it.name) : [];
                return (
                  <div key={i}>
                    {/* 🔴 2026-09-25 修正：以前係 `flex` + `${fieldCls} w-28`，而 fieldCls
                        內含 `w-full`；本專案 Tailwind v4 產生順序係 `.w-full` 喺 `.w-28`
                        之後 ⇒ `w-full` 勝出 ⇒ 單價／數量 flex-basis = 100%，
                        `flex-1`（basis 0）嘅品名欄分到 **0 寬** ⇒ 睇唔到亦撳唔到。
                        改用 grid 固定軌寬（每格入面 w-full = 軌寬，唔會再互相搶位），
                        窄螢幕則換行：品名一整行，單價＋數量 stepper 第二行，刪除第三行。

                        2026-09-26：數量由純輸入框改成「− 數量 ＋」stepper（對齊確認稿），
                        所以數量軌由 5rem 加闊到 10rem；仍然係 grid 固定軌，唔會搶位。

                        2026-10-07：單位軌由 5.5rem 加闊到 8rem。5.5rem 扣掉格內
                        `✎` 掣（40px）＋ `fieldCls` 嘅 `px-4`（32px）＋ native 箭咀
                        只剩約 12px ⇒ 揀完單位淨係見到個箭咀。詳見 `unitFieldCls` 註解。 */}
                    <div className="grid grid-cols-2 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_6.5rem_9rem_8rem_auto]">
                      <div className="col-span-2 min-w-0 sm:col-span-1">
                        <input
                          className={fieldCls + errRing(itemFieldErr(i, "name"))}
                          value={it.name}
                          onChange={(e) => {
                            setItem(i, { name: e.target.value });
                            setPickerIndex(i);
                          }}
                          onFocus={() => setPickerIndex(i)}
                          onBlur={() => window.setTimeout(() => setPickerIndex((cur) => (cur === i ? -1 : cur)), 150)}
                          placeholder="品名"
                          aria-label={`第 ${i + 1} 項品名`}
                        />
                      </div>
                      <input
                        className={fieldCls}
                        inputMode="decimal"
                        value={it.unit_price}
                        onChange={(e) => setItem(i, { unit_price: e.target.value })}
                        placeholder="單價"
                        aria-label={`第 ${i + 1} 項單價`}
                      />
                      {/* 數量 stepper（確認稿：− 12 ＋）。仍然可以直接打字（連續落單時更快），
                          stepper 只係補返觸屏「加一次」嘅需要。下限 0，唔會出負數。
                          ⚠️ `overflow-hidden` 令兩個按鈕嘅 hover 底色唔會突出圓角。 */}
                      <div
                        className={
                          "grid grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center gap-1 overflow-hidden rounded-xl border border-slate-200 bg-white" +
                          errRing(itemFieldErr(i, "quantity"))
                        }
                      >
                        <button
                          type="button"
                          onClick={() => stepQty(i, -1)}
                          disabled={!(Number(it.quantity) > 0)}
                          className="h-12 text-lg font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-30"
                          aria-label={`第 ${i + 1} 項數量減一`}
                        >
                          −
                        </button>
                        <input
                          className="h-12 w-full min-w-0 border-0 bg-transparent text-center text-base font-semibold text-slate-900 outline-none"
                          inputMode="decimal"
                          value={it.quantity}
                          onChange={(e) => setItem(i, { quantity: e.target.value })}
                          placeholder="數量"
                          aria-label={`第 ${i + 1} 項數量`}
                        />
                        <button
                          type="button"
                          onClick={() => stepQty(i, 1)}
                          className="h-12 text-lg font-semibold text-slate-700 hover:bg-slate-50"
                          aria-label={`第 ${i + 1} 項數量加一`}
                        >
                          ＋
                        </button>
                      </div>
                      {/* 單位（kg／包／罐…）。2026-10-06 新增為自由輸入；
                          2026-10-07 改為「設置 → 單位」主檔驅動嘅下拉選單。

                          🔴 三個模式（缺一不可）：
                          ① 有主檔 → `<select>`（選填，第一格係空白＝唔填）
                          ② 該行撳「其他」或主檔為空 → 自由輸入
                          ③ 舊值唔喺主檔 → 已經由 unitOptionsFor() 補入選項，
                             所以唔會出現「有值但個框顯示空白」嘅幽靈狀態。

                          ⚠️ 欄位仍然係**選填**（同原本行為一致）：留空 = 未填單位，
                             報表只出數量。唔會因為單位清單空咗就鎖死呢一欄。 */}
                      {manualUnitRows[i] || units.length === 0 ? (
                        <div className="col-span-2 grid grid-cols-[minmax(0,1fr)_auto] gap-1 sm:col-span-1">
                          <input
                            className={unitFieldCls + errRing(itemFieldErr(i, "unit"))}
                            value={it.unit}
                            onChange={(e) => setItem(i, { unit: e.target.value })}
                            placeholder="單位"
                            aria-label={`第 ${i + 1} 項單位`}
                          />
                          {units.length > 0 && (
                            <button
                              type="button"
                              className={unitToggleCls}
                              onClick={() => setManualUnitRows((m) => ({ ...m, [i]: false }))}
                              title="改為從單位清單揀"
                              aria-label={`第 ${i + 1} 項改為揀清單`}
                            >
                              ▾
                            </button>
                          )}
                        </div>
                      ) : (
                        /* 🔴 手動輸入 → 清單嘅切換掣**唔可以**擺喺 select 右手邊：
                           原版嗰個 `✎`（px-3 ≈ 40px）令 8rem 軌嘅 select 剩返
                           ~84px，再扣 `fieldCls` 嘅 `px-4` 同 native 箭咀 ⇒
                           **揀完只見到箭咀**。而 `<select>` 內嘅「其他…」
                           （CUSTOM_UNIT）本身就係同一個入口，兩個掣純重複。
                           ⇒ 下拉模式淨係得 select，手動模式先有一個 40px 方形切換掣。 */
                        <div className="col-span-2 sm:col-span-1">
                          <select
                            className={unitFieldCls + errRing(itemFieldErr(i, "unit"))}
                            value={manualUnitRows[i] ? CUSTOM_UNIT : it.unit}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (v === CUSTOM_UNIT) {
                                setManualUnitRows((m) => ({ ...m, [i]: true }));
                                return;
                              }
                              setItem(i, { unit: v });
                            }}
                            aria-label={`第 ${i + 1} 項單位`}
                          >
                            {/* ⚠️ 呢句係細螢幕（grid 變 2 欄、每欄獨立一行）唯一嘅
                                欄位識別標記 —— 嗰時冇 label，所以唔可以簡化成「單位」
                                以外嘅空字串；亦**唔可以**加長（例如「單位（選填）」），
                                8rem 軌扣 px-3＋箭咀之後放唔落 6 個中文字，會再出現截斷。 */}
                            <option value="">單位</option>
                            {unitOptionsFor(it.unit).map((u) => (
                              <option key={u} value={u}>
                                {u}
                              </option>
                            ))}
                            <option value={CUSTOM_UNIT}>其他…</option>
                          </select>
                        </div>
                      )}
                      <button
                        type="button"
                        className="col-span-2 shrink-0 rounded-xl bg-red-50 px-4 py-3.5 text-base font-medium text-red-600 hover:bg-red-100 sm:col-span-1"
                        onClick={() => setForm({ ...form, items: form.items.filter((_, idx) => idx !== i) })}
                        aria-label="刪除品項"
                      >
                        ✕
                      </button>
                    </div>

                    {/*
                      建議清單（2026-10-08：已按當前所選供應商過濾）。
                      🔴 條件要**同時包埋空狀態** —— 已揀供應商但真係零歷史時，
                         如果咩都唔 render，商家會以為功能壞咗（「明明喺呢間買過魚」）。
                      ⚠️ `suggestions` 只喺 `pickerIndex === i` 時先有值，
                         所以空狀態要自己再判一次 `pickerIndex === i`。
                    */}
                    {(suggestions.length > 0 || (pickerIndex === i && scopedEmpty)) && (
                      <div className="mt-2 rounded-2xl border border-slate-200 bg-slate-50 p-2">
                        <p className="px-2 pb-1 text-xs font-medium text-slate-500">
                          {supplierScopeId && !showAllItems ? (
                            <>
                              <span className="font-semibold">{supplierScopeName}</span>
                              {"　常用品項（撳一下自動填入品名、單位；單價空白時一併填入）"}
                            </>
                          ) : (
                            "最近用過（撳一下自動填入品名，單價空白時一併填入）"
                          )}
                        </p>
                        {suggestions.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {suggestions.map((s) => (
                              <button
                                key={s.name}
                                type="button"
                                /* 🔴 用 onPointerDown + preventDefault 而唔係 onClick：
                                   撳落去嘅一刻 input 會先 blur，而 onBlur 會收埋個建議清單
                                   ⇒ onClick 永遠唔會觸發（建議清單「撳唔到」）。 */
                                onPointerDown={(e) => {
                                  e.preventDefault();
                                  applySuggestion(i, s);
                                }}
                                className="rounded-xl bg-white px-3 py-2.5 text-sm font-medium text-slate-800 ring-1 ring-slate-200"
                              >
                                {s.name}
                                {/* 2026-10-08：連歷史單位一齊顯示，商家撳之前就知會帶入咩。
                                    ⚠️ 單價可以係 0（免費／未填），所以要分開判 —— 只有
                                       單位都要顯示得到，唔可以整個 span 收埋。 */}
                                {s.unit_price || s.unit ? (
                                  <span className="ml-2 text-xs font-normal text-slate-400">
                                    {s.unit_price ? money(s.unit_price) : ""}
                                    {s.unit ? `${s.unit_price ? " / " : ""}${s.unit}` : ""}
                                  </span>
                                ) : null}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center gap-2 px-2 pb-1">
                            <p className="text-xs text-slate-500">
                              「{supplierScopeName}」的歷史單據未有品項，可以直接輸入品名。
                            </p>
                            <button
                              type="button"
                              /* 同建議 chip 一樣一定要 onPointerDown + preventDefault：
                                 撳落去 input 會先 blur，onBlur 即刻收埋成個清單 ⇒ 撳唔到。 */
                              onPointerDown={(e) => {
                                e.preventDefault();
                                setShowAllItems(true);
                              }}
                              className="rounded-xl bg-white px-3 py-2 text-xs font-semibold text-slate-700 ring-1 ring-slate-200"
                            >
                              顯示全部品項
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3.5 text-base font-semibold text-slate-900 ring-1 ring-slate-200">
            <span>合計</span>
            <span>{money(total)}</span>
          </div>

          {err && (
            <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">{err}</div>
          )}

          {form.id && !askDelete && (
            <button
              type="button"
              onClick={() => setAskDelete(true)}
              className="w-full rounded-2xl border border-red-200 bg-red-50 py-3 text-base font-semibold text-red-600 hover:bg-red-100"
            >
              刪除收據
            </button>
          )}

          {form.id && askDelete && (
            <div className="space-y-2 rounded-2xl border border-red-200 bg-red-50 p-4">
              <p className="text-sm font-medium text-red-800">確定要刪除這張收據嗎？此操作不可復原。</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setAskDelete(false)}
                  className="flex-1 rounded-xl bg-white py-3 text-sm font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void doDelete()}
                  disabled={saving}
                  className="flex-1 rounded-xl bg-red-600 py-3 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
                >
                  {saving ? "刪除中…" : "確定刪除"}
                </button>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="w-full rounded-2xl bg-emerald-600 py-3.5 text-base font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {saving ? (pendingPhotos.length > 0 ? "上傳相片並儲存中…" : "儲存中…") : "儲存收據"}
          </button>
        </div>
      </div>

      {/* 大圖檢視器：本地待上傳（blob URL） */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-black/80 p-4"
          onClick={(e) => {
            e.stopPropagation();
            setLightbox(null);
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightbox.url}
            alt="單據相片"
            className="max-h-[80vh] max-w-full rounded-xl bg-white object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <p className="text-xs text-white/80">{lightbox.label}</p>
          <button
            type="button"
            onClick={() => setLightbox(null)}
            className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-slate-800"
          >
            關閉
          </button>
        </div>
      )}

      {/* 大圖檢視器：已存（private bucket ⇒ 要簽名） */}
      {storedViewer && account && (
        <PhotoViewer account={account} path={storedViewer} onClose={() => setStoredViewer(null)} />
      )}
    </div>
  );
}

export function InventoryView() {
  const [account, setAccount] = useState<string | null>(null);
  const [storeName, setStoreName] = useState<string>("");
  const [merchantId, setMerchantId] = useState<string | null>(null);
  /** 時間範圍（2026-09-13 加「自訂」後升級為 ReportRangeArg）。 */
  const [range, setRange] = useState<ReportRangeArg>("today");
  const [data, setData] = useState<ReceiptsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [formInitial, setFormInitial] = useState<Receipt | null>(null);

  /** 供應商**全部**清單（直接由 merchants 表讀，唔再由收據反推）。 */
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  /** 撞「已存在」時 highlight 返嗰個供應商（設置面板內）。 */
  const [highlightSupplierId, setHighlightSupplierId] = useState<string | null>(null);
  /** 「庫存・設置」面板（供應商＋品類）。 */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 進貨品類清單（來源：`PosLocalSettings.invCategories`）。 */
  const [categories, setCategories] = useState<string[]>([]);
  /**
   * 供應商／品類嘅顯示次序（`PosLocalSettings.invSupplierOrder` / `invCategoryOrder`）。
   * 商家喺設置頁拖 ⠿ 之後寫入，空 = 未排過（供應商跟 DB 字母序、品類跟建立次序）。
   */
  const [supplierOrder, setSupplierOrder] = useState<string[]>([]);
  const [categoryOrder, setCategoryOrder] = useState<string[]>([]);
  /** 單位清單（來源：`PosLocalSettings.invUnits`，2026-10-07）。 */
  const [units, setUnits] = useState<string[]>([]);
  /** 單位顯示次序（`PosLocalSettings.invUnitOrder`；拖 ⠿ 之後先寫入）。 */
  const [unitOrder, setUnitOrder] = useState<string[]>([]);
  /**
   * 庫存表嘅「重載鑰匙」。
   *
   * 🔴 為何需要：主頁嘅 `InventoryTable` 同「設置 → 庫存品」panel 係**兩個
   * component instance**，各自有一份 `products` state。喺設置入面刪咗／改咗一件，
   * 主頁嗰份唔會知 ⇒ 商家閂咗彈窗仲見到「已經刪咗」嘅貨。
   * 用 `key` 換 instance ＝ 強制重新載入（比喺兩個 instance 之間做狀態同步簡單可靠）。
   */
  const [productsVersion, setProductsVersion] = useState(0);

  /**
   * 支付方式主檔（admin 統一設置，`GET /api/inventory/payment-methods`）。
   * 初值用內建預設，避免首屏付款方式 chip 一片空白（會閃一下）。
   */
  const [masterMethods, setMasterMethods] = useState<PaymentMethodDef[]>(DEFAULT_PAYMENT_METHODS);
  const [masterWarning, setMasterWarning] = useState<string | null>(null);

  /** 歷史品項建議（`GET /api/inventory/receipt-items`），開 modal 時用。 */
  const [recentItems, setRecentItems] = useState<ItemSuggestion[]>([]);

  /** 付款方式篩選：`"all"` 或其中一個 method code。 */
  const [methodFilter, setMethodFilter] = useState<string>(ALL_METHODS);
  /** 付款方式 chips 係唔係展開「未用過」嗰批（見 `methodChipGroups`）。 */
  const [showZeroMethods, setShowZeroMethods] = useState(false);

  /**
   * 頁籤：`"overview"`（現有全部內容）或 `"analysis"`（品項分析）。
   *
   * 🔴 為何要分頁而唔係直接加喺下面：
   *    庫存頁已經有 KPI＋收據清單＋庫存表＋5 張圖；再加「品項分析」（自己 4 張 KPI
   *    ＋2 張圖＋一張 10 欄長表）會令單頁變成無限滾動，商家搵唔到嘢。
   *
   * 🔴 分析畫面嘅 fetch 只喺切到該 tab 才發生（`ItemAnalysisView` 係條件 render）
   *    —— 唔可以一開始就掛載，否則「總覽」白白多打一個貴請求（Supabase egress 敏感）。
   *
   * ⚠️ 用 `window.location` 直接讀寫 query 而唔用 `useSearchParams()`：
   *    呢個 component 掛喺 `/inventory` 之下，加 `useSearchParams` 會強制成棵樹
   *    走 client-side render bailout（Next 16 要求包 `<Suspense>`），
   *    而呢個分頁只係「刷新後保留位置」，唔值得為此改動頁面結構。
   *    寫入一律 `replaceState(null, "", pathname + search)`，**唔可以寫死 "/"**。
   */
  const [tab, setTab] = useState<"overview" | "analysis">(() => {
    if (typeof window === "undefined") return "overview";
    return new URLSearchParams(window.location.search).get("tab") === "analysis" ? "analysis" : "overview";
  });

  const switchTab = useCallback((next: "overview" | "analysis") => {
    setTab(next);
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (next === "analysis") params.set("tab", "analysis");
    else params.delete("tab");
    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, []);

  useEffect(() => {
    const s = loadAuthSession();
    if (s?.account) {
      setAccount(s.account);
      setStoreName(s.name || "");
      if (s.merchantId) setMerchantId(s.merchantId);
    }
    const local = loadPosLocalSettings();
    setCategories(local.invCategories);
    setSupplierOrder(local.invSupplierOrder);
    setCategoryOrder(local.invCategoryOrder);
    setUnits(local.invUnits);
    setUnitOrder(local.invUnitOrder);
  }, []);

  /**
   * ☁️ 由雲端補返門店層設定（2026-10-07 · J 實案：「品類的設置似乎沒有同步到雲端」）
   *
   * ## 為何要有呢個 effect（同步斷鏈嘅**第三**個病灶）
   *
   * 1. `patchLocalSettings()` 只寫本機 → 已修（依家會推雲）。
   * 2. `device-settings` 拉雲端嘅閘係死條件 → 已修。
   *    ⚠️ 但嗰個閘只覆蓋「**從未建立過設定嘅新裝置**」（`!hasPosLocalSettings()`）。
   *    一間店用過嘅第二台機永遠行唔到 adopt 分支
   *    ⇒ 品類就算推咗上雲，第二台機照樣顯示「0 個」。呢個 effect 就係補呢個缺口。
   *
   * ## 兩條安全規則（都唔可以放鬆）
   *
   * - **只補空，唔覆寫**：逐欄檢查，本地有值就唔碰（本機優先）。
   *   所以呢個 effect 永遠唔可能令商家已見到嘅資料消失 ——
   *   唔存在「一拉雲端就唔見嘢」嘅風險。
   * - **只喺「本地有欄位係空」時才發請求**：正常裝置（本地已有品類／單位）
   *   **零額外請求** ⇒ 唔會為咗修一個 bug 而增加日常 egress。
   *
   * ⚠️ 刻意**唔**經 `patchLocalSettings()`（嗰個會推雲）：拉落嚟嘅嘢唔需要即刻推返上去，
   *    否則兩台機會互相推來推去。亦刻意**唔**喺拉完之後回寫雲端。
   *
   * ⚠️ 失敗（離線 / 401 / 未登入）一律靜默保持本機值 —— 拉唔到唔可以清空任何嘢。
   */
  const cloudHydrateDone = useRef(false);
  useEffect(() => {
    if (!merchantId || cloudHydrateDone.current) return;
    const local = loadPosLocalSettings();
    // 本地齊全 → 唔需要拉（保持零 egress）。
    const nothingMissing =
      local.invCategories.length > 0 &&
      local.invUnits.length > 0 &&
      local.invSupplierOrder.length > 0;
    if (nothingMissing) {
      cloudHydrateDone.current = true;
      return;
    }
    cloudHydrateDone.current = true; // 標記咗先，避免 StrictMode 開發模式重複打
    let cancelled = false;
    const storeId = merchantId;
    void (async () => {
      try {
        const res = await fetch(`/api/pos/device-config?storeId=${encodeURIComponent(storeId)}`, {
          headers: await posDeviceAuthHeadersFresh(),
          cache: "no-store",
        });
        if (!res.ok) return;
        const payload = (await res.json()) as { ok?: boolean; localSettings?: PosLocalSettings | null };
        if (cancelled || !payload.ok || !payload.localSettings) return;
        const cloud = normalizePosLocalSettings(payload.localSettings);
        const base = loadPosLocalSettings();
        // 逐欄「只補空」——本地已有值嘅欄位一律唔碰。
        const patch: Partial<PosLocalSettings> = {};
        if (base.invCategories.length === 0 && cloud.invCategories.length > 0) {
          patch.invCategories = cloud.invCategories;
        }
        if (base.invUnits.length === 0 && cloud.invUnits.length > 0) patch.invUnits = cloud.invUnits;
        if (base.invSupplierOrder.length === 0 && cloud.invSupplierOrder.length > 0) {
          patch.invSupplierOrder = cloud.invSupplierOrder;
        }
        if (base.invCategoryOrder.length === 0 && cloud.invCategoryOrder.length > 0) {
          patch.invCategoryOrder = cloud.invCategoryOrder;
        }
        if (base.invUnitOrder.length === 0 && cloud.invUnitOrder.length > 0) {
          patch.invUnitOrder = cloud.invUnitOrder;
        }
        if (Object.keys(patch).length === 0) return; // 雲端都係空 → 冇嘢好補
        const merged = normalizePosLocalSettings({ ...base, ...patch });
        savePosLocalSettings(merged);
        setCategories(merged.invCategories);
        setSupplierOrder(merged.invSupplierOrder);
        setCategoryOrder(merged.invCategoryOrder);
        setUnits(merged.invUnits);
        setUnitOrder(merged.invUnitOrder);
      } catch {
        // 離線 / 未登入 / 401 → 保持本機值（拉唔到唔可以清空任何嘢）。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [merchantId]);

  const loadAll = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    setError(null);
    try {
      const { key, custom } = splitReportRangeArg(range);
      const qs = new URLSearchParams({ account, range: key });
      if (key === "custom" && custom) {
        qs.set("start", custom.start);
        qs.set("end", custom.end);
      }
      const res = await fetch(`/api/inventory/receipts?${qs.toString()}`);
      const json = (await res.json()) as ReceiptsResponse;
      setData(json);
      if (!json.ok && json.error) setError(json.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [account, range]);

  useEffect(() => {
    if (account) void loadAll();
  }, [account, loadAll]);

  const receipts = useMemo(() => data?.receipts ?? [], [data]);
  const rangeLabel = reportRangeLabel(range);

  /**
   * 🔴 2026-09-25：供應商改由 `GET /api/inventory/merchants` 讀全量。
   * 舊寫法係由「range 過濾後嘅 receipts」反推 ⇒ 冇收據嘅供應商唔會出現、
   * 換 range 又會消失，係「新增咗但睇唔到」同「重複新增撞 key」嘅根因。
   */
  const loadSuppliers = useCallback(async () => {
    if (!account) return;
    try {
      const res = await fetch(`/api/inventory/merchants?account=${encodeURIComponent(account)}`);
      const json = (await res.json()) as { ok?: boolean; merchants?: Array<{ id: string; name: string }> };
      if (json.ok && Array.isArray(json.merchants)) {
        setSuppliers(
          json.merchants
            .map((m) => ({ id: String(m.id), name: String(m.name ?? "") }))
            .filter((m) => m.id && m.name),
        );
      } else setSuppliers([]);
    } catch {
      setSuppliers([]);
    }
  }, [account]);

  useEffect(() => {
    void loadSuppliers();
  }, [loadSuppliers]);

  /** 讀 admin 支付方式主檔（一個細請求，失敗都用內建預設頂住）。 */
  const loadPaymentMethods = useCallback(async () => {
    try {
      const res = await fetch(`/api/inventory/payment-methods`);
      const json = (await res.json()) as {
        ok?: boolean;
        methods?: PaymentMethodDef[];
        warning?: string;
      };
      if (json.ok && Array.isArray(json.methods)) {
        setMasterMethods(json.methods);
        setMasterWarning(json.warning ?? null);
      }
    } catch {
      // 網絡問題：維持內建預設，唔中斷庫存頁。
    }
  }, []);

  useEffect(() => {
    void loadPaymentMethods();
  }, [loadPaymentMethods]);

  /** 讀歷史品項（用嚟做新增收據嘅快速選取）。 */
  const loadRecentItems = useCallback(async () => {
    if (!account) return;
    try {
      const res = await fetch(`/api/inventory/receipt-items?account=${encodeURIComponent(account)}`);
      const json = (await res.json()) as { ok?: boolean; items?: ItemSuggestion[] };
      if (json.ok && Array.isArray(json.items)) setRecentItems(json.items);
      else setRecentItems([]);
    } catch {
      setRecentItems([]);
    }
  }, [account]);

  useEffect(() => {
    void loadRecentItems();
  }, [loadRecentItems]);

  /**
   * 寫入門店層設定（`PosLocalSettings`）並把相關 state 同步返嚟。
   *
   * ⚠️ 一定要經 `normalizePosLocalSettings()` 合併：呢個函式係**逐欄重建**，
   * 直接 `savePosLocalSettings({ invCategories })` 會靜靜剷走其餘欄位
   * （打印模板、樓層…）。所有局部更新一律經呢個入口。
   *
   * 🔴🔴 2026-10-07 修（J 實案：另一台電腦加咗品類，其他機永遠睇唔到）：
   *    以前呢個函式**只寫 localStorage**，全個 repo 冇任何一行把 `invCategories`
   *    推上雲 ⇒ 品類係「本機私有」嘅。商家嘅心理模型係「設置就係全店共用」
   *    （供應商做得到，因為供應商走 expenseRecorder `merchants` 表），
   *    呢個落差令佢以為「已保存」。所以寫本機之後**一定要推雲**。
   *
   * ## 推雲嘅兩個死穴（都係照抄 `device-settings.tsx` 嘅既有口徑）
   *
   * 1. **一定要剝走返結 temp 枱**：`localSettings.floors` 內含
   *    `temp-reopen-*`（返結單編輯期間嘅暫存枱）。原封不動推上雲會令佢
   *    永久升級做真實枱（見 `lib/pos/table-scope.ts` 嘅鐵律表）。
   *    `device-settings` 兩處推雲（L636 / L912）都做咗 `stripReopenTempTables()`。
   * 2. **`localSettings` 要同 deviceConfig 一齊送**：`POST /api/pos/device-config`
   *    係 `upsert(..., { onConflict: "device_id" })`，一次過寫 device 欄位
   *    ＋ `local_settings`。所以 body 係 `{ ...updatedConfig, localSettings }`；
   *    只送 `{ storeId, localSettings }` 會令 `device_id` 變 null 而炸。
   *
   * ## 失敗策略（同 `device-settings` 一致）
   *
   * 本機已寫入 = **資料唔會丟**。雲端推失敗（離線／401／5xx）只記 warning，
   * 唔 rollback、唔 throw —— 商家下次開「設備設定頁」按保存時會全量重推。
   */
  const patchLocalSettings = useCallback(async (patch: Partial<PosLocalSettings>) => {
    const merged = normalizePosLocalSettings({ ...loadPosLocalSettings(), ...patch });
    savePosLocalSettings(merged);
    setCategories(merged.invCategories);
    setSupplierOrder(merged.invSupplierOrder);
    setCategoryOrder(merged.invCategoryOrder);
    setUnits(merged.invUnits);
    setUnitOrder(merged.invUnitOrder);

    // ── 推雲（best-effort；本機已寫入，失敗唔影響商家操作） ──
    const storeId = loadAuthSession()?.merchantId;
    if (!storeId) return;
    const deviceConfig = loadDeviceConfig();
    if (!deviceConfig) return; // 未初始化設備設定 → 交返「設備設定頁」首次保存去建
    try {
      const serverSettings: PosLocalSettings = {
        ...merged,
        floors: stripReopenTempTables(merged.floors),
      };
      const res = await fetch("/api/pos/device-config", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await posDeviceAuthHeadersFresh()) },
        body: JSON.stringify({
          ...deviceConfig,
          storeId,
          updatedAt: new Date().toISOString(),
          localSettings: serverSettings,
        }),
      });
      if (!res.ok) {
        console.warn(
          `[inventory] 門店設定推雲失敗（HTTP ${res.status}）：本機已保存，稍後喺「設備設定」按保存會補推。`,
        );
      }
    } catch {
      // 離線 / 網絡錯誤 → 同上，靜默（本機已寫入，唔可以中斷商家流程）。
    }
  }, []);

  /** 儲存品類清單（門店層設定，經 `PosLocalSettings` 同步）。 */
  const saveCategories = useCallback(
    async (next: string[]) => patchLocalSettings({ invCategories: next }),
    [patchLocalSettings],
  );

  /** 儲存單位清單（2026-10-07；同 `saveCategories` 同一通道）。 */
  const saveUnits = useCallback(async (next: string[]) => patchLocalSettings({ invUnits: next }), [patchLocalSettings]);

  /** 儲存單位顯示次序（拖 ⠿ 之後）。 */
  const saveUnitOrder = useCallback(
    async (next: string[]) => patchLocalSettings({ invUnitOrder: next }),
    [patchLocalSettings],
  );

  /** 儲存供應商顯示次序（拖 ⠿ 之後）。 */
  const saveSupplierOrder = useCallback(
    async (next: string[]) => patchLocalSettings({ invSupplierOrder: next }),
    [patchLocalSettings],
  );

  /** 儲存品類顯示次序（拖 ⠿ 之後）。 */
  const saveCategoryOrder = useCallback(
    async (next: string[]) => patchLocalSettings({ invCategoryOrder: next }),
    [patchLocalSettings],
  );

  /**
   * 🔴 2026-10-07（P2 項目 2）：收據有寫入之後，**主動觸發一次庫存同步**。
   *
   * 為何唔可以只靠「進入頁面時同步」：
   *   商家 typischerweise 流程 = 入一張新收據 → 去庫存頁睇下成本有冇變。
   *   如果同步只喺「進入頁面」做，而商家**已經**喺庫存頁（App Router 唔會
   *   因為你切 tab 而重新 mount），佢就會見到舊數字，以為同步壞咗。
   *
   * ⚠️ 所以呢度係「進頁面同步」嘅**互補**，唔係替代：
   *    · 進頁面同步 = 兜底（處理喺 expenseRecorder 直接改資料、或另一部機入單）
   *    · 寫入後同步 = 即時（處理「剛剛入完單想即刻睇」）
   *
   * 🔴 **fire-and-forget，唔可以 await、唔可以 throw**：
   *    收據已經存好（主體成功），庫存同步失敗唔應該令商家以為儲存失敗。
   *    失敗時靜默 —— 下次進頁面會自動補做。
   */
  const syncProductsAfterReceiptWrite = useCallback(() => {
    void fetch(`/api/inventory/products/sync-from-receipts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ store: merchantId, account, mode: "auto" }),
    })
      .then((res) => res.json())
      .then((json: { ok?: boolean; summary?: { created: number; updated: number } }) => {
        if (!json?.ok) return;
        // 有真嘅變化 → 通知外層庫存表換 instance 重載（否則顯示舊數字）
        if ((json.summary?.created ?? 0) > 0 || (json.summary?.updated ?? 0) > 0) {
          setProductsVersion((n) => n + 1);
        }
      })
      .catch(() => {
        /* 靜默：離線／網絡問題唔阻流程 */
      });
  }, [merchantId, account]);

  /** 進貨可見嘅付款方式（主檔 + scope 過濾）。 */
  const purchaseMethods = useMemo(() => paymentMethodsForScope(masterMethods, "purchase"), [masterMethods]);

  /** code → 顯示名（主檔優先，內建標籤兜底，令舊單據嘅 key 唔會變裸英文）。 */
  const labelMap = useMemo(() => paymentMethodLabelMap(masterMethods), [masterMethods]);

  /**
   * 品類清單要跟商家喺設置頁拖好嘅次序（`categoryOrder`）。
   * 唔跟就會出現「設置入面排好、開單時又變返原本次序」＝排序等於冇用。
   */
  const orderedCategories = useMemo(
    () => reorderByStored(categories, categoryOrder, (c) => c),
    [categories, categoryOrder],
  );

  /** 供應商下拉選單亦跟拖好嘅次序（同一個來源，開單時唔使搵）。 */
  const orderedSuppliers = useMemo(
    () => reorderByStored(suppliers, supplierOrder, (s) => s.name),
    [suppliers, supplierOrder],
  );

  /** 單位下拉選單亦跟拖好嘅次序（2026-10-07，同品類完全一致）。 */
  const orderedUnits = useMemo(() => reorderByStored(units, unitOrder, (u) => u), [units, unitOrder]);

  /**
   * 付款方式篩選（2026-09-25 加）：client-side 過濾，**零新增請求**。
   * 由範圍查詢本身已經拉齊晒 range 內嘅收據，喺本機再揀付款方式最慳 egress。
   */
  const methodCounts = useMemo(() => {
    const map = new Map<string, number>();
    // normalize：expenseRecorder 舊資料有機會存中文（「月結」），server 雖然已經正規化，
    // 呢度再兜一次，確保「月結」chip 數得到。
    for (const r of receipts) {
      const key = normalizePaymentMethod(r.payment_method);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [receipts]);

  /**
   * 篩選 chip 嘅 key 集合 = **主檔全部 code** ∪ **當前資料出現過嘅 code**。
   *
   * 為何唔淨係用主檔：admin 停用／改走某個 code 之後，舊收據照樣存住嗰個 code。
   * 若 chip 只跟主檔，嗰批舊單就會**冇任何 chip 撳得到**（＝篩選唔到，亦睇唔出有幾多張）。
   * 為何唔淨係用資料：呢個正是 2026-09-25「睇唔到有月結選項」嘅根因
   * —— 當月結收據數為 0，chip 就完全唔出現，商家以為冇呢個功能。
   */
  const methodFilterKeys = useMemo(() => {
    const keys: string[] = [];
    const push = (k: string) => {
      if (k && !keys.includes(k)) keys.push(k);
    };
    for (const m of masterMethods) push(m.code);
    for (const r of receipts) push(normalizePaymentMethod(r.payment_method));
    return keys;
  }, [masterMethods, receipts]);

  /**
   * 篩選 chip 分兩組（2026-09-26 對齊確認稿）：
   *   · `withData`：**有資料嘅**（確認稿只顯示呢批，例：全部7 / 現金3 / 月結2）
   *   · `zero`：主檔有、但**當前範圍 0 筆**嘅（默認收埋）
   *
   * 🔴 為何唔可以直接「只顯示有資料嘅」：呢個正是 2026-09-25 嘅原 bug
   * —— 月結收據 0 張時 chip 完全唔出現，商家以為系統冇月結呢個選項。
   * 所以零筆數嘅唔刪、只係收起，用「＋N 個未用過」一撳就展開。
   *
   * 🔴 當前**已選中**嘅 key 一定唔可以收埋：否則「撳完月結再收埋」會出現
   * 「篩選中但冇 chip 顯示」＝用戶以為篩選失效（實際上表已經被過濾）。
   */
  const methodChipGroups = useMemo(() => {
    const withData: Array<{ key: string; label: string }> = [];
    const zero: Array<{ key: string; label: string }> = [];
    for (const key of methodFilterKeys) {
      const count = methodCounts.get(key) ?? 0;
      const item = { key, label: `${labelMap[key] ?? key}（${count}）` };
      if (count > 0 || key === methodFilter) withData.push(item);
      else zero.push(item);
    }
    // 有資料嘅按筆數多寡排（商家最常用嘅付款方式排最前，唔使橫向掃）。
    withData.sort((a, b) => (methodCounts.get(b.key) ?? 0) - (methodCounts.get(a.key) ?? 0));
    return { withData, zero };
  }, [methodFilterKeys, methodCounts, labelMap, methodFilter]);

  const methodFilterOptions = useMemo(
    () => [
      { key: ALL_METHODS, label: `全部（${receipts.length}）` },
      ...methodChipGroups.withData,
      ...(showZeroMethods ? methodChipGroups.zero : []),
    ],
    [receipts.length, methodChipGroups, showZeroMethods],
  );

  const visibleReceipts = useMemo(
    () =>
      methodFilter === ALL_METHODS
        ? receipts
        : receipts.filter((r) => normalizePaymentMethod(r.payment_method) === methodFilter),
    [receipts, methodFilter],
  );

  /**
   * KPI／統計一定要跟住篩選行，否則「淨睇月結」時上面嘅總支出仍然係全部付款方式，
   * 兩個數字互相打臉。server 只計 range，所以非「全部」時喺本機用同一個
   * `buildPurchaseSummary()` 重算（純函式，口徑同 server 一致）。
   */
  const summary: PurchaseSummary | undefined = useMemo(() => {
    if (!data) return undefined;
    if (methodFilter === ALL_METHODS) return data.summary;
    return buildPurchaseSummary(visibleReceipts);
  }, [data, methodFilter, visibleReceipts]);

  const methodLabel = methodFilter === ALL_METHODS ? "" : `${labelMap[methodFilter] ?? methodFilter}・`;

  const openReceiptModal = (r: Receipt | null) => {
    setFormInitial(r);
    setFormOpen(true);
    void loadRecentItems();
  };

  if (!account) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-50 p-6 text-slate-500">
        請先登入 POS 才能檢視庫存。
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-slate-50 p-4 text-slate-900 md:p-6">
      <div className="mx-auto max-w-[1600px]">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">庫存管理</h1>
            <p className="text-sm text-slate-500">
              店別：{storeName || account} ・ 帳號：{account}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => openReceiptModal(null)}
              className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white"
            >
              ＋ 新增收據
            </button>
            {/* 供應商／品類由主頁搬入「設置」：避免每日用嘅收據清單被主檔管理推到下面，
                同時令刪除供應商呢類破壞性操作多一步（觸屏誤觸成本高）。 */}
            <button
              onClick={() => {
                setHighlightSupplierId(null);
                setSettingsOpen(true);
              }}
              className="rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-slate-700 ring-1 ring-slate-200"
            >
              設置
            </button>
            <button
              onClick={() => void loadAll()}
              className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white"
            >
              重新整理
            </button>
          </div>
        </header>

        {/* 頁籤（2026-10-07：「品項分析」新功能。見上方 tab state 註釋）
            ⚠️ 「新增收據」掣留喺 header 係刻意嘅 —— 佢喺兩個 tab 都用得著。
            時間／付款方式篩選則只屬「總覽」（收據統計），故收喺 overview 分支內。 */}
        <div className="mb-4 flex flex-wrap gap-2">
          {(
            [
              { key: "overview", label: "總覽" },
              { key: "analysis", label: "品項分析" },
            ] as const
          ).map((t) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => switchTab(t.key)}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-[40px] items-center rounded-2xl px-4 py-2 text-sm font-semibold transition ${
                  active ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {tab === "analysis" ? (
          <ItemAnalysisView
            account={account}
            merchantId={merchantId}
            supplierOrder={supplierOrder}
            categoryOrder={categoryOrder}
          />
        ) : (
          <>
        {/* 時間篩選（2026-09-13：改用共用元件，加「自訂」） */}
        <div className="mb-4 flex flex-wrap gap-2">
          <DateRangeFilterChips
            options={REPORT_RANGE_OPTIONS}
            value={splitReportRangeArg(range).key}
            custom={splitReportRangeArg(range).custom}
            onChange={(key, custom) => setRange(custom ? { key, custom } : key)}
          />
        </div>

        {/* 付款方式篩選（2026-09-25：改由 admin 主檔驅動；2026-09-26：零筆數收埋） */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-500">付款方式</span>
          <DateRangeFilterChips
            options={methodFilterOptions}
            value={methodFilter}
            onChange={(key) => setMethodFilter(key)}
          />
          {methodChipGroups.zero.length > 0 && (
            <button
              type="button"
              onClick={() => setShowZeroMethods((v) => !v)}
              className="inline-flex min-h-[36px] items-center rounded-full px-3 py-1.5 text-xs font-semibold text-slate-500 underline decoration-dotted hover:text-slate-700"
            >
              {showZeroMethods ? "收埋未用過嘅" : `＋${methodChipGroups.zero.length} 個未用過`}
            </button>
          )}
        </div>

        {masterWarning && (
          <div className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
            {masterWarning}
          </div>
        )}
        {data && data.schemaReady === false && (
          <div className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
            expenseRecorder 資料表尚未建立（receipts 不存在）。請在 expenseRecorder 專案執行 supabase_schema.sql。
          </div>
        )}
        {data && data.matched === false && (
          <div className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
            在 expenseRecorder 找不到與此 8 位帳號相同的店戶，暫無可顯示的收據。
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">{error}</div>
        )}
        {/* KPI */}
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">
              {rangeLabel}
              {methodLabel}總支出
            </div>
            <div className="mt-1 text-lg font-semibold text-slate-900">{money(summary?.total ?? 0)}</div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">收據數</div>
            <div className="mt-1 text-lg font-semibold text-slate-900">
              {summary?.count ?? 0}
              {methodFilter !== ALL_METHODS && visibleReceipts.length !== receipts.length ? (
                <span className="ml-1 text-xs font-normal text-slate-400">／{receipts.length}</span>
              ) : null}
            </div>
          </div>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <div className="text-xs text-emerald-700">已付</div>
            <div className="mt-1 text-lg font-semibold text-emerald-700">{money(summary?.paid ?? 0)}</div>
          </div>
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <div className="text-xs text-amber-700">未付</div>
            <div className="mt-1 text-lg font-semibold text-amber-700">{money(summary?.unpaid ?? 0)}</div>
          </div>
        </div>

        {/* 收據清單：點擊任意位置開啟置中 modal（編輯+刪除） */}
        <section className="mb-6">
          <h2 className="mb-3 text-sm font-medium text-slate-600">
            收據清單（expenseRecorder・{rangeLabel}
            {methodFilter !== ALL_METHODS ? `・${labelMap[methodFilter] ?? methodFilter}` : ""}）
            <span className="ml-2 text-xs font-normal text-slate-400">
              共 {visibleReceipts.length} 張
              {methodFilter !== ALL_METHODS ? `（全部付款方式 ${receipts.length} 張）` : ""} ・ 點擊任一卡片開啟編輯
            </span>
          </h2>
          {loading ? (
            <p className="text-sm text-slate-500">載入中…</p>
          ) : receipts.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
              尚無收據。點擊「新增收據」建立第一張。
            </div>
          ) : visibleReceipts.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
              {rangeLabel}內冇「{labelMap[methodFilter] ?? methodFilter}」嘅收據（共 {receipts.length} 張其他付款方式）。
              <button type="button" className="ml-2 underline" onClick={() => setMethodFilter(ALL_METHODS)}>
                睇全部
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {visibleReceipts.map((r) => {
                const paid = r.payment_status === "paid";
                const lineNo = r.raw_ocr_data?.receipt_number;
                const stamp = receiptStampLabel(r.receipt_date, r.created_at);
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => openReceiptModal(r)}
                    className="rounded-2xl border border-slate-200 bg-white p-4 text-left transition hover:border-slate-400 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-slate-300"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-base font-medium text-slate-900">{r.merchant_name}</div>
                        {/* 🔴 2026-10-07：時間格式改為「年/月/日 時:分:秒」。
                            時分秒來源係 created_at（錄入時間），因為 receipt_date 只有日期。
                            補登舊單時兩者會唔同日 ⇒ 加註「時間為錄入時間」避免誤會。 */}
                        <div className="mt-0.5 text-xs text-slate-500 tabular-nums">
                          {stamp.primary}
                          {lineNo ? ` ・ #${lineNo}` : ""} ・ {r.items.length} 項
                        </div>
                        {stamp.note && (
                          <div className="mt-0.5 text-[11px] text-slate-400">{stamp.note}</div>
                        )}
                        <div className="mt-0.5 text-xs text-slate-400">
                          付款方式：{labelMap[normalizePaymentMethod(r.payment_method)] ?? r.payment_method}
                        </div>
                        {r.category && (
                          <div className="mt-1 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                            {r.category}
                          </div>
                        )}
                        {/* 2026-10-07（P3）：相片數標記。清單唔出縮圖（要逐張簽 URL＝貴），
                            只標「📷 N」提示有相，撳入 modal 才載入。 */}
                        {(r.photo_paths?.length ?? 0) > 0 && (
                          <div className="ml-1 mt-1 inline-block rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700 ring-1 ring-sky-200">
                            📷 {r.photo_paths!.length}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <div className="text-base font-semibold text-slate-900">{money(r.total_amount)}</div>
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                            paid
                              ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                              : "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
                          }`}
                        >
                          {paid ? "已付款" : "未付款"}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* 庫存表（POS 內建庫存概念）
            `key={productsVersion}`：設置面板改過庫存品之後強制換 instance 重載，
            否則呢份 state 唔會知（見 `productsVersion` 嘅註釋）。 */}
        {merchantId && (
          <InventoryTable key={productsVersion} merchantId={merchantId} account={account} />
        )}

        {/* 統計（多圖表） */}
        {summary && summary.count > 0 && (
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="mb-2 text-sm font-semibold text-slate-700">近 6 月支出</div>
              <AreaChart data={summary.monthlyExpenses.map((m) => ({ label: m.name, value: m.amount }))} />
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="mb-2 text-sm font-semibold text-slate-700">供應商支出佔比（Top 8）</div>
              <DonutChart data={summary.supplierStats.slice(0, 8).map((s) => ({ label: s.name, value: s.total }))} />
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="mb-2 text-sm font-semibold text-slate-700">付款方式分佈</div>
              {summary.paymentMethodBreakdown.length === 0 ? (
                <div className="text-sm text-slate-400">無資料</div>
              ) : (
                <DonutChart
                  data={summary.paymentMethodBreakdown.map((b) => ({
                    label: labelMap[b.method] ?? b.label,
                    value: b.total,
                  }))}
                />
              )}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="mb-2 text-sm font-semibold text-slate-700">付款狀態</div>
              <DonutChart
                data={[
                  { label: "已付", value: summary.paid },
                  { label: "未付", value: summary.unpaid },
                ]}
              />
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 xl:col-span-2">
              <div className="mb-2 text-sm font-semibold text-slate-700">價格漲跌趨勢（按月）</div>
              <LineChart data={summary.priceTrendSeries.map((p) => ({ label: p.name, up: p.up, down: p.down }))} />
            </div>

            <div className="flex gap-3">
              <div className="flex-1 rounded-2xl border border-red-200 bg-red-50 p-4">
                <div className="text-xs text-red-700">價格上漲項</div>
                <div className="mt-1 text-2xl font-semibold text-red-700">{summary.trend.up}</div>
              </div>
              <div className="flex-1 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                <div className="text-xs text-emerald-700">價格下降項</div>
                <div className="mt-1 text-2xl font-semibold text-emerald-700">{summary.trend.down}</div>
              </div>
            </div>
          </section>
        )}

        {/* 底部提示條（確認稿嘅 footnote）：講清「主檔管理已經收埋入設置」，
            並留一個直接入口 —— 商家撳完就唔會再喺主頁搵唔到供應商管理。 */}
        <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-3">
          <p className="text-xs leading-relaxed text-slate-500">
            供應商／品類嘅新增・修改・刪除已經收埋入「設置」，主頁唔再顯示（唔常用嘅操作唔霸版面）。
          </p>
          <button
            type="button"
            onClick={() => {
              setHighlightSupplierId(null);
              setSettingsOpen(true);
            }}
            className="shrink-0 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 ring-1 ring-slate-200"
          >
            前往設置 →
          </button>
        </div>
          </>
        )}
      </div>

      <ReceiptFormModal
        open={formOpen}
        initial={formInitial}
        suppliers={orderedSuppliers}
        categories={orderedCategories}
        units={orderedUnits}
        paymentMethods={purchaseMethods}
        labelMap={labelMap}
        recentItems={recentItems}
        account={account}
        onClose={() => setFormOpen(false)}
        onSaved={() => {
          void loadAll();
          void loadSuppliers();
          void loadRecentItems();
          // 🔴 2026-10-07（P2）：收據寫入（新增／編輯／刪除）後主動同步庫存品 ——
          //    商家「入完單即刻想睇成本」係最常見流程，唔可以等佢離開再入頁面。
          syncProductsAfterReceiptWrite();
        }}
        onSuppliersChanged={async () => {
          await loadSuppliers();
        }}
      />

      <InventorySettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        account={account}
        merchantId={merchantId}
        suppliers={suppliers}
        onSuppliersChanged={async () => {
          await loadSuppliers();
          await loadAll();
        }}
        supplierOrder={supplierOrder}
        onSaveSupplierOrder={saveSupplierOrder}
        categories={categories}
        categoryOrder={categoryOrder}
        onSaveCategories={saveCategories}
        onSaveCategoryOrder={saveCategoryOrder}
        units={units}
        unitOrder={unitOrder}
        onSaveUnits={saveUnits}
        onSaveUnitOrder={saveUnitOrder}
        paymentMethods={masterMethods}
        paymentWarning={masterWarning}
        highlightSupplierId={highlightSupplierId}
        onProductsChanged={() => setProductsVersion((n) => n + 1)}
      />
    </div>
  );
}
