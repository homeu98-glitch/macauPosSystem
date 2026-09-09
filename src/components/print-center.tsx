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
import { buildKitchenPrintJobs, buildLabelPrintJobs, clearFailedPrintJobs, clearPrintedPrintJobs, clearSentPrintJobs, normalizePrintJobStatus } from "@/lib/print-jobs";
import {
  getLocalSettingsKey,
  hasPosLocalSettings,
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
import { DeviceConfig, EscPosAlign, EscPosBlockStyle, EscPosSize, LABEL_STANDARD_WIDTH_MM, PosLocalSettings, PosOrder, PrintJob, QueueEvent } from "@/lib/types";
import {
  ledgerReportRangeForKey,
  macauDateKey,
  type ReportRangeKey,
} from "@/lib/ledger/report-period";
import {
  buildKitchenContent,
  buildLabelContent,
  buildReceiptContent,
  buildSnapshot,
  ensureDividerSection,
  ensureReceiptSections,
  KITCHEN_SECTION_META,
  LABEL_SECTION_META,
  RECEIPT_SECTION_META,
  withLabelFixedSizes,
} from "@/lib/escpos-template";
import { EscPosLine, PrintItemLine, renderEscPosLines, formatSpecLine, unitBasePrice } from "@/lib/escpos-render";
import { encodeQrPayload, QR_QUIET_MODULES, QR_SIZE_FRACTION, QR_SIZE_LABEL } from "@/lib/escpos-qr";
import { discountedUnitPrice } from "@/lib/pos/discount";
import { resolveStoreTel } from "@/lib/pos/store-tel";
import { notifyQueueChanged } from "@/lib/pos/sync-flush";
import { enqueueEvents } from "@/lib/pos/queue-outbox";
import {
  fetchStorePrintTemplates,
  pushStorePrintTemplates,
} from "@/lib/print-templates-sync";

/**
 * 模板設計介面嘅四個槽位。注意 `"kiosk"` 係**模版內容**嘅槽位，唔係 ESC/POS `kind`：
 * 渲染嗰陣一律用 `kind = "receipt"`（見 `KioskPreviewKind`），三個 repo 先唔使改。
 */
type TemplateKindState = "receipt" | "label" | "kitchen" | "kiosk";

const SECTION_META: Record<TemplateKindState, { id: string; label: string }[]> = {
  receipt: RECEIPT_SECTION_META as unknown as { id: string; label: string }[],
  label: LABEL_SECTION_META as unknown as { id: string; label: string }[],
  kitchen: KITCHEN_SECTION_META as unknown as { id: string; label: string }[],
  // 自助點餐機模版同收據係同一組區塊（規格 8：格式完全一致）
  kiosk: RECEIPT_SECTION_META as unknown as { id: string; label: string }[],
};

/**
 * docs/87 §2.3：自助點餐機模版係獨立槽位，但渲染時嘅 ESC/POS `kind` 必須係 `"receipt"`。
 * 三個下游 repo（POS / desktop-companion / print-agent-android）嘅標題表只認
 * `receipt | label | kitchen`，傳 `"kiosk"` 會 fallthrough 到空標題。
 */
function snapshotKindOf(kind: TemplateKindState): "receipt" | "label" | "kitchen" {
  return kind === "kiosk" ? "receipt" : kind;
}

const PREVIEW_STORE_NAME = "澳門示範店";

/**
 * 示例訂單：當店內仲未有任何真實訂單時，模板預覽改用呢個，
 * 令設計介面喺有啟用打印機嘅情況下一定出到嘢。
 */
const SYNTHETIC_SAMPLE_ORDER: PosOrder = {
  id: "__preview_sample__",
  localOrderNo: "A1001",
  tableId: "table-a01",
  tableName: "A01",
  status: "paid",
  items: [
    {
      menuItemId: "item-pearl-milk-tea",
      name: "珍珠奶茶",
      quantity: 1,
      price: 28,
      printerGroup: "drinks",
      selectedSpecs: [
        { groupId: "sugar", groupName: "甜度", optionId: "half", optionLabel: "半糖", priceDelta: 0 },
        { groupId: "ice", groupName: "冰量", optionId: "less", optionLabel: "少冰", priceDelta: 0 },
        { groupId: "cup", groupName: "杯型", optionId: "large", optionLabel: "大杯", priceDelta: 0 },
      ],
      note: "",
    },
    {
      menuItemId: "item-lemon-tea",
      name: "檸檬茶",
      quantity: 2,
      price: 22,
      printerGroup: "drinks",
      selectedSpecs: [
        { groupId: "sugar", groupName: "甜度", optionId: "normal", optionLabel: "全糖", priceDelta: 0 },
        { groupId: "ice", groupName: "冰量", optionId: "none", optionLabel: "走冰", priceDelta: 0 },
      ],
      note: "加珍珠",
    },
  ],
  subtotal: 72,
  taxAmount: 0,
  serviceChargeAmount: 0,
  discountAmount: 0,
  total: 72,
  paymentMethod: "現金",
  createdAt: "2026-08-24T12:00:00.000Z",
  updatedAt: "2026-08-24T12:00:00.000Z",
};

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
    "records" | "receipt-template" | "label-template" | "kitchen-template" | "kiosk-template"
  >("records");
  const [localSettings, setLocalSettings] = useState(() => loadPosLocalSettings() ?? defaultPosLocalSettings);
  const [deviceConfig, setDeviceConfig] = useState<DeviceConfig>(() => loadDeviceConfig() ?? defaultDeviceConfig);
  const [selectedSection, setSelectedSection] = useState<Record<TemplateKindState, string>>({
    receipt: "store_name",
    label: "header",
    kitchen: "store_name",
    kiosk: "store_name",
  });
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [reprintingOrderId, setReprintingOrderId] = useState<string | null>(null);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
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
    const result = await pushStorePrintTemplates(storeId, settings.printTemplates);
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
      const next: PosLocalSettings = { ...prev, printTemplates: res.templates };
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
  // 聯合設置模組：有啟用打印機就應出到預覽，唔好等真實訂單。無訂單時退用示例訂單。
  const usingSampleOrder = orders.length === 0;
  const sampleOrder = useMemo<PosOrder>(() => orders[0] ?? SYNTHETIC_SAMPLE_ORDER, [orders]);

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
  };

  function readTemplate(kind: TemplateKindState): AnyTemplate {
    const raw = localSettings.printTemplates[kind] as unknown as AnyTemplate;
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

  function updateLocalTemplate(nextSettings: typeof localSettings, options?: { recordHistory?: boolean }) {
    if (options?.recordHistory !== false) {
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

    const result = await pushStorePrintTemplates(storeId, localSettings.printTemplates);
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

  function buildPreviewLines(kind: TemplateKindState): EscPosLine[] {
    const t = readTemplate(kind);
    const snapshot = buildSnapshot(snapshotKindOf(kind), t as unknown as Parameters<typeof buildSnapshot>[1]);
    if (kind === "label") {
      const item = sampleOrder.items[0];
      if (!item) return [];
      const content = buildLabelContent(sampleOrder, item, {
        storeName: PREVIEW_STORE_NAME,
        headerText: t.headerText ?? "",
        footerText: t.footerText,
      });
      return renderEscPosLines(snapshot, content, []);
    }
    if (kind === "kitchen") {
      const content = buildKitchenContent(sampleOrder, {
        storeName: PREVIEW_STORE_NAME,
        footerText: t.footerText,
        typeLabel: "落單",
        time: "12:00",
        // 唔帶 orderNote → 就算抽中嘅 sample order 有全單備註，設計頁預覽都唔會顯示
        //（與 print-jobs.ts buildKitchenPrintJobs 同一 bug，一齊修）。
        orderNote: sampleOrder.orderNote,
      });
      const items: PrintItemLine[] = sampleOrder.items.map((it) => ({
        name: it.name,
        quantity: it.quantity,
        specs: (it.selectedSpecs ?? []).map((s) => `${s.groupName}:${s.optionLabel}`),
        note: it.note,
      }));
      return renderEscPosLines(snapshot, content, items, { qr: encodeQrPayload(t.qrUrl), qrSize: t.qrSize ?? "m" });
    }
    const content = buildReceiptContent(sampleOrder, {
      storeName: PREVIEW_STORE_NAME,
      // 以前硬編 `(853) 2888-0000`，令「列印中心」預覽永遠顯示一個唔存在嘅假電話。
      // 改用同一個 resolver：門店設定 → 商家登入號碼。見 src/lib/pos/store-tel.ts。
      storeTel: resolveStoreTel(loadBootstrapCache()?.storeTel),
      currency: "MOP",
      footerText: t.footerText,
      serverName: "示範收銀員",
    });
    const items: PrintItemLine[] = sampleOrder.items.map((it) => {
      const base = unitBasePrice(it);
      const rate = it.discountRate;
      const hasDiscount = typeof rate === "number" && rate > 0 && rate < 100;
      const discounted = hasDiscount ? discountedUnitPrice(base, rate) : base;
      const saving = hasDiscount ? Math.round((base - discounted) * it.quantity * 100) / 100 : 0;
      return {
        name: it.name,
        quantity: it.quantity,
        price: it.price > 0 ? Math.round(discounted * it.quantity) : undefined,
        discountRate: hasDiscount ? rate : undefined,
        originalUnitPrice: hasDiscount ? Math.round(base) : undefined,
        discountedUnitPrice: hasDiscount ? Math.round(discounted) : undefined,
        savingAmount: saving > 0 ? saving : undefined,
        specs: (it.selectedSpecs ?? []).map((s) => formatSpecLine(s)),
        note: it.note,
      };
    });
    // 收據 / 自助點餐機：必須帶埋 qr + qrSize，否則二維碼喺設計介面預覽永遠唔顯示（#模板 QR bug）。
    return renderEscPosLines(snapshot, content, items, { qr: encodeQrPayload(t.qrUrl), qrSize: t.qrSize ?? "m" });
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
    // 自助點餐機模版同收據共用同一組區塊（含 items.subSize），所以提示邏輯跟收據
    const isReceiptLike = kind === "receipt" || kind === "kiosk";
    const title =
      kind === "receipt"
        ? "收據模板（ESC/POS）"
        : kind === "label"
          ? "飲品標籤模板（ESC/POS）"
          : kind === "kitchen"
            ? "廚房單模板（ESC/POS）"
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
          {isLabel ? (
            <div className="mt-2 rounded-xl bg-sky-50 px-3 py-2 text-xs leading-relaxed text-sky-700">
              🏷️ 標籤紙實體寬度固定為 <b>{LABEL_STANDARD_WIDTH_MM} mm</b>（標準飲品/杯貼標籤卷，系統鎖定）。
              因此各區塊<b>字型大小已鎖定</b>為最適合嘅檔位，唔可以動態改大/改細——你仍然可以調「對齊 / 粗體 / 可見」同區塊順序。
            </div>
          ) : null}
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
              （菜品明細前後、card 排版每件菜之間）嘅<b>字體大小</b>。
              實體打印嘅分格線係一串 <code>-</code> 字符，會跟呢個字體大小一齊放大 ——
              揀「中 / 大」（雙闊）嗰陣 48 個 dash 會排成兩行，<b>預覽同出紙完全一致</b>。
              左邊剔走個剔 = 全張單唔印分格線。（粗體 / 對齊對分格線無效。）
            </div>
          ) : null}
          {sel !== "items" && (isReceiptLike || isKitchen) ? (
            <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
              想調整每道菜的「規格 / 備註」字體大小？請在左側「區塊順序」中點選「菜品明細」區塊，設定會出現在該區塊下方。
            </div>
          ) : null}
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {(isLabel || isKitchen) && (
              <label className="grid gap-1 text-xs font-semibold text-slate-600">
                <span>標題文字</span>
                <input
                  className="rounded-xl border border-slate-200 bg-white px-2 py-2 text-sm"
                  value={t.headerText ?? ""}
                  onChange={(e) => setHeader(kind, e.target.value)}
                />
              </label>
            )}
            <label className={`grid gap-1 text-xs font-semibold text-slate-600 ${isLabel || isKitchen ? "" : "sm:col-span-2"}`}>
              <span>頁尾文字</span>
              <input
                className="rounded-xl border border-slate-200 bg-white px-2 py-2 text-sm"
                value={t.footerText}
                onChange={(e) => setFooter(kind, e.target.value)}
              />
            </label>
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
          <div className="mt-2">
            {kind === "label" && sampleOrder.items.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
                需要最少一個菜品嚟預覽標籤。
              </div>
            ) : (
              <EscPosPreview lines={buildPreviewLines(kind)} paperWidthMm={kind === "label" ? LABEL_STANDARD_WIDTH_MM : 80} />
            )}
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
                  <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                    {filteredJobs.map((job) => (
                      <article key={job.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold text-slate-900">{job.orderNo ?? job.orderId}</div>
                            <div className="mt-1 text-xs text-slate-500">
                              {job.tableName ?? "--"} · {job.printerName} · {ticketTypeLabel(job.ticketType)}
                            </div>
                          </div>
                          <span
                            className={`rounded-full px-3 py-1 text-xs font-semibold ${
                              job.status === "printed"
                                ? "bg-sky-50 text-sky-700"
                                : job.status === "sent"
                                  ? "bg-emerald-50 text-emerald-700"
                                  : job.status === "pending"
                                    ? "bg-amber-50 text-amber-700"
                                    : "bg-red-50 text-red-700"
                            }`}
                          >
                            {job.status === "printed"
                              ? "打印成功"
                              : job.status === "sent"
                                ? "已發送"
                                : job.status === "pending"
                                  ? "待補傳"
                                  : job.status === "failed"
                                    ? "失敗"
                                    : "失敗（狀態異常）"}
                          </span>
                        </div>

                        {job.status === "failed" && job.lastError ? (
                          <div className="mt-3 whitespace-pre-wrap break-words rounded-xl bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700">
                            <span className="font-semibold">失敗原因：</span>
                            {job.lastError}
                          </div>
                        ) : null}

                        <div className="mt-3 text-xs text-slate-500">{formatMacauDateTime(job.createdAt)}</div>

                        <div className="mt-4 grid grid-cols-2 gap-2">
                          <button
                            className="rounded-2xl bg-white px-3 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                            onClick={() => setActiveJobId(job.id)}
                            type="button"
                          >
                            查看
                          </button>
                          {job.status === "failed" || job.status === "pending" ? (
                            <button
                              className="rounded-2xl bg-orange-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
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
                                const order = orderMap.get(job.orderId);
                                return order ? reprintingOrderId === order.id : false;
                              })()}
                              className="rounded-2xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                              disabled={Boolean(reprintingOrderId)}
                              onClick={() => {
                                const order = orderMap.get(job.orderId);
                                if (!order) {
                                  setToast({ tone: "error", message: "找不到原始訂單，無法重打。" });
                                  return;
                                }
                                reprintOrder(order);
                              }}
                              type="button"
                            >
                              {(() => {
                                const order = orderMap.get(job.orderId);
                                return order && reprintingOrderId === order.id ? "打印中…" : "重打整單";
                              })()}
                            </button>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </>
            ) : null}

            {activeTab === "receipt-template" ? renderDesigner("receipt") : null}
            {activeTab === "label-template" ? renderDesigner("label") : null}
            {activeTab === "kitchen-template" ? renderDesigner("kitchen") : null}
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
                  paperWidthMm={activeJob.template.kind === "label" ? LABEL_STANDARD_WIDTH_MM : 80}
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
