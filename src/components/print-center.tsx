"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatMacauDateTime } from "@/lib/format";

import { AppSidebar } from "@/components/app-sidebar";
import { ResponsiveModal } from "@/components/responsive-modal";
import { EscPosPreview } from "@/components/escpos-preview";
import { KitchenTicketPreview } from "@/components/kitchen-ticket-preview";
import { retryFailedPrintJob } from "@/lib/print-bridge/dispatch";
import { isNativeBridgeAvailable } from "@/lib/print-bridge/native";
import { isCompanionConfigured } from "@/lib/print-bridge/companion-config";
import { isRelayConfigured } from "@/lib/print-bridge/relay-config";
import { resolveStoreId, withStoreScope } from "@/lib/pos/sync-flush";
import { buildKitchenPrintJobs, buildLabelPrintJobs, clearFailedPrintJobs, clearPrintedPrintJobs, clearSentPrintJobs, findPosOrderForLedger, normalizePrintJobStatus } from "@/lib/print-jobs";
import {
  getLocalSettingsKey,
  loadBootstrapCache,
  loadDeviceConfig,
  loadOrders,
  loadPosLocalSettings,
  loadPrintJobs,
  loadPrintTemplateSyncMeta,
  loadQueue,
  savePosLocalSettings,
  savePrintJobs,
  savePrintTemplateSyncMeta,
  saveQueue,
} from "@/lib/storage";
import { useNetworkOnline } from "@/lib/use-network-online";
import { defaultDeviceConfig, defaultPosLocalSettings } from "@/lib/mock-data";
import { DeviceConfig, EscPosAlign, EscPosBlockStyle, EscPosSize, LABEL_PAPER_PRESETS, PosLocalSettings, PosOrder, PrintJob, PrintTemplateKind, QueueEvent, ShiftSectionId, ShiftTemplate, ShiftTemplateVariant } from "@/lib/types";
import {
  ledgerReportRangeForKey,
  macauDateKey,
  type ReportRangeKey,
} from "@/lib/ledger/report-period";
import {
  buildKitchenContent,
  buildLabelContent,
  buildReceiptContent,
  buildShiftContent,
  buildSnapshot,
  cloneShiftTemplate,
  ensureDividerSection,
  ensureReceiptSections,
  KITCHEN_SECTION_META,
  LABEL_SECTION_META,
  labelPaperPreset,
  normalizeShiftTemplate,
  RECEIPT_SECTION_META,
  resolveActiveShiftPresetName,
  SHIFT_SECTION_META,
  withLabelFixedSizes,
} from "@/lib/escpos-template";
import { EscPosLine, RECEIPT_PAPER_COLUMNS, RECEIPT_PAPER_COLUMNS_58MM, renderEscPosLines, toPrintItemLines } from "@/lib/escpos-render";
import { encodeQrPayload, QR_QUIET_MODULES, QR_SIZE_FRACTION, QR_SIZE_LABEL } from "@/lib/escpos-qr";
import {
  PREVIEW_KITCHEN_ORDER,
  PREVIEW_LABEL_ITEM,
  PREVIEW_QR_URL,
  PREVIEW_RECEIPT_ORDER,
  PREVIEW_SERVER_NAME,
  PREVIEW_STORE_NAME,
  PREVIEW_STORE_TEL,
  SHIFT_PREVIEW_SAMPLE,
} from "@/lib/preview-fixtures";
import { resolveStoreTel } from "@/lib/pos/store-tel";
import { notifyQueueChanged } from "@/lib/pos/sync-flush";
import { enqueueEvents } from "@/lib/pos/queue-outbox";
import {
  fetchStorePrintTemplates,
  pushStorePrintTemplates,
} from "@/lib/print-templates-sync";

/**
 * 模板設計介面嘅五個槽位。注意 `"kiosk"` 係**模版內容**嘅槽位，唔係 ESC/POS `kind`：
 * 渲染嗰陣一律用 `kind = "receipt"`（見 `KioskPreviewKind`），三個 repo 先唔使改。
 *
 * `"shift"`（2026-09-10「交班模板」）係真正嘅第五個槽位，渲染用 `kind = "shift"`：
 * 下游唔識呢個 kind → 抬頭 fall through 去空字串（唔會印錯），交班單抬頭由模板
 * `header` 區塊自己帶，所以三個 repo 零改動都用得。
 */
type TemplateKindState = "receipt" | "label" | "kitchen" | "kiosk" | "shift";

const SECTION_META: Record<TemplateKindState, { id: string; label: string }[]> = {
  receipt: RECEIPT_SECTION_META as unknown as { id: string; label: string }[],
  label: LABEL_SECTION_META as unknown as { id: string; label: string }[],
  kitchen: KITCHEN_SECTION_META as unknown as { id: string; label: string }[],
  // 自助點餐機模版同收據係同一組區塊（規格 8：格式完全一致）
  kiosk: RECEIPT_SECTION_META as unknown as { id: string; label: string }[],
  // 交班結算單：冇菜品明細，一項一個區塊（見 ShiftSectionId）
  shift: SHIFT_SECTION_META as unknown as { id: string; label: string }[],
};

/**
 * docs/87 §2.3：自助點餐機模版係獨立槽位，但渲染時嘅 ESC/POS `kind` 必須係 `"receipt"`。
 * 三個下游 repo（POS / desktop-companion / print-agent-android）嘅標題表只認
 * `receipt | label | kitchen`，傳 `"kiosk"` 會 fallthrough 到空標題。
 *
 * 交班單（`"shift"`）唔需要映射 —— 佢**本來就係** fallthrough 到空標題，
 * 頭由模板 `header` 區塊帶，見 `ShiftTemplate` 註釋。
 */
function snapshotKindOf(kind: TemplateKindState): PrintTemplateKind {
  return kind === "kiosk" ? "receipt" : kind;
}

// ⚠️ 預覽資料一律嚟自 `src/lib/preview-fixtures.ts` 嘅**固定範例單**（2026-09-10）。
// 以前係「抽商家最新一張真實訂單（`orders[0]`），抽唔到先用假單」——
// 真單通常無折扣 / 無服務費 / 無稅 / 無抹零，呢啲區塊會全部隱形，
// 商家永遠睇唔到完整版面；而且唔同時段開設計頁見到唔同嘢，報 bug 都對唔上。

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function ticketTypeLabel(type: PrintJob["ticketType"]) {
  if (type === "addon") return "加單";
  if (type === "void") return "退菜";
  return "正常";
}

/**
 * 二維碼網址欄位下嘅即時生成圖像預覽（按「生成」或網址/大小有變時即時重畫）。
 *
 * 用同 `EscPosPreview` 一致嘅 encodeQrPayload 點陣 → 簡單 SVG 方格，白底黑點。
 * 網址空白 / 太長 → 顯示「未生成」佔位，唔會留空框。`size` 控制顯示大細（細/中/大）。
 */
function QrFieldPreview({ url, size }: { url: string; size: EscPosSize }) {
  const payload = encodeQrPayload(url);
  // 同 EscPosPreview 一致：QR v1 最少都要 ~90px 先睇到
  const total = payload ? payload.size + QR_QUIET_MODULES * 2 : 0;
  const px = payload ? Math.max(90, Math.round(180 * QR_SIZE_FRACTION[size])) : 0;
  const rects: React.ReactElement[] = [];
  if (payload) {
    const cell = px / total;
    for (let r = 0; r < payload.size; r++) {
      for (let c = 0; c < payload.size; c++) {
        if (payload.bits[r * payload.size + c] === "1") {
          rects.push(
            <rect
              key={`${r}-${c}`}
              x={(c + QR_QUIET_MODULES) * cell}
              y={(r + QR_QUIET_MODULES) * cell}
              width={cell + 0.5}
              height={cell + 0.5}
              fill="#0f172a"
            />,
          );
        }
      }
    }
  }
  return (
    <div className="mt-1 flex items-center gap-3">
      <div className="shrink-0 rounded-xl border border-slate-200 bg-white p-2" style={{ width: px + 16, height: px + 16 }}>
        {payload ? (
          <svg width={px} height={px} viewBox={`0 0 ${px} ${px}`} role="img" aria-label="收據二維碼預覽" style={{ background: "#ffffff", display: "block" }}>
            <rect width={px} height={px} fill="#ffffff" />
            {rects}
          </svg>
        ) : (
          <div className="flex h-full w-full items-center justify-center text-center text-[10px] leading-tight text-slate-400">
            {url && url.trim() ? "網址過長\n無法生成" : "未生成"}
          </div>
        )}
      </div>
      <div className="text-[11px] font-normal leading-relaxed text-slate-500">
        {payload ? (
          <>
            已生成 · {QR_SIZE_LABEL[size]}（點下方「即時預覽」亦可見）<br />
            想調整位置？喺左側「區塊順序」揀「二維碼」可以移上移落 / 較對齊。
          </>
        ) : url && url.trim() ? (
          "網址太長，無法生成二維碼（請改用短網址）。"
        ) : (
          <>
            輸入網址後撳「生成」，二維碼圖像就會加入模板。
            <br />
            收據同自助點餐機係兩個獨立設定，各自填各自嘅網址。
          </>
        )}
      </div>
    </div>
  );
}

/** 列印任務是否落在選定嘅時間範圍內（以 Asia/Macau 為準）。"all" 一律通過。 */
function printJobMatchesDateRange(createdAt: string, range: ReportRangeKey, now = new Date()): boolean {
  if (range === "all") return true;
  const ts = Date.parse(createdAt);
  if (!Number.isFinite(ts)) return false;
  const instant = new Date(ts);
  if (range === "today") return macauDateKey(instant) === macauDateKey(now);
  if (range === "yesterday") {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return macauDateKey(instant) === macauDateKey(yesterday);
  }
  const period = ledgerReportRangeForKey(range, now);
  if (!period) return true;
  return ts >= Date.parse(period.start) && ts <= Date.parse(period.end);
}

// 打印記錄列表（2026-09-10）：表頭 / 儲存格樣式，同訂單頁（local-orders-panel / online-orders）一致。
const TH_CELL = "sticky top-0 z-10 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500";
const TD_CELL = "px-3 py-2 align-middle";

export function PrintCenter() {
  const [printJobs, setPrintJobs] = useState<PrintJob[]>(() => loadPrintJobs().map(normalizePrintJobStatus));
  const [orders] = useState<PosOrder[]>(() => loadOrders());
  const networkOnline = useNetworkOnline();
  const offlineMode = !networkOnline;
  // A1（docs/56）：打印通道健康自檢。三通道皆無 → 所有單據只排佇列唔出紙，出 banner 提示。
  const hasChannel = isNativeBridgeAvailable() || isCompanionConfigured() || isRelayConfigured();
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "pending" | "sent" | "printed" | "failed">("all");
  // docs/任務：列印記錄加入時間篩選（今天 / 昨天 / 7天 / 30天 / 全部），預設「今天」。
  const [dateFilter, setDateFilter] = useState<ReportRangeKey>("today");
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [activeTab, setActiveTab] = useState<
    "records" | "receipt-template" | "label-template" | "kitchen-template" | "kiosk-template" | "shift-template"
  >("records");
  const [localSettings, setLocalSettings] = useState(() => loadPosLocalSettings() ?? defaultPosLocalSettings);
  const [deviceConfig, setDeviceConfig] = useState<DeviceConfig>(() => loadDeviceConfig() ?? defaultDeviceConfig);
  const [selectedSection, setSelectedSection] = useState<Record<TemplateKindState, string>>({
    receipt: "store_name",
    label: "header",
    kitchen: "store_name",
    kiosk: "store_name",
    // 交班模板第一格係抬頭（header），揀佢商家即刻見到「改標題文字」輸入框。
    shift: "header",
  });
  // ── 交班模板範本庫（2026-09-10）：新增 / 改名 / 刪除 / 套用 ──
  // `newPresetName` = 「儲存為新範本」輸入框；`renamingId`/`renameDraft` = 就地改名。
  const [newPresetName, setNewPresetName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [reprintingOrderId, setReprintingOrderId] = useState<string | null>(null);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  /**
   * 設計頁預覽嘅紙闊（收據 / 廚房 / 交班；標籤另有 `LabelTemplate.paperSize`）。
   *
   * 而家係**手動切**（58 / 80mm）：`DevicePrinterConfig.paperSize` 係逐機設定，
   * 而同一個模板會同時派去唔同機（收據機 80mm、廚房機 58mm），
   * 自動跟機嘅話預覽會隨「揀中邊部機」跳來跳去，商家對唔上。
   */
  const [previewPaperMm, setPreviewPaperMm] = useState<58 | 80>(80);
  const historyRef = useRef<{ past: unknown[]; future: unknown[] }>({ past: [], future: [] });

  // ── 模板雲端同步（0027 pos_print_templates）──
  // 「進入打印頁即拉 DB；改動節流上雲；儲存掣強制同步」。
  // 本地永遠即時 auto-save（現有行為）；雲端用 debounce + LWW（server updated_at 基準），
  // 離線就留待網絡恢復 / 再改動 / 撳儲存時補推 —— 唔會卡住設計介面。
  const pendingPushRef = useRef<PosLocalSettings | null>(null);
  const cloudPushTimerRef = useRef<number | null>(null);
  // 有本地改動未成功推上雲（離線 / server 503）→ 網絡恢復後補推一次
  const unsyncedRef = useRef(false);

  function clearCloudPushTimer() {
    if (cloudPushTimerRef.current !== null) {
      window.clearTimeout(cloudPushTimerRef.current);
      cloudPushTimerRef.current = null;
    }
  }

  /** 模板改動後節流上雲（1.5s 靜止先推）；離線時淨係標記 unsynced，等網絡恢復補推。 */
  function scheduleTemplateCloudPush(nextSettings: PosLocalSettings) {
    pendingPushRef.current = nextSettings;
    unsyncedRef.current = true;
    clearCloudPushTimer();
    if (!networkOnline) return; // 離線：唔開 timer，等 [networkOnline] effect 恢復時補推
    cloudPushTimerRef.current = window.setTimeout(() => {
      cloudPushTimerRef.current = null;
      void pushTemplateToServer(pendingPushRef.current);
    }, 1500);
  }

  /** 真正推上雲。成功 → 記低 server updated_at（LWW 基準）+ 清 unsynced；失敗靜默留待再試。 */
  async function pushTemplateToServer(settings: PosLocalSettings | null) {
    if (!settings) return;
    const storeId = resolveStoreId();
    if (!storeId) return; // 未登入 / 未綁定 kiosk → 冇店可歸，唔推
    const result = await pushStorePrintTemplates(storeId, settings.printTemplates, {
      presets: settings.shiftTemplatePresets,
      activeId: settings.activeShiftTemplateId,
    });
    if (result) {
      savePrintTemplateSyncMeta({ updatedAt: result.updatedAt });
      unsyncedRef.current = false;
    }
    // 失敗 / 離線：靜默（唔彈 toast 騷擾設計過程），unsynced 保持 true 等補推
  }

  // 進入打印頁：拉 DB 模板。server 有記錄 → 採納；冇 → 保留本地（向後兼容）。
  useEffect(() => {
    const storeId = resolveStoreId();
    if (!storeId) return;
    let alive = true;
    void (async () => {
      const res = await fetchStorePrintTemplates(storeId);
      if (!alive || !res) return;
      if (!res.found || !res.templates) return; // server 未設定 → 用本地（新店 / 未上傳過）
      const meta = loadPrintTemplateSyncMeta();
      const serverTs = res.updatedAt ? Date.parse(res.updatedAt) || 0 : 0;
      const localTs = meta?.updatedAt ? Date.parse(meta.updatedAt) || 0 : 0;
      // 拉取未返前用戶已開改（有 pending / unsynced）→ 唔好採納蓋走佢啱啱打嘅嘢
      if (pendingPushRef.current || unsyncedRef.current) return;
      // 採納規則（LWW）：本機冇任何 server 版本紀錄 → 採納（全新機 / 舊版本地未對過版）；
      // 已有紀錄但 server 更新（另一部機改咗）→ 採納；server 唔係更新 → 保留本地
      // （避免「自己啱啱推完 → 重入頁面 → 用舊 server 蓋返自己新 edit」嘅迴圈）。
      if (localTs > 0 && serverTs <= localTs) return;
      const prev = loadPosLocalSettings();
      // 交班模板範本庫：server 有帶就跟住採納（同模板同一個 LWW 版本）——
      // 令另一部機新增嘅範本喺呢部機都見到。舊 server row 冇呢欄（null）→ 保留本地。
      const next: PosLocalSettings = {
        ...prev,
        printTemplates: res.templates,
        ...(res.shiftPresets
          ? {
              shiftTemplatePresets: res.shiftPresets.presets,
              activeShiftTemplateId: res.shiftPresets.activeId,
            }
          : {}),
      };
      savePosLocalSettings(next);
      savePrintTemplateSyncMeta({ updatedAt: res.updatedAt });
      if (alive) {
        setLocalSettings(next);
        setToast({ tone: "success", message: "已載入雲端模板設定（自動同步）。" });
      }
    })();
    return () => {
      alive = false;
      // 離開頁面前補推最後一次 debounce（避免「改完 1.5s 內即走」漏上雲）
      if (cloudPushTimerRef.current !== null && pendingPushRef.current) {
        clearCloudPushTimer();
        void pushTemplateToServer(pendingPushRef.current);
      }
    };
  }, []);

  // 網絡恢復：如果有未成功上雲嘅模板改動 → 即刻補推（離線期間設計完，一上線就同步）。
  useEffect(() => {
    if (!networkOnline || !unsyncedRef.current) return;
    void pushTemplateToServer(pendingPushRef.current);
  }, [networkOnline]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    function onPrintJobsChanged() {
      setPrintJobs(loadPrintJobs().map(normalizePrintJobStatus));
    }
    window.addEventListener("pos-print-jobs-changed", onPrintJobsChanged);
    return () => window.removeEventListener("pos-print-jobs-changed", onPrintJobsChanged);
  }, []);

  // 聯合設置模組：設置內新增/啟用/改用途打印機後，即時同步到預覽
  useEffect(() => {
    function onDeviceConfigChanged() {
      setDeviceConfig(loadDeviceConfig() ?? defaultDeviceConfig);
    }
    window.addEventListener("pos-device-config-changed", onDeviceConfigChanged);
    return () => window.removeEventListener("pos-device-config-changed", onDeviceConfigChanged);
  }, []);

  // §10（docs/98）：輪詢雲端打印結果，令網頁見到 Hub 真實嘅「失敗 / 已印」。
  // 每 8 秒一次；component 卸載即停。離線 / 網絡錯會喺 syncCloudPrintOutcomes 內靜默跳過。
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (alive) void syncCloudPrintOutcomes();
    };
    tick(); // 一入頁面就拉一次，唔使等首個 8 秒
    const interval = window.setInterval(tick, 8000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, []);

  const filteredJobs = useMemo(() => {
    const base = printJobs
      .filter((job) => printJobMatchesDateRange(job.createdAt, dateFilter))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (filter === "all") return base;
    if (filter === "sent") return base.filter((job) => job.status === "sent");
    if (filter === "printed") return base.filter((job) => job.status === "printed");
    return base.filter((job) => job.status === filter);
  }, [printJobs, filter, dateFilter]);

  const activeJob = useMemo(
    () => (activeJobId ? filteredJobs.find((job) => job.id === activeJobId) ?? null : null),
    [activeJobId, filteredJobs],
  );

  const orderMap = useMemo(() => new Map(orders.map((order) => [order.id, order])), [orders]);

  /**
   * 按打印 job 反查原始訂單（「重打整單」用）。
   *
   * 三層 fallback（2026-09-09 修「找不到原始訂單，無法重打」誤報）：
   *   1) `orderMap`：mount 時 loadOrders() 嘅一次性快照 —— 線下單通常夠用；
   *   2) 即時再 `loadOrders()`：補返「本頁 mount 之後先結帳/同步入嚟」嘅線下單
   *      （orders state 係一次性 snapshot，唔會自己更新）；
   *   3) `ledger-` 前綴 → `findPosOrderForLedger()`：線上單**從來唔 mirror 入
   *      localStorage**（契約 M3/M8），只存在於 in-memory bridge registry
   *      （接單/補打收據嗰刻 cache）或 legacy persisted row —— 唔加呢層，
   *      線上單打印 job 撳「重打整單」永遠報「找不到原始訂單」。
   */
  function findJobSourceOrder(job: PrintJob): PosOrder | null {
    const local = orderMap.get(job.orderId) ?? loadOrders().find((row) => row.id === job.orderId);
    if (local) return local;
    if (job.orderId.startsWith("ledger-")) {
      return findPosOrderForLedger(job.orderId.slice("ledger-".length));
    }
    return null;
  }

  // 聯合設置模組：由 deviceConfig 解析預覽用打印機（設置新增/啟用即時反映）
  const enabledPrinters = useMemo(() => deviceConfig.printers.filter((item) => item.enabled), [deviceConfig]);

  // ── 模板設計介面：讀寫都係「真實可打印」嘅 block 樣式（開關 / 字型大小 / 粗體 / 對齊）──
  type AnyTemplate = {
    blocks: Record<string, EscPosBlockStyle>;
    order: string[];
    footerText: string;
    headerText?: string;
    /** 收據二維碼網址（收據 / 自助點餐機兩個槽位各自設定）；空白 = 唔印。 */
    qrUrl?: string;
    /** 收據二維碼打印大小（s / m / l）；缺省 = "m"。收據 / 自助點餐機各自存。 */
    qrSize?: EscPosSize;
    /** 交班模板專屬：分節標題文字（例如「— 店內（今日）—」），商家可自改。 */
    sectionTitles?: Partial<Record<ShiftSectionId, string>>;
    /** 標籤模板專屬：標籤紙尺寸（`LABEL_PAPER_PRESETS` 嘅 id）。 */
    paperSize?: string;
  };

  function readTemplate(kind: TemplateKindState): AnyTemplate {
    const raw = localSettings.printTemplates[kind] as unknown as AnyTemplate;
    // 交班模板：用專屬 normalize 補齊區塊（缺嘅補預設、未知 id 剔走）同分節標題。
    // 唔行下面 ensureDividerSection —— 交班單冇 items，分格線區塊會變成死開關。
    if (kind === "shift") {
      return normalizeShiftTemplate(raw as unknown as Partial<ShiftTemplate>) as unknown as AnyTemplate;
    }
    // 舊 localStorage 設定（存檔時仲未有 qr_code）→ 喺設計介面即刻補返，
    // 等「區塊順序」見到「二維碼」、選中時亦唔會因 blocks 缺 key 而炸。
    const base = (kind === "receipt" || kind === "kiosk"
      ? ensureReceiptSections(raw as never)
      : raw) as unknown as AnyTemplate;
    if (kind === "label") {
      // 標籤字型鎖死：舊設定可能存咗唔同 size，一律校正為固定檔位（設計同出紙一致）。
      // 標籤冇分格線 → 唔使補 divider 區塊。
      return withLabelFixedSizes(base as never) as unknown as AnyTemplate;
    }
    // 舊模板未存 `divider`（分格線）區塊 → 即刻補返，等設計介面見到、出紙同預覽行新邏輯。
    const t = ensureDividerSection(base);
    // 舊模板未存 qrSize → 補返預設「中」，揀大小時先唔會 undefined。
    if (kind === "receipt" || kind === "kiosk") {
      return { ...t, qrSize: t.qrSize ?? "m" };
    }
    return t;
  }

  /**
   * 寫入整份本機設定。
   *
   * `recordHistory`（預設 `true`）= 呢次改動要唔要入撤銷 / 重做歷史。
   * 只有**改動排版**（`printTemplates`）先應該入歷史；純範本庫操作（新增 / 改名 /
   * 覆蓋 / 刪除範本）一律 `false` —— 否則商家撳「撤銷」會莫名其妙噉還原咗排版，
   * 但佢啱啱只係改咗個範本名。
   *
   * 用 simple boolean 而唔係 `options?: { recordHistory?: boolean }`：改動前全部
   * caller 都係傳 `false`（冇人傳 true），個 options 物件只係多餘包袱。
   *
   * 註：`react-hooks/refs`（React Compiler）會對「喺 JSX 度呼叫呢條函數」報
   * 「Cannot access refs during render」。呢個係本檔案既有嘅誤報類別
   * （`patchBlock` 等早就有，見 `npx eslint src/components/print-center.tsx`），
   * 唔影響 `next build`，亦唔係今次新增。真正嘅 ref 讀取只發生喺事件處理器入面。
   */
  function updateLocalTemplate(nextSettings: typeof localSettings, recordHistory = true) {
    if (recordHistory) {
      historyRef.current.past.push(localSettings.printTemplates);
      if (historyRef.current.past.length > 60) historyRef.current.past.shift();
      historyRef.current.future = [];
      setCanUndo(true);
      setCanRedo(false);
    }
    setLocalSettings(nextSettings);
    savePosLocalSettings(nextSettings);
    scheduleTemplateCloudPush(nextSettings);
  }

  function applyTemplate(kind: TemplateKindState, next: AnyTemplate) {
    const current = localSettings.printTemplates[kind] as unknown as AnyTemplate;
    const merged = { ...current, ...next } as unknown as (typeof localSettings.printTemplates)[TemplateKindState];
    updateLocalTemplate({
      ...localSettings,
      printTemplates: { ...localSettings.printTemplates, [kind]: merged },
    });
  }

  function undoTemplate() {
    const prev = historyRef.current.past.pop();
    if (!prev) return;
    historyRef.current.future.push(localSettings.printTemplates);
    setCanUndo(historyRef.current.past.length > 0);
    setCanRedo(true);
    const next = { ...localSettings, printTemplates: { ...localSettings.printTemplates, ...(prev as object) } } as typeof localSettings;
    setLocalSettings(next);
    savePosLocalSettings(next);
    scheduleTemplateCloudPush(next);
  }

  function redoTemplate() {
    const next = historyRef.current.future.pop();
    if (!next) return;
    historyRef.current.past.push(localSettings.printTemplates);
    setCanUndo(true);
    setCanRedo(historyRef.current.future.length > 0);
    const applied = { ...localSettings, printTemplates: { ...localSettings.printTemplates, ...(next as object) } } as typeof localSettings;
    setLocalSettings(applied);
    savePosLocalSettings(applied);
    scheduleTemplateCloudPush(applied);
  }

  /**
   * docs/71：明確「儲存模板」動作 + read-back 驗證 + 雲端同步（0027）。
   * auto-save 仍保留（每次改動即存本機 + 節流上雲），但呢個掣做權威確認：
   * 一撳即強制上雲，等 toast 明確話畀商家知「同步成功 / 淨係存咗本機」。
   */
  async function saveTemplateNow() {
    const ok = savePosLocalSettings(localSettings);
    if (!ok) {
      setToast({
        tone: "error",
        message: "❌ 儲存失敗：localStorage 寫入被拒絕（私隱模式 / 配額滿 / kiosk 限制）。請檢查瀏覽器設定。",
      });
      return;
    }
    // read-back 驗證：確認剛寫入嘅 key 真係讀得返嘢
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(getLocalSettingsKey()) : null;
    if (!raw) {
      setToast({ tone: "error", message: "⚠️ 已寫入但讀回為空，請重試。" });
      return;
    }

    const storeId = resolveStoreId();
    if (!storeId) {
      setToast({ tone: "success", message: "✅ 已儲存模板設定（本機）；未偵測到店舖，未能同步雲端。" });
      return;
    }

    // 離線：照樣標記 unsynced，網絡恢復 / 再改動時自動補推
    if (!networkOnline) {
      unsyncedRef.current = true;
      pendingPushRef.current = localSettings;
      setToast({ tone: "error", message: "⚠️ 已儲存本機；目前離線，恢復網絡後會自動同步雲端。" });
      return;
    }

    const result = await pushStorePrintTemplates(storeId, localSettings.printTemplates, {
      presets: localSettings.shiftTemplatePresets,
      activeId: localSettings.activeShiftTemplateId,
    });
    if (result) {
      savePrintTemplateSyncMeta({ updatedAt: result.updatedAt });
      unsyncedRef.current = false;
      setToast({ tone: "success", message: "✅ 已儲存模板並同步到雲端（全部收銀機可共用）。" });
    } else {
      // server 暫時推唔到：唔好嚇商家，講清楚「已存本機、稍後自動重試」
      unsyncedRef.current = true;
      pendingPushRef.current = localSettings;
      clearCloudPushTimer();
      setToast({ tone: "error", message: "⚠️ 已儲存本機；雲端同步失敗，網絡恢復或下次改動時會自動重試。" });
    }
  }

  // ── 交班模板範本庫：新增 / 改名 / 覆蓋 / 刪除 / 套用（2026-09-10）──
  //
  // 語義同「菜品規格模板」（`specTemplates`）一致：範本庫只係**來源**，
  // 真正生效嘅係 `printTemplates.shift`（工作中模板）。
  //   - 儲存為範本 = 把目前排版存成一個具名範本（唔會改變目前排版）
  //   - 套用        = 把範本**拷貝**落工作中模板（之後嘅編輯唔會回寫範本）
  //   - 刪除        = 只由庫移除（唔會動到目前生效中嘅排版 —— 防誤刪）
  // 所有破壞性操作之前都先驗證，失敗一律出 toast 講清楚原因（唔靜默失敗）。

  /** 範本名稱上限（太長會令介面上嘅 chip 爆版，亦冇實際需要）。 */
  const SHIFT_PRESET_NAME_MAX = 20;
  /** 範本庫數量上限：防止無限增長塞爆 localStorage（每個範本都係一整份模板）。 */
  const SHIFT_PRESET_LIMIT = 20;

  /** 驗證範本名稱：回傳錯誤訊息，或 null = 通過。 */
  function validatePresetName(name: string, exceptId?: string): string | null {
    const trimmed = name.trim();
    if (!trimmed) return "請先輸入範本名稱。";
    if (trimmed.length > SHIFT_PRESET_NAME_MAX) return `範本名稱最多 ${SHIFT_PRESET_NAME_MAX} 個字。`;
    const dup = localSettings.shiftTemplatePresets.some(
      (p) => p.id !== exceptId && p.name.trim() === trimmed,
    );
    if (dup) return `已經有同名範本「${trimmed}」，請改個名。`;
    return null;
  }

  /**
   * 寫入範本庫（新增 / 改名 / 覆蓋 / 刪除）。
   *
   * 一律 `recordHistory = false`：撤銷 / 重做歷史只記錄 `printTemplates`（即「設計」），
   * 唔記錄範本庫。否則商家撳「撤銷」會還原咗排版，但佢啱啱只係改咗個範本名。
   *
   * ⚠️ 「套用」**唔行呢條路**：佢真係改咗排版（要入歷史），而且必須同
   * `activeShiftTemplateId` 一次過原子寫入 —— 見 `applyShiftPreset()`。
   * 所以呢條函數冇 `recordHistory` 參數（唯一值就係 false，唔需要做成選項）。
   */
  function updateShiftPresets(next: ShiftTemplateVariant[], activeId?: string) {
    updateLocalTemplate(
      {
        ...localSettings,
        shiftTemplatePresets: next,
        activeShiftTemplateId: activeId ?? localSettings.activeShiftTemplateId,
      },
      false,
    );
  }

  /** 「儲存為新範本」：把目前工作中嘅排版存成一個具名範本。 */
  function createShiftPreset() {
    const err = validatePresetName(newPresetName);
    if (err) {
      setToast({ tone: "error", message: `❌ ${err}` });
      return;
    }
    if (localSettings.shiftTemplatePresets.length >= SHIFT_PRESET_LIMIT) {
      setToast({ tone: "error", message: `❌ 範本數量已達上限（${SHIFT_PRESET_LIMIT} 個），請先刪除唔用嘅範本。` });
      return;
    }
    const name = newPresetName.trim();
    // id 用 randomUUID：唔可以用 `shift-preset-${count}`（刪完再新增會撞 id）。
    const id = `shift-preset-${crypto.randomUUID().slice(0, 8)}`;
    updateShiftPresets(
      [...localSettings.shiftTemplatePresets, { id, name, template: cloneShiftTemplate(readTemplate("shift") as unknown as ShiftTemplate) }],
      id,
    );
    setNewPresetName("");
    setToast({ tone: "success", message: `✅ 已儲存範本「${name}」。` });
  }

  /**
   * 「套用」：把範本內容拷貝落工作中模板（唔會再同範本連動）。
   *
   * ⚠️ 一定要**一次過**寫入（`activeShiftTemplateId` + `printTemplates.shift` 同一個
   * setState）。初期版本係 `updateShiftPresets(...)` 之後再 `applyTemplate(...)`，
   * 兩者都由同一個 stale `localSettings` closure 砌新 state → 第二次 `setLocalSettings`
   * 會把第一次覆蓋走，「使用中」標籤永遠唔會更新，而且會 push 兩格撤銷歷史。
   */
  function applyShiftPreset(id: string) {
    const preset = localSettings.shiftTemplatePresets.find((p) => p.id === id);
    if (!preset) {
      setToast({ tone: "error", message: "❌ 找不到此範本（可能已被其他裝置刪除），請重新載入頁面。" });
      return;
    }
    updateLocalTemplate({
      ...localSettings,
      activeShiftTemplateId: id,
      printTemplates: {
        ...localSettings.printTemplates,
        shift: cloneShiftTemplate(preset.template),
      },
    });
    setToast({ tone: "success", message: `✅ 已套用範本「${preset.name}」；記得撳「儲存模板」同步到其他收銀機。` });
  }

  /** 「用目前設定覆蓋」：把目前排版寫返入範本（等同「更新此範本」）。 */
  function overwriteShiftPreset(id: string) {
    const preset = localSettings.shiftTemplatePresets.find((p) => p.id === id);
    if (!preset) {
      setToast({ tone: "error", message: "❌ 找不到此範本。" });
      return;
    }
    updateShiftPresets(
      localSettings.shiftTemplatePresets.map((p) =>
        p.id === id ? { ...p, template: cloneShiftTemplate(readTemplate("shift") as unknown as ShiftTemplate) } : p,
      ),
      id,
    );
    setToast({ tone: "success", message: `✅ 已用目前排版更新範本「${preset.name}」。` });
  }

  function commitRenameShiftPreset(id: string) {
    const err = validatePresetName(renameDraft, id);
    if (err) {
      setToast({ tone: "error", message: `❌ ${err}` });
      return;
    }
    const name = renameDraft.trim();
    updateShiftPresets(localSettings.shiftTemplatePresets.map((p) => (p.id === id ? { ...p, name } : p)));
    setRenamingId(null);
    setRenameDraft("");
  }

  /**
   * 刪除範本。**唔會**動到目前生效中嘅排版 —— 商家可能只係唔要呢個存檔，
   * 但想保留而家印緊嘅版本。若刪嘅正好係「上次套用」嗰個，順手清空
   * `activeShiftTemplateId`（避免介面顯示一個唔存在嘅範本名）。
   */
  function deleteShiftPreset(id: string) {
    const preset = localSettings.shiftTemplatePresets.find((p) => p.id === id);
    if (!preset) return;
    if (!window.confirm(`確定刪除範本「${preset.name}」？\n\n目前生效中嘅排版唔會受影響。`)) return;
    const next = localSettings.shiftTemplatePresets.filter((p) => p.id !== id);
    // 刪光都冇問題（`normalizeShiftTemplatePresets` 只保證載入時非空，唔會阻止商家刪）。
    updateShiftPresets(next, localSettings.activeShiftTemplateId === id ? "" : undefined);
    setToast({ tone: "success", message: `✅ 已刪除範本「${preset.name}」。` });
  }

  function patchBlock(kind: TemplateKindState, id: string, patch: Partial<EscPosBlockStyle>) {
    const t = readTemplate(kind);
    applyTemplate(kind, { ...t, blocks: { ...t.blocks, [id]: { ...t.blocks[id], ...patch } } });
  }

  function moveSection(kind: TemplateKindState, id: string, dir: -1 | 1) {
    const t = readTemplate(kind);
    const order = [...t.order];
    const i = order.indexOf(id);
    if (i === -1) return;
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    applyTemplate(kind, { ...t, order });
  }

  function setFooter(kind: TemplateKindState, text: string) {
    const t = readTemplate(kind);
    applyTemplate(kind, { ...t, footerText: text });
  }

  /** 收據二維碼網址（空白 = 唔印 QR，`qr_code` 區塊會自動消失，唔會留空框）。 */
  function setQrUrl(kind: TemplateKindState, text: string) {
    const t = readTemplate(kind);
    applyTemplate(kind, { ...t, qrUrl: text });
  }

  /** 收據二維碼打印大小（細 / 中 / 大）。 */
  function setQrSize(kind: TemplateKindState, size: EscPosSize) {
    const t = readTemplate(kind);
    applyTemplate(kind, { ...t, qrSize: size });
  }

  /**
   * 「生成」掣：喺打印模板內**生成**二維碼圖像。
   *
   * 做兩件事：
   * 1. 確保 `qr_code` 區塊可見（喺「區塊順序」揀得到、出紙會印）；
   * 2. 重新套用 `qrUrl`（同 `qrSize`）→ 即時預覽會即刻畫出嚟（ESC/POS 點陣 → SVG）。
   * 網址空白 / 太長而 encodeQrPayload 失敗 → 出 toast 提示，唔會生成到空框。
   */
  function generateQr(kind: TemplateKindState) {
    const t = readTemplate(kind);
    const url = (t.qrUrl ?? "").trim();
    if (!url) {
      setToast({ tone: "error", message: "請先輸入二維碼網址，再撳「生成」。" });
      return;
    }
    if (!encodeQrPayload(url)) {
      setToast({ tone: "error", message: "⚠️ 網址太長，無法生成二維碼（請用短網址）。" });
      return;
    }
    // 保證 qr_code 區塊存在 + 可見
    const qrStyle: EscPosBlockStyle = { visible: true, size: "s", bold: false, align: "center" };
    const order = t.order.includes("qr_code") ? t.order : [...t.order, "qr_code"];
    const blocks = t.blocks.qr_code ? t.blocks : { ...t.blocks, qr_code: qrStyle };
    applyTemplate(kind, { ...t, order, blocks: { ...blocks, qr_code: { ...blocks.qr_code, visible: true } } });
    setToast({ tone: "success", message: "✅ 已喺模板生成二維碼。" });
  }

  function setHeader(kind: TemplateKindState, text: string) {
    const t = readTemplate(kind);
    applyTemplate(kind, { ...t, headerText: text });
  }

  /**
   * 交班模板：改分節標題文字（例如「— 店內（今日）—」→「— 堂食（今日）—」）。
   * 清空 = 該標題唔印（`buildShiftContent` 會回空字串，renderer 直接跳過該行）。
   */
  function setSectionTitle(id: ShiftSectionId, text: string) {
    const t = readTemplate("shift");
    applyTemplate("shift", { ...t, sectionTitles: { ...(t.sectionTitles ?? {}), [id]: text } });
  }

  /**
   * 改標籤紙尺寸（`LabelTemplate.paperSize`）。
   * 只影響預覽紙闊同分格線闊度；標籤本身冇 items / 價錢，出紙 bytes 一樣。
   */
  function setLabelPaperSize(id: string) {
    const t = readTemplate("label");
    applyTemplate("label", { ...t, paperSize: id });
  }

  /**
   * 預覽欄寬（每行字符數）。
   * - 標籤：跟模板 `paperSize`（`LABEL_PAPER_PRESETS`）。
   * - 收據 / 廚房 / 交班：跟設計頁手動切嘅 58 / 80mm。
   *
   * 出紙路徑唔用呢個 —— 出紙係由**打印機**嘅 `paperSize` 推算（`paperColumnsFromSize`），
   * 再由 `buildSnapshot` 寫入快照，三個 repo 直接讀。預覽同出紙各自計，但計法同一套。
   */
  function previewColumns(kind: TemplateKindState): number {
    if (kind === "label") return labelPaperPreset(readTemplate(kind).paperSize).columns;
    return previewPaperMm === 58 ? RECEIPT_PAPER_COLUMNS_58MM : RECEIPT_PAPER_COLUMNS;
  }

  /**
   * dev-only 覆蓋檢查：每個區塊喺預覽 content 都要有非空值。
   *
   * 目的：日後有人加咗新區塊但漏咗喺 `preview-fixtures.ts` 填範例值，
   * 就會喺 console 即刻報 —— 唔會再出現「加咗區塊，但商家喺設計頁永遠睇唔到」。
   * production 直接 return（零成本）。
   */
  function assertPreviewCoverage(kind: TemplateKindState, content: Record<string, string>) {
    if (process.env.NODE_ENV === "production") return;
    // 呢三個唔係純文字區塊：`divider` 係設定型、`items` 行 PrintItemLine、
    // `qr_code` 靠 extras.qr 帶，所以唔使喺 content 入面有值。
    const skip = new Set(["divider", "items", "qr_code"]);
    const missing = (SECTION_META[kind] ?? [])
      .filter((m) => !skip.has(m.id) && !(content[m.id] ?? "").trim())
      .map((m) => m.id);
    if (missing.length > 0) {
      console.warn(
        `[print-center] 預覽範例資料缺內容：${missing.join("、")}（模板：${kind}）。` +
          "請喺 src/lib/preview-fixtures.ts 補返範例值，否則商家喺設計頁睇唔到呢啲區塊。",
      );
    }
  }

  function buildPreviewLines(kind: TemplateKindState): EscPosLine[] {
    const t = readTemplate(kind);
    const snapshot = buildSnapshot(
      snapshotKindOf(kind),
      t as unknown as Parameters<typeof buildSnapshot>[1],
      previewColumns(kind),
    );
    /**
     * 預覽**完全照跟**商家嘅設定，唔做任何 override。
     *
     * ⚠️ 2026-09-11 改（用戶反饋：「我熄咗門店名，但即時預覽冇變」）：
     * 舊版喺度 clone 一份 `visible` 全 `true` 嘅快照（`divider` 除外），理由係
     * 「設計頁要畀商家一眼見到完整版面，否則佢會以為模板少咗嘢」。但咁做令
     * 左邊「區塊順序」嘅 checkbox 對預覽**完全冇效應** —— 商家熄完見唔到變化，
     * 而個預覽叫「**即時**預覽（**真實**熱敏樣式）」，字面同一行為直接矛盾。
     *
     * 而家：`renderEscPosLines()` 內 `if (!b.visible) continue`（`escpos-render.ts:263`）
     * 直接生效，**預覽 == 真實出紙**（同樣兩條跳過規則：`!b.visible`、`!text`）。
     * 「唔知有咩區塊可揀」嘅問題交由左邊「區塊順序」清單解決 —— 嗰度**永遠列齊全部
     * 區塊**（連熄咗嘅）、checkbox 一打勾即返嚟，比叫商家睇一個講大話嘅預覽好。
     */
    if (kind === "label") {
      const content = buildLabelContent(PREVIEW_RECEIPT_ORDER, PREVIEW_LABEL_ITEM, {
        storeName: PREVIEW_STORE_NAME,
        headerText: t.headerText ?? "",
        footerText: t.footerText,
      });
      assertPreviewCoverage(kind, content);
      return renderEscPosLines(snapshot, content, []);
    }
    if (kind === "kitchen") {
      const content = buildKitchenContent(PREVIEW_KITCHEN_ORDER, {
        storeName: PREVIEW_STORE_NAME,
        footerText: t.footerText,
        typeLabel: "落單",
        time: "12:00",
        // ⚠️ 全單備註一定要帶：唔傳 → content.order_note 空字串 → renderer 直接跳過
        // → 廚房單永久冇全單備註（收據有、廚房冇嘅舊 bug）。
        orderNote: PREVIEW_KITCHEN_ORDER.orderNote,
      });
      // 廚房單唔印價錢 / 折扣（同 `print-jobs.ts buildKitchenPrintJobs` 一致）。
      const items = PREVIEW_KITCHEN_ORDER.items.map((it) => ({
        name: it.name,
        quantity: it.quantity,
        specs: (it.selectedSpecs ?? []).map((s) => `${s.groupName}:${s.optionLabel}`),
        note: it.note,
      }));
      assertPreviewCoverage(kind, content);
      return renderEscPosLines(snapshot, content, items);
    }
    if (kind === "shift") {
      // 交班模板：用同交班出紙一模一樣嘅 builder（`buildShiftContent`）餵示例快照，
      // 所以設計介面見到嘅嘢 == 交班時真正印出嚟嘅嘢。items 一律空陣列（交班單冇菜品明細）。
      const content = buildShiftContent(SHIFT_PREVIEW_SAMPLE, {
        storeName: SHIFT_PREVIEW_SAMPLE.storeName,
        headerText: t.headerText ?? "",
        footerText: t.footerText,
        sectionTitles: t.sectionTitles,
      });
      assertPreviewCoverage(kind, content);
      return renderEscPosLines(snapshot, content, []);
    }
    const content = buildReceiptContent(PREVIEW_RECEIPT_ORDER, {
      storeName: PREVIEW_STORE_NAME,
      // 門店設定 → 商家登入號碼；兩邊都冇就用示例電話，等「店家電話」區塊唔會隱形。
      storeTel: resolveStoreTel(loadBootstrapCache()?.storeTel) || PREVIEW_STORE_TEL,
      currency: "MOP",
      footerText: t.footerText,
      serverName: PREVIEW_SERVER_NAME,
    });
    // 共用 `toPrintItemLines()`：同收據出紙（`print-jobs.ts`）行同一份映射。
    const items = toPrintItemLines(PREVIEW_RECEIPT_ORDER.items);
    assertPreviewCoverage(kind, content);
    // 收據 / 自助點餐機：必須帶埋 qr + qrSize，否則二維碼喺設計介面預覽永遠唔顯示（#模板 QR bug）。
    // 商家未填網址 → 用示例網址，等佢見到呢個區塊嘅位置同大細；
    // 真實出紙網址空白係「唔印」，所以呢個 fallback **淨用於預覽**。
    const qrUrl = t.qrUrl?.trim() ? t.qrUrl.trim() : PREVIEW_QR_URL;
    return renderEscPosLines(snapshot, content, items, {
      qr: encodeQrPayload(qrUrl),
      qrSize: t.qrSize ?? "m",
    });
  }

  function persistPrintJobs(next: PrintJob[]) {
    const normalized = next.map(normalizePrintJobStatus);
    setPrintJobs(normalized);
    savePrintJobs(normalized);
    window.dispatchEvent(new CustomEvent("pos-print-jobs-changed"));
  }

  function pushEvents(events: QueueEvent[]) {
    const currentQueue = loadQueue();
    // 🛡️ 跨店隔離 L1：只 stamp 新建事件（舊 queue 唔掂，防止外店事件被改姓）。
    // docs/111：入隊取代 flush 去重（同 type + 同目標嘅舊 pending 會被取代）。
    const nextQueue = enqueueEvents(currentQueue, withStoreScope(events));
    saveQueue(nextQueue);
    // 補：以前 saveQueue 後從來唔 trigger flush worker，events 永遠留喺 queue
    // （要等其他操作偶然觸發 syncNow 先被推送）。家陣同 pos-app.tsx 一致，
    // 入隊後即刻 dispatch POS_SYNC_QUEUE_CHANGED_EVENT，等 sync-flush worker 接力推上雲。
    notifyQueueChanged();
  }

  // §10（docs/98）：把雲端嘅打印結果回填本地 print job 狀態。
  // relay 年代，本地嘅 `sent` 只代表「入咗雲端隊列」，真正印到 / 印唔到喺雲端（Hub 回報）。
  // 2026-09-07 兩級狀態：雲端 `printed`（真實出紙成功）同 `failed`（印唔到）都必須向上覆寫本地；
  // 雲端 `sent` 只係「已交畀打印通道」，本地已經係 sent 就唔使動。
  // 絕對唔可以將本地 sent 打回 pending（呢個端點亦只返 sent / printed / failed，根本唔會有 pending 漏出嚟）。
  async function syncCloudPrintOutcomes() {
    const storeId = resolveStoreId();
    if (!storeId) return;
    let res: Response;
    try {
      res = await fetch(`/api/pos/print-jobs/status?storeId=${encodeURIComponent(storeId)}`);
    } catch {
      return; // 離線 / 網絡錯 → 靜默，下個 tick 再試
    }
    if (!res.ok) return;
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; jobs?: Array<{ id: string; status: "sent" | "printed" | "failed"; lastError?: string }> }
      | null;
    if (!data?.ok || !Array.isArray(data.jobs)) return;

    const cloudById = new Map(data.jobs.map((j) => [j.id, j]));
    const current = loadPrintJobs();
    let changed = false;
    const next = current.map((job) => {
      const cloud = cloudById.get(job.id);
      if (!cloud) return job;
      // 終態向上覆寫：本地 sent / pending → 雲端 printed（真實出紙成功）
      if (cloud.status === "printed" && (job.status === "pending" || job.status === "sent")) {
        changed = true;
        return { ...job, status: "printed" as const, lastError: cloud.lastError ?? job.lastError };
      }
      // 終態向上覆寫：本地任何非失敗 → 雲端 failed（印唔到）
      if (cloud.status === "failed" && job.status !== "failed") {
        changed = true;
        return { ...job, status: "failed" as const, lastError: cloud.lastError ?? job.lastError };
      }
      // 雲端 sent 只代表「已交畀通道」，本地已經係 sent 就唔使動（唔降級、唔升級）
      return job;
    });
    if (changed) persistPrintJobs(next);
  }

  function reprintOrder(order: PosOrder) {
    if (reprintingOrderId) return;
    setReprintingOrderId(order.id);
    // B2/B3（docs/56）：重打前由 localStorage re-fetch 最新 order 取本地真值 localOrderNo，
    // 唔好直接讀 in-memory order（state 同 localStorage 唔同步會印錯號，見 8/84 bug）。
    const authoritativeOrder = loadOrders().find((row) => row.id === order.id) ?? order;
    const storeName = loadBootstrapCache()?.storeName ?? "門店";
    const kitchenJobs = buildKitchenPrintJobs(authoritativeOrder, {
      ticketType: "normal",
      storeName,
      orderNoSuffix: " (重打)",
    });
    const labelJobs = buildLabelPrintJobs(authoritativeOrder, {
      ticketType: "normal",
      storeName,
      orderNoSuffix: " (重打)",
    });
    const nextPrintJobs = [...kitchenJobs, ...labelJobs];
    const timestamp = new Date().toISOString();

    if (nextPrintJobs.length === 0) {
      // A3（docs/56）：診斷點解 0 張單 → 冇 zone/label 機 vs 分區對唔中。
      const hasZonePrinter = enabledPrinters.some((p) => p.role === "zone" || p.role === "label");
      setToast({
        tone: "error",
        message: hasZonePrinter
          ? "菜品分區對唔中打印機，重打單不會打印，請檢查設備設置嘅打印機分區。"
          : "未配置廚房（分區/標籤）打印機，重打單唔會打印，請到設備設置添加。",
      });
      setReprintingOrderId(null);
      return;
    }

    persistPrintJobs([...nextPrintJobs, ...printJobs]);
    const events = nextPrintJobs.map<QueueEvent>((job) => ({
      id: uid("evt"),
      type: "PRINT_JOB_CREATED",
      entityId: job.id,
      payload: job,
      status: "pending",
      createdAt: timestamp,
    }));
    pushEvents(events);
    setToast({ tone: "success", message: "已加入重打單打印隊列。" });
    setReprintingOrderId(null);
  }

  function renderDesigner(kind: TemplateKindState) {
    const t = readTemplate(kind);
    const meta = SECTION_META[kind];
    const sel = selectedSection[kind];
    const selStyle = t.blocks[sel];
    const isLabel = kind === "label";
    const isKitchen = kind === "kitchen";
    const isShift = kind === "shift";
    // 目前排版係基於邊個範本（純提示；對唔上就顯示「自訂排版」）。
    const activePresetName = isShift
      ? resolveActiveShiftPresetName(localSettings.shiftTemplatePresets, localSettings.activeShiftTemplateId)
      : null;
    // 自助點餐機模版同收據共用同一組區塊（含 items.subSize），所以提示邏輯跟收據
    const isReceiptLike = kind === "receipt" || kind === "kiosk";
    const title =
      kind === "receipt"
        ? "收據模板（ESC/POS）"
        : kind === "label"
          ? "飲品標籤模板（ESC/POS）"
          : kind === "kitchen"
            ? "廚房單模板（ESC/POS）"
            : kind === "shift"
              ? "交班模板（ESC/POS）"
              : "自助點餐機模板（ESC/POS）";
    return (
      <div className="grid gap-3 lg:grid-cols-[360px_minmax(0,1fr)]">
        <article className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="text-sm font-semibold text-slate-900">{title}</div>
          <div className="mt-1 text-xs text-slate-500">
            真實可打印設定：開關、字型大小、粗體、對齊。設計介面 = 螢幕預覽 = 實際出紙。
          </div>
          {kind === "kiosk" && (
            <div className="mt-2 rounded-xl bg-sky-50 px-3 py-2 text-xs leading-relaxed text-sky-700">
              呢個模版只影響自助點餐機 / 客人掃碼落單時印畀客人嘅小票，<b>唔會</b>影響收銀台收據（兩者係獨立槽位）。
              預設內容同收據完全一致；出紙格式亦固定用收據格式，所以三個打印端唔使改。
            </div>
          )}
          {isShift && (
            <>
              <div className="mt-2 rounded-xl bg-sky-50 px-3 py-2 text-xs leading-relaxed text-sky-700">
                交班模板決定「交班結算單」（收工 / 換班時印嘅匯總單）實際出紙：
                逐個統計項決定印唔印（例如唔想印線上分項就熄佢）、調字型大小 / 粗體 / 對齊、
                改區塊順序，抬頭同頁尾都可以自己寫。
                <b>唔會</b>影響收據 / 廚房單 / 標籤。
              </div>
              <div className="mt-3 rounded-xl border border-slate-200 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-slate-600">範本（唔同班別可以用唔同排版）</div>
                  {activePresetName ? (
                    <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                      基於：{activePresetName}
                    </span>
                  ) : (
                    <span className="shrink-0 text-[10px] text-slate-400">自訂排版</span>
                  )}
                </div>
                <div className="mt-2 space-y-1">
                  {localSettings.shiftTemplatePresets.map((preset) => (
                    <div
                      key={preset.id}
                      className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1.5"
                    >
                      {renamingId === preset.id ? (
                        <>
                          <input
                            autoFocus
                            className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1 text-xs"
                            maxLength={SHIFT_PRESET_NAME_MAX}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitRenameShiftPreset(preset.id);
                              if (e.key === "Escape") {
                                setRenamingId(null);
                                setRenameDraft("");
                              }
                            }}
                            placeholder="範本名稱"
                            value={renameDraft}
                          />
                          <button
                            className="shrink-0 rounded bg-slate-900 px-2 py-1 text-[10px] font-semibold text-white"
                            onClick={() => commitRenameShiftPreset(preset.id)}
                            type="button"
                          >
                            確定
                          </button>
                          <button
                            className="shrink-0 rounded px-1.5 py-1 text-[10px] text-slate-500"
                            onClick={() => {
                              setRenamingId(null);
                              setRenameDraft("");
                            }}
                            type="button"
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="min-w-0 flex-1 truncate text-xs text-slate-700">{preset.name}</span>
                          {localSettings.activeShiftTemplateId === preset.id ? (
                            <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                              使用中
                            </span>
                          ) : null}
                          <button
                            className="shrink-0 rounded bg-orange-500 px-2 py-1 text-[10px] font-semibold text-white hover:bg-orange-600"
                            onClick={() => applyShiftPreset(preset.id)}
                            title="把此範本套用成目前排版"
                            type="button"
                          >
                            套用
                          </button>
                          <button
                            className="shrink-0 rounded bg-white px-2 py-1 text-[10px] font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
                            onClick={() => overwriteShiftPreset(preset.id)}
                            title="用目前排版覆蓋此範本"
                            type="button"
                          >
                            覆蓋
                          </button>
                          <button
                            className="shrink-0 rounded px-1.5 py-1 text-[10px] text-slate-500 hover:bg-slate-50"
                            onClick={() => {
                              setRenamingId(preset.id);
                              setRenameDraft(preset.name);
                            }}
                            type="button"
                          >
                            改名
                          </button>
                          <button
                            className="shrink-0 rounded px-1.5 py-1 text-[10px] text-rose-600 hover:bg-rose-50"
                            onClick={() => deleteShiftPreset(preset.id)}
                            type="button"
                          >
                            刪除
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    className="min-w-0 flex-1 rounded-xl border border-slate-200 px-2 py-2 text-sm"
                    maxLength={SHIFT_PRESET_NAME_MAX}
                    onChange={(e) => setNewPresetName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") createShiftPreset();
                    }}
                    placeholder="輸入範本名稱，例如「日結單」"
                    value={newPresetName}
                  />
                  <button
                    className="shrink-0 rounded-xl bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-40"
                    disabled={!newPresetName.trim()}
                    onClick={createShiftPreset}
                    type="button"
                  >
                    儲存為新範本
                  </button>
                </div>
                <div className="mt-1 text-[11px] leading-relaxed text-slate-500">
                  「儲存為新範本」= 把目前排版存落嚟；「套用」= 把範本拷貝成目前排版（之後嘅修改<b>唔會</b>影響範本）；
                  「覆蓋」= 反過來用目前排版更新範本；「刪除」只係由範本庫移除，唔會動到目前生效中嘅排版。
                </div>
              </div>
            </>
          )}
          <div className="mt-3 flex items-center gap-2">
            <button
              className="rounded-xl bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 disabled:opacity-40"
              disabled={!canUndo}
              onClick={() => undoTemplate()}
              type="button"
            >
              撤銷
            </button>
            <button
              className="rounded-xl bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 disabled:opacity-40"
              disabled={!canRedo}
              onClick={() => redoTemplate()}
              type="button"
            >
              重做
            </button>
            <button
              className="rounded-xl bg-orange-500 px-2 py-1 text-[11px] font-semibold text-white shadow-sm hover:bg-orange-600"
              onClick={() => saveTemplateNow()}
              type="button"
            >
              💾 儲存模板
            </button>
          </div>
          <div className="mt-4 text-xs font-semibold text-slate-500">區塊順序（↑ / ↓ 調整）</div>
          {/* 2026-09-11：加一句講清楚 checkbox 嘅作用 —— 因為預覽既然「跟實際設定」，
              商家要一眼知「打勾 = 會印、熄 = 唔會印兼預覽消失」，唔使靠估。 */}
          <div className="mt-1 text-[11px] leading-snug text-slate-400">
            打勾 = 會印，熄 = 唔會印（預覽亦會即刻消失）
          </div>
          <div className="mt-2 space-y-1">
            {t.order.map((id, index) => {
              const m = meta.find((x) => x.id === id);
              const style = t.blocks[id];
              return (
                <div
                  key={id}
                  className={`flex items-center gap-2 rounded-xl border px-2 py-1.5 ${
                    sel === id ? "border-orange-300 bg-orange-50" : "border-slate-200"
                  }`}
                >
                  <input
                    checked={style.visible}
                    onChange={(e) => patchBlock(kind, id, { visible: e.target.checked })}
                    type="checkbox"
                  />
                  <button
                    className="flex-1 text-left text-sm text-slate-700"
                    onClick={() => setSelectedSection((s) => ({ ...s, [kind]: id }))}
                    type="button"
                  >
                    {m?.label ?? id}
                  </button>
                  <button
                    className="rounded px-1 text-slate-500 disabled:opacity-30"
                    disabled={index === 0}
                    onClick={() => moveSection(kind, id, -1)}
                    type="button"
                  >
                    ↑
                  </button>
                  <button
                    className="rounded px-1 text-slate-500 disabled:opacity-30"
                    disabled={index === t.order.length - 1}
                    onClick={() => moveSection(kind, id, 1)}
                    type="button"
                  >
                    ↓
                  </button>
                </div>
              );
            })}
          </div>
        </article>
        <article className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="text-sm font-semibold text-slate-900">
            選中區塊設定：{meta.find((x) => x.id === sel)?.label ?? sel}
          </div>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-xs font-semibold text-slate-600">
              <span>預覽紙寬</span>
              {isLabel ? (
                <select
                  className="rounded-xl border border-slate-200 bg-white px-2 py-2 text-sm"
                  value={labelPaperPreset(t.paperSize).id}
                  onChange={(e) => setLabelPaperSize(e.target.value)}
                >
                  {LABEL_PAPER_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label} mm · {preset.columns} 字／行
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  className="rounded-xl border border-slate-200 bg-white px-2 py-2 text-sm"
                  value={previewPaperMm}
                  onChange={(e) => setPreviewPaperMm(Number(e.target.value) === 58 ? 58 : 80)}
                >
                  <option value={80}>80 mm · {RECEIPT_PAPER_COLUMNS} 字／行</option>
                  <option value={58}>58 mm · {RECEIPT_PAPER_COLUMNS_58MM} 字／行</option>
                </select>
              )}
            </label>
            {isLabel ? (
              <div className="max-w-[280px] text-[11px] leading-snug text-slate-500">
                {labelPaperPreset(t.paperSize).hint}。字型檔位已鎖定喺最適合嘅大小，
                你仍然可以調「對齊 / 粗體 / 可見」同區塊順序。
              </div>
            ) : (
              <div className="max-w-[280px] text-[11px] leading-snug text-slate-500">
                同一個模板會派去唔同機，所以預覽紙寬係手動切（出紙會跟番每部機自己嘅設定）。
              </div>
            )}
          </div>
            <div className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
              預覽<b>同實際出紙一致</b>：左邊冇打勾嘅區塊，呢度唔會顯示（想返嚟就打勾）。
              內容全部係<b>固定示例資料</b>，唔係真實訂單。實際出紙亦只會印有資料嘅區塊。
            </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {isLabel ? (
              // 標籤實體寬度固定（62mm 標準標籤卷）→ 字型檔位鎖死，唔畀動態改。
              <label className="grid gap-1 text-xs font-semibold text-slate-600">
                <span>字型大小</span>
                <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
                  <span>{selStyle.size === "l" ? "大" : selStyle.size === "m" ? "中" : "細"}</span>
                  <span className="text-[10px] text-slate-400">🔒 鎖定</span>
                </div>
              </label>
            ) : (
              <label className="grid gap-1 text-xs font-semibold text-slate-600">
                <span>字型大小</span>
                <select
                  className="rounded-xl border border-slate-200 bg-white px-2 py-2 text-sm"
                  value={selStyle.size}
                  onChange={(e) => patchBlock(kind, sel, { size: e.target.value as EscPosSize })}
                >
                  <option value="s">細</option>
                  <option value="m">中</option>
                  <option value="l">大</option>
                </select>
              </label>
            )}
            <label className="grid gap-1 text-xs font-semibold text-slate-600">
              <span>對齊</span>
              <select
                className="rounded-xl border border-slate-200 bg-white px-2 py-2 text-sm"
                value={selStyle.align}
                onChange={(e) => patchBlock(kind, sel, { align: e.target.value as EscPosAlign })}
              >
                <option value="left">左對齊</option>
                <option value="center">置中</option>
                <option value="right">右對齊</option>
              </select>
            </label>
            <label className="flex items-end justify-start gap-2 pb-2 text-xs font-semibold text-slate-600">
              <input
                checked={selStyle.bold}
                onChange={(e) => patchBlock(kind, sel, { bold: e.target.checked })}
                type="checkbox"
              />
              <span>粗體</span>
            </label>
          </div>
          {sel === "items" && (
            <div className="mt-3 grid grid-cols-3 gap-2">
              <label className="grid gap-1 text-xs font-semibold text-slate-600">
                <span>規格 / 備註大小</span>
                <select
                  className="rounded-xl border border-slate-200 bg-white px-2 py-2 text-sm"
                  value={selStyle.subSize ?? "s"}
                  onChange={(e) => patchBlock(kind, sel, { subSize: e.target.value as EscPosSize })}
                >
                  <option value="s">細</option>
                  <option value="m">中</option>
                  <option value="l">大</option>
                </select>
              </label>
            </div>
          )}
          {sel === "divider" ? (
            <div className="mt-3 rounded-xl bg-sky-50 px-3 py-2 text-xs leading-relaxed text-sky-700">
              「分格線」係<b>設定型區塊</b>：佢自己唔會印文字，而係控制單據入面<b>所有</b>自動分格線
              （菜品明細前後、card 排版每件菜之間）嘅<b>粗細</b>。
              實體打印嘅分格線係一串 <code>-</code> 字符，揀「中 / 大」會用雙闊字印同一條線（睇落粗啲）；
              dash 數量會相應減半，所以<b>任何大小都只會佔一行</b>。
              左邊剔走個剔 = 全張單唔印分格線。（粗體 / 對齊對分格線無效。）
            </div>
          ) : null}
          {sel !== "items" && (isReceiptLike || isKitchen) ? (
            <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
              想調整每道菜的「規格 / 備註」字體大小？請在左側「區塊順序」中點選「菜品明細」區塊，設定會出現在該區塊下方。
            </div>
          ) : null}
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {(isLabel || isKitchen || isShift) && (
              <label className="grid gap-1 text-xs font-semibold text-slate-600">
                <span>{isShift ? "標題文字（抬頭）" : "標題文字"}</span>
                <input
                  className="rounded-xl border border-slate-200 bg-white px-2 py-2 text-sm"
                  value={t.headerText ?? ""}
                  onChange={(e) => setHeader(kind, e.target.value)}
                />
              </label>
            )}
            <label className={`grid gap-1 text-xs font-semibold text-slate-600 ${isLabel || isKitchen || isShift ? "" : "sm:col-span-2"}`}>
              <span>頁尾文字</span>
              <input
                className="rounded-xl border border-slate-200 bg-white px-2 py-2 text-sm"
                value={t.footerText}
                onChange={(e) => setFooter(kind, e.target.value)}
              />
            </label>
            {isShift && sel.startsWith("section_") ? (
              <label className="grid gap-1 text-xs font-semibold text-slate-600 sm:col-span-2">
                <span>分節標題文字（清空 = 唔印呢個標題）</span>
                <input
                  className="rounded-xl border border-slate-200 bg-white px-2 py-2 text-sm"
                  onChange={(e) => setSectionTitle(sel as ShiftSectionId, e.target.value)}
                  placeholder="例如：— 店內（今日）—"
                  value={t.sectionTitles?.[sel as ShiftSectionId] ?? ""}
                />
              </label>
            ) : null}
            {isReceiptLike ? (
              <div className="grid gap-1 text-xs font-semibold text-slate-600 sm:col-span-2">
                <span>二維碼網址</span>
                <div className="flex items-center gap-2">
                  <input
                    className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-2 py-2 text-sm"
                    inputMode="url"
                    placeholder="https://example.com"
                    value={t.qrUrl ?? ""}
                    onChange={(e) => setQrUrl(kind, e.target.value)}
                  />
                  <button
                    className="shrink-0 rounded-xl bg-orange-500 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
                    disabled={!(t.qrUrl ?? "").trim()}
                    onClick={() => generateQr(kind)}
                    type="button"
                  >
                    生成
                  </button>
                </div>
                <div className="mt-1 flex items-center gap-4">
                  <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                    <span>打印大小</span>
                    <select
                      className="rounded-xl border border-slate-200 bg-white px-2 py-1 text-sm"
                      value={t.qrSize ?? "m"}
                      onChange={(e) => setQrSize(kind, e.target.value as EscPosSize)}
                    >
                      <option value="s">細</option>
                      <option value="m">中</option>
                      <option value="l">大</option>
                    </select>
                  </label>
                  <span className="text-[11px] font-normal leading-relaxed text-slate-500">
                    {(t.qrUrl ?? "").trim() && !encodeQrPayload(t.qrUrl)
                      ? "⚠️ 網址太長，無法生成二維碼（請用短網址）。"
                      : "網址會喺收據底部印成二維碼；留空 / 太長都唔會印。收據同自助點餐機係兩個獨立設定。"}
                  </span>
                </div>
                <QrFieldPreview url={t.qrUrl ?? ""} size={t.qrSize ?? "m"} />
              </div>
            ) : null}
          </div>
          <div className="mt-4 text-sm font-semibold text-slate-900">即時預覽（真實熱敏樣式）</div>
          {/* overflow-x-auto：紙闊由「每行字數」反推出嚟（80mm 比舊版闊），
              窄螢幕嗰陣可以橫向捲，唔會迫爆右邊欄。 */}
          <div className="mt-2 overflow-x-auto">
            <EscPosPreview lines={buildPreviewLines(kind)} columns={previewColumns(kind)} />
          </div>
        </article>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="flex h-[100dvh] overflow-hidden md:pl-[72px]">
        <main className="flex h-full flex-1 flex-col overflow-hidden">
          <div className="border-b border-slate-200 bg-white px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">打印</div>
                <div className="mt-1 text-sm text-slate-500">查看打印狀態、模板設計與重打。</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {[
                  ["records", "打印記錄"],
                  ["receipt-template", "收據模板"],
                  ["label-template", "標籤模板"],
                  ["kitchen-template", "廚房模板"],
                  ["shift-template", "交班模板"],
                  ["kiosk-template", "自助點餐機"],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    className={`rounded-full px-4 py-2 text-sm font-semibold ${
                      activeTab === key ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
                    }`}
                    onClick={() => setActiveTab(key as typeof activeTab)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {!hasChannel && (
            <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
              ⚠️ 未配置打印通道：Android 裝置需要 PosNative（APK），桌面瀏覽器請到「設備設置」配對桌面 Companion 代理（Companion URL），或設定雲端打印備援（relay）。未配置前所有單據只會排入佇列、唔會實際出紙。
            </div>
          )}

          <div className="flex-1 overflow-auto p-4">
            {activeTab === "records" ? (
              <>
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  {[
                    ["all", "全部"],
                    ["sent", "已發送"],
                    ["printed", "打印成功"],
                    ["pending", "待補傳"],
                    ["failed", "失敗"],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      className={`rounded-full px-4 py-2 text-sm font-semibold ${
                        filter === key ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
                      }`}
                      onClick={() => setFilter(key as typeof filter)}
                      type="button"
                    >
                      {label}
                    </button>
                  ))}
                  {/* 時間篩選：今天 / 昨天 / 7天 / 30天 / 全部，預設「今天」。
                      docs/任務：時間篩選與狀態篩選係 AND 關係。 */}
                  <div className="ml-3 flex flex-wrap items-center gap-1 rounded-full bg-slate-100 p-1 text-xs font-semibold">
                    {[
                      ["today", "今天"],
                      ["yesterday", "昨天"],
                      ["7d", "7天"],
                      ["30d", "30天"],
                      ["all", "全部"],
                    ].map(([key, label]) => (
                      <button
                        key={key}
                        className={`rounded-full px-3 py-1.5 ${
                          dateFilter === key ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
                        }`}
                        onClick={() => setDateFilter(key as ReportRangeKey)}
                        type="button"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <button
                    className="ml-auto rounded-full bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-300"
                    onClick={() => clearSentPrintJobs()}
                    type="button"
                  >
                    清除已發送
                  </button>
                  <button
                    className="rounded-full bg-sky-100 px-4 py-2 text-sm font-semibold text-sky-700 hover:bg-sky-200"
                    onClick={() => clearPrintedPrintJobs()}
                    type="button"
                  >
                    清除已成功
                  </button>
                  <button
                    className="rounded-full bg-red-100 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-200"
                    onClick={() => clearFailedPrintJobs()}
                    type="button"
                  >
                    清除已失敗
                  </button>
                </div>

                {filteredJobs.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
                    目前沒有打印記錄
                    {dateFilter !== "all" || filter !== "all" ? (
                      <div className="mt-2 text-xs text-slate-400">
                        （已套用
                        {dateFilter !== "all" ? `時間：${dateFilter === "today" ? "今天" : dateFilter === "yesterday" ? "昨天" : dateFilter === "7d" ? "最近 7 天" : "最近 30 天"}` : ""}
                        {filter !== "all" ? `${dateFilter !== "all" ? "・" : ""}狀態：${filter === "sent" ? "已發送" : filter === "printed" ? "打印成功" : filter === "pending" ? "待補傳" : "失敗"}` : ""}）
                      </div>
                    ) : null}
                  </div>
                ) : (
                  /*
                    列表（2026-09-10）：每筆打印記錄一行。欄位同原本卡片完全一致（訂單號／餐台／
                    打印機／票種／時間／失敗原因／狀態／操作），操作統一釘最右。
                    響應式（2026-09-10 修）：欄寬百分比化 + `table-fixed`，表格永遠等於容器闊度；
                    原本 `overflow-hidden` + `min-w-[1080px]` 會剪走最右「操作」欄（iPad 只見半個掣）。
                  */
                  <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
                    <table className="w-full min-w-[860px] table-fixed border-collapse text-left">
                      <thead>
                        <tr>
                          <th className={`${TH_CELL} w-[11%]`}>訂單號</th>
                          <th className={`${TH_CELL} w-[10%]`}>餐台</th>
                          <th className={`${TH_CELL} w-[13%]`}>打印機</th>
                          <th className={`${TH_CELL} w-[10%]`}>票種</th>
                          <th className={`${TH_CELL} w-[12%]`}>時間</th>
                          <th className={TH_CELL}>失敗原因</th>
                          <th className={`${TH_CELL} w-[11%]`}>狀態</th>
                          <th className={`${TH_CELL} w-[19%] text-right`}>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredJobs.map((job) => (
                          <tr key={job.id} className="border-t border-slate-100 even:bg-slate-50/60">
                            <td className={TD_CELL}>
                              <div className="truncate text-sm font-semibold text-slate-900">
                                {job.orderNo ?? job.orderId}
                              </div>
                            </td>
                            <td className={TD_CELL}>
                              <div className="truncate text-xs text-slate-500">{job.tableName ?? "--"}</div>
                            </td>
                            <td className={TD_CELL}>
                              <div className="truncate text-xs text-slate-500">{job.printerName}</div>
                            </td>
                            <td className={TD_CELL}>
                              <div className="truncate text-xs text-slate-500">
                                {ticketTypeLabel(job.ticketType)}
                              </div>
                            </td>
                            <td className={TD_CELL}>
                              <div className="text-xs tabular-nums text-slate-400">
                                {formatMacauDateTime(job.createdAt)}
                              </div>
                            </td>
                            <td className={TD_CELL}>
                              {job.status === "failed" && job.lastError ? (
                                <div className="line-clamp-2 text-xs leading-relaxed text-red-700" title={job.lastError}>
                                  {job.lastError}
                                </div>
                              ) : (
                                <span className="text-xs text-slate-300">—</span>
                              )}
                            </td>
                            <td className={TD_CELL}>
                              {/* 狀態藥丸：顏色／文字沿用原本卡片，縮到表格尺寸 */}
                              {(() => {
                                const s = job.status;
                                const dot =
                                  s === "printed"
                                    ? "bg-sky-500"
                                    : s === "sent"
                                      ? "bg-emerald-500"
                                      : s === "pending"
                                        ? "bg-amber-500"
                                        : "bg-red-500";
                                const cls =
                                  s === "printed"
                                    ? "bg-sky-50 text-sky-700"
                                    : s === "sent"
                                      ? "bg-emerald-50 text-emerald-700"
                                      : s === "pending"
                                        ? "bg-amber-50 text-amber-700"
                                        : "bg-red-50 text-red-700";
                                const label =
                                  s === "printed"
                                    ? "打印成功"
                                    : s === "sent"
                                      ? "已發送"
                                      : s === "pending"
                                        ? "待補傳"
                                        : s === "failed"
                                          ? "失敗"
                                          : "失敗（狀態異常）";
                                return (
                                  <span
                                    className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}
                                  >
                                    <span className={`h-2 w-2 rounded-full ${dot}`} />
                                    {label}
                                  </span>
                                );
                              })()}
                            </td>
                            <td className={`${TD_CELL} text-right`}>
                              <div className="flex flex-wrap items-center justify-end gap-1.5">
                                <button
                                  className="rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                                  onClick={() => setActiveJobId(job.id)}
                                  type="button"
                                >
                                  查看
                                </button>
                                {job.status === "failed" || job.status === "pending" ? (
                                  <button
                                    className="whitespace-nowrap rounded-xl bg-orange-500 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                                    disabled={Boolean(retryingJobId)}
                                    onClick={() => {
                                      setRetryingJobId(job.id);
                                      void retryFailedPrintJob(job.id)
                                        .then((next) => {
                                          setPrintJobs(next);
                                          setToast({
                                            tone: "success",
                                            message:
                                              next.find((row) => row.id === job.id)?.status === "sent"
                                                ? "已重新送出打印。"
                                                : "重試失敗，請檢查橋接服務與打印機。",
                                          });
                                        })
                                        .finally(() => setRetryingJobId(null));
                                    }}
                                    type="button"
                                  >
                                    {retryingJobId === job.id ? "重試中…" : "重試打印"}
                                  </button>
                                ) : (
                                  <button
                                    aria-busy={(() => {
                                      const order = findJobSourceOrder(job);
                                      return order ? reprintingOrderId === order.id : false;
                                    })()}
                                    className="whitespace-nowrap rounded-xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-60"
                                    disabled={Boolean(reprintingOrderId)}
                                    onClick={() => {
                                      const order = findJobSourceOrder(job);
                                      if (!order) {
                                        setToast({
                                          tone: "error",
                                          message: job.orderId.startsWith("ledger-")
                                            ? "線上訂單資料已不在本機快取（例如剛重新載入頁面），無法重打整單；請到訂單頁「查看」→「補打帳單（收據）」。"
                                            : "找不到原始訂單，無法重打。",
                                        });
                                        return;
                                      }
                                      reprintOrder(order);
                                    }}
                                    type="button"
                                  >
                                    {(() => {
                                      const order = findJobSourceOrder(job);
                                      return order && reprintingOrderId === order.id ? "打印中…" : "重打整單";
                                    })()}
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            ) : null}

            {activeTab === "receipt-template" ? renderDesigner("receipt") : null}
            {activeTab === "label-template" ? renderDesigner("label") : null}
            {activeTab === "kitchen-template" ? renderDesigner("kitchen") : null}
            {activeTab === "shift-template" ? renderDesigner("shift") : null}
            {activeTab === "kiosk-template" ? renderDesigner("kiosk") : null}
          </div>
        </main>
      </div>

      {activeJob ? (
        <ResponsiveModal
          description={`${activeJob.orderNo ?? activeJob.orderId} · ${activeJob.tableName ?? "--"}`}
          onClose={() => setActiveJobId(null)}
        >
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">{activeJob.printerName}</div>
                <div className="mt-1 text-xs text-slate-500">
                  {activeJob.printerGroup} · {ticketTypeLabel(activeJob.ticketType)} ·{" "}
                  {activeJob.status === "printed"
                    ? "打印成功"
                    : activeJob.status === "sent"
                      ? "已發送"
                      : activeJob.status === "pending"
                        ? "待補傳"
                        : "失敗"}
                </div>
              </div>
              <div className="text-right text-xs text-slate-500">{formatMacauDateTime(activeJob.createdAt)}</div>
            </div>
            <div className="mt-3">
              {activeJob.template ? (
                <EscPosPreview
                  lines={renderEscPosLines(activeJob.template, activeJob.content, activeJob.items ?? [], {
                    qr: activeJob.qr ?? null,
                  })}
                  columns={
                    activeJob.template.cols ??
                    (activeJob.template.kind === "label"
                      ? labelPaperPreset(localSettings.printTemplates.label.paperSize).columns
                      : RECEIPT_PAPER_COLUMNS)
                  }
                />
              ) : (
                <KitchenTicketPreview job={activeJob} />
              )}
            </div>
          </div>
        </ResponsiveModal>
      ) : null}

      {toast && (
        <div
          className={`fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-xl px-4 py-2 text-sm font-semibold shadow-lg ${
            toast.tone === "success" ? "bg-emerald-600 text-white" : "bg-rose-600 text-white"
          }`}
          role="status"
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
