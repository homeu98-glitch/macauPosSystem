"use client";

import { defaultDeviceConfig } from "@/lib/mock-data";
import {
  addClearedPrintJobIds,
  loadAuthSession,
  loadBootstrapCache,
  loadClearedPrintJobIds,
  loadDeviceConfig,
  loadOrders,
  loadPosLocalSettings,
  loadPrintJobs,
  loadQueue,
  savePrintJobs,
  saveQueue,
} from "@/lib/storage";
import { enqueueEvents } from "@/lib/pos/queue-outbox";
import { notifyQueueChanged, withStoreScope } from "@/lib/pos/sync-flush";
import { mergePrintJobs } from "@/lib/pos/print-job-merge";
import { resolveStoreTel } from "@/lib/pos/store-tel";
import { resolveStoreId } from "@/lib/pos/sync-flush";
import { posDeviceAuthHeaders } from "@/lib/pos/pos-sync-auth";
import { PosBootstrap, PosOrder, PrintJob, QueueEvent, ReceiptTemplate, ShiftSettlementSnapshot, ShiftTemplate } from "@/lib/types";
import {
  getBridgedPosOrder,
  resolveLedgerPosOrderForReceipt,
} from "@/lib/ledger/ledger-pos-bridge";
import type { LedgerOnlineOrder } from "@/lib/ledger/order-mapper";
import type { LedgerOrderDetail } from "@/lib/ledger/orders";
import {
  buildKitchenContent,
  buildLabelContent,
  buildReceiptContent,
  buildShiftContent,
  buildSnapshot,
  labelPaperPreset,
  normalizeShiftTemplate,
  paperColumnsFromSize,
  ticketTypeLabel,
} from "@/lib/escpos-template";
import { PrintItemLine } from "@/lib/escpos-render";
import { toPrintItemLines } from "@/lib/escpos-render";
import { encodeQrPayload } from "@/lib/escpos-qr";

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function nowText() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 細粒度開關判斷抽離到 `@/lib/print-toggles`（避免 print-jobs ↔ ledger-pos-bridge 循環）。
// 保持本地 import + 對外 re-export，舊有 import site 唔使改。
import { isPrintContentEnabled } from "@/lib/print-toggles";
export { isPrintContentEnabled };

/**
 * 列印任務狀態標準化。
 *
 * 列印任務 `status` 法定值係 `"pending" | "sent" | "failed"`，但舊 localStorage 或雲端
 * 回填可能寫入無效值（例如 undefined / 空字串），導致 UI 徽章 catch-all 顯示「失敗」
 * 但「失敗」分頁用 `=== "failed"` 過濾唔到。呢度喺讀取嗰陣把所有無效值歸一化為
 * `"failed"`，確保徽章、過濾器、Toast 都睇同一個真相。
 *
 * @see `print-center.tsx` 嘅徽章邏輯、pos-app.tsx 嘅 failedPrintJobs 過濾。
 */
export function normalizePrintJobStatus(job: PrintJob): PrintJob {
  if (job.status === "pending" || job.status === "sent" || job.status === "failed" || job.status === "printed") {
    return job;
  }
  return {
    ...job,
    status: "failed" as const,
    lastError: job.lastError ?? "狀態欄位異常，已自動標記為失敗（請通知技術人員）",
  };
}

export function appendPrintJobs(jobs: PrintJob[]) {
  if (jobs.length === 0 || typeof window === "undefined") return;
  const existing = loadPrintJobs();
  const cleared = loadClearedPrintJobIds();
  const merged = mergePrintJobs(existing, [...jobs, ...existing], cleared);
  savePrintJobs(merged);
  window.dispatchEvent(new CustomEvent("pos-print-jobs-changed", { detail: { count: jobs.length } }));
}

/**
 * 同 `appendPrintJobs`，但**同步會將 PRINT_JOB_CREATED 事件推入 sync queue**（上雲）。
 *
 * ⚠️ 呢一步唔係可選嘅：店內實際出紙通道係「雲端 `pos_print_jobs` → print-relay APK
 * claim 出紙」，而雲端嗰行只有 PRINT_JOB_CREATED 事件經 `/api/pos/sync` 先會寫。
 * `RelayTransport.send()` 本身係 no-op（只 flush sync queue，見 relay-transport.ts
 * 頂部註釋「PRINT_JOB_CREATED 事件喺建單嗰陣已經入咗 sync queue」）—— 所以任何
 * **淨行 `appendPrintJobs`** 嘅建單路徑，張 job 會永遠留喺本機 localStorage：本地
 * flush 仲會經 relay 通道樂觀標「sent」，但雲端根本冇呢張單 → APK 永遠收唔到、
 * 一張紙都唔會出（2026-09-09 補打帳單印唔出嘅根因）。
 *
 * 用法對齊 pos-app `enqueuePrintJobs` / shift-page `reprintShiftRecord` /
 * print-center `reprintOrder` 嘅現行模式：saveQueue(enqueueEvents(...)) +
 * withStoreScope + notifyQueueChanged（入隊即觸發 flush，唔使等 30s interval）。
 *
 * 適用：收據補打（線下/線上）、自動結帳收據等要上雲中繼嘅 job。
 * 唔適用：Kiosk 本機小票（`printKioskReceiptForOrder`，docs/87 §3.1 明言唔好上雲）。
 */
function appendPrintJobsWithSync(jobs: PrintJob[]) {
  if (jobs.length === 0 || typeof window === "undefined") return;
  appendPrintJobs(jobs);
  const timestamp = new Date().toISOString();
  const events = jobs.map<QueueEvent>((job) => ({
    id: uid("evt"),
    type: "PRINT_JOB_CREATED",
    entityId: job.id,
    payload: job,
    status: "pending",
    createdAt: timestamp,
  }));
  saveQueue(enqueueEvents(loadQueue(), withStoreScope(events)));
  notifyQueueChanged();
}

// ── 收據：每台 receipt 打印機一張，附商家收據模板快照 + 靜態內容 ──
/**
 * 收據 / 自助點餐機小票共用嘅底層 builder，只差用邊一個模板槽位。
 *
 * ⚠️ `buildSnapshot()` 嘅 kind 一律係 `"receipt"`，即使傳入嘅係 kiosk 模板（docs/87 §2.3）。
 * 三個下游 repo（POS / desktop-companion / print-agent-android）嘅標題表只認
 * `receipt | label | kitchen`，傳 `"kiosk"` 會 fallthrough 到空標題。
 * 用 `"receipt"` 就做到「獨立可改嘅模板內容 + 完全一致嘅出紙格式」（規格 8）。
 */
function buildTemplateReceiptJobs(
  order: PosOrder,
  bootstrap: PosBootstrap,
  template: ReceiptTemplate,
): PrintJob[] {
  const receiptPrinters = (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter(
    (printer) => printer.enabled && printer.role === "receipt",
  );
  if (receiptPrinters.length === 0) return [];

  const timestamp = new Date().toISOString();
  const serverName = loadAuthSession()?.name;
  // 共用 `toPrintItemLines()`：預覽（print-center）同出紙（呢度）行同一份映射，
  // 唔會再出現「設計見到、印出嚟唔同」。主行價：冇折扣 → 基價 × quantity；
  // 有折扣 → 折後價 × quantity（renderer 再加印原價 / 折讓）。
  const items = toPrintItemLines(order.items);
  const content = buildReceiptContent(order, {
    storeName: bootstrap.storeName,
    // 收據電話：門店設定 → 商家登入號碼 fallback。見 src/lib/pos/store-tel.ts。
    storeTel: resolveStoreTel(bootstrap.storeTel),
    currency: bootstrap.currency,
    footerText: template.footerText,
    serverName,
  });
  // 二維碼：喺 POS 端 encode 一次，三個 repo 共用同一個點陣（設計 == 預覽 == 出紙）。
  // 網址空白 / 太長編唔到 → 回傳 null → 唔帶 qr 欄位 → renderer 同預覽都自動略過。
  const qr = encodeQrPayload(template.qrUrl);

  return receiptPrinters.map<PrintJob>((printer) => ({
    // ⚠️ snapshot 一定要喺 loop 入面砌：`cols`（每行字數）係跟**呢一部機**嘅紙闊，
    // 以前係 loop 外面砌一次，搞到收據機 80mm / 廚房機 58mm 共用同一個欄寬。
    template: buildSnapshot("receipt", template, paperColumnsFromSize(printer.paperSize)),
    id: uid("print"),
    orderId: order.id,
    orderNo: order.localOrderNo,
    tableName: order.tableName,
    ticketType: "normal",
    printerGroup: "receipt",
    printerId: printer.id,
    printerName: printer.name,
    items,
    content,
    qrUrl: template.qrUrl?.trim() ? template.qrUrl.trim() : undefined,
    qr: qr ?? undefined,
    status: "pending",
    createdAt: timestamp,
  }));
}

/** 收銀台結帳收據：用 `printTemplates.receipt` 槽位。 */
export function buildReceiptPrintJobs(order: PosOrder, bootstrap: PosBootstrap): PrintJob[] {
  return buildTemplateReceiptJobs(order, bootstrap, loadPosLocalSettings().printTemplates.receipt);
}

/**
 * 自助點餐機 / 客人掃碼落單印畀客人嘅小票（docs/87 §2、規格 3+8）。
 *
 * 同收銀收據唯一差別：① 用 `printTemplates.kiosk` 呢個**獨立槽位**（商家可另行設計，
 * 唔會影響收銀台收據）；② **固定印 1 張**（規格 8：打印數量唔開放設定）。
 *
 * 打印機沿用 `role === "receipt"`：kiosk mode 係同一部機嘅裝置模式，
 * 「kiosk 隔籬嗰部打印機」就係呢部機自己 deviceConfig 入面嘅收據機，
 * 唔使新增 PrinterRole，亦唔使改 APK / Companion（規格 1、2）。
 */
export function buildKioskReceiptPrintJobs(order: PosOrder, bootstrap: PosBootstrap): PrintJob[] {
  const jobs = buildTemplateReceiptJobs(order, bootstrap, loadPosLocalSettings().printTemplates.kiosk);
  // 規格 8：job 層級寫死 1 份，優先於打印機層級嘅 `DevicePrinterConfig.copies`
  return jobs.map((job) => ({ ...job, copies: 1 }));
}

export interface KitchenPrintOpts {
  ticketType: "normal" | "addon" | "void";
  storeName: string;
  time?: string;
  itemNamePrefix?: string;
  itemNoteOverride?: string;
  itemsOverride?: PosOrder["items"];
  orderNoSuffix?: string;
}

// ── 廚房 / 分區單：每台 zone 打印機一張（只印該分區嘅菜品），附廚房模板快照 ──
export function buildKitchenPrintJobs(order: PosOrder, opts: KitchenPrintOpts): PrintJob[] {
  const kitchenTemplate = loadPosLocalSettings().printTemplates.kitchen;
  const zonePrinters = (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter(
    (printer) => printer.enabled && printer.role === "zone",
  );
  if (zonePrinters.length === 0) return [];
  const timestamp = new Date().toISOString();
  const typeLabel = ticketTypeLabel(opts.ticketType);
  const time = opts.time ?? nowText();
  const sourceItems = opts.itemsOverride ?? order.items;

  const jobs: PrintJob[] = [];
  for (const printer of zonePrinters) {
    const matched = sourceItems.filter((it) => !printer.zoneId || it.printerGroup === printer.zoneId);
    if (matched.length === 0) continue;
    const items: PrintItemLine[] = matched.map((it) => ({
      name: opts.itemNamePrefix ? `${opts.itemNamePrefix}${it.name}` : it.name,
      quantity: it.quantity,
      specs: (it.selectedSpecs ?? []).map((spec) => `${spec.groupName}:${spec.optionLabel}`),
      note: opts.itemNoteOverride ?? it.note,
    }));
    const content = buildKitchenContent(order, {
      storeName: opts.storeName,
      footerText: kitchenTemplate.footerText,
      typeLabel,
      time,
      // ⚠️ 全單備註一定要帶：唔傳 → content.order_note 空字串 → renderEscPosLines
      // `if (!text) continue` 直接跳過 → 廚房單永久冇全單備註（收據有、廚房冇嘅 bug）。
      // 見 docs：buildKitchenContent 嘅 orderNote 係 optional，漏傳唔會 compile error。
      orderNote: order.orderNote,
    });
    const orderNo = `${order.localOrderNo}${opts.orderNoSuffix ?? ""}`;
    content.order_no = orderNo;
    jobs.push({
      id: uid("print"),
      orderId: order.id,
      orderNo,
      tableName: order.tableName,
      ticketType: opts.ticketType,
      printerGroup: printer.zoneId ?? "",
      printerId: printer.id,
      printerName: printer.name,
      items,
      content,
      // 逐機計欄寬（58mm 機 32 字、80mm 機 48 字），三個 repo 直接讀快照，唔使各自判斷。
      template: buildSnapshot("kitchen", kitchenTemplate, paperColumnsFromSize(printer.paperSize)),
      status: "pending",
      createdAt: timestamp,
    });
  }
  return jobs;
}

export interface LabelPrintOpts {
  ticketType: "normal" | "addon" | "void";
  storeName: string;
  itemNamePrefix?: string;
  itemsOverride?: PosOrder["items"];
  orderNoSuffix?: string;
}

// ── 標籤：每台 label 打印機，每項菜品一張（飲品標籤），附標籤模板快照 ──
// （舊版冇 label builder，label 機一直收到同 zone 一樣嘅廚房式 job；呢度補返正確 label 單）
export function buildLabelPrintJobs(order: PosOrder, opts: LabelPrintOpts): PrintJob[] {
  const labelTemplate = loadPosLocalSettings().printTemplates.label;
  const labelPrinters = (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter(
    (printer) => printer.enabled && printer.role === "label",
  );
  if (labelPrinters.length === 0) return [];
  const timestamp = new Date().toISOString();
  /** 標籤紙尺寸 preset 決定嘅欄寬（例如 60×40 → 34 字）。 */
  const presetColumns = labelPaperPreset(labelTemplate.paperSize).columns;
  const sourceItems = opts.itemsOverride ?? order.items;
  const orderNo = `${order.localOrderNo}${opts.orderNoSuffix ?? ""}`;

  const jobs: PrintJob[] = [];
  for (const printer of labelPrinters) {
    const matched = sourceItems.filter((it) => !printer.zoneId || it.printerGroup === printer.zoneId);
    for (const item of matched) {
      const content = buildLabelContent(order, item, {
        storeName: opts.storeName,
        headerText: labelTemplate.headerText,
        footerText: labelTemplate.footerText,
      });
      content.order_no = orderNo;
      jobs.push({
        id: uid("print"),
        orderId: order.id,
        orderNo,
        tableName: order.tableName,
        ticketType: opts.ticketType,
        printerGroup: printer.zoneId ?? item.printerGroup,
        printerId: printer.id,
        printerName: printer.name,
        items: [],
        content,
        // 實際可印闊度 = min(標籤紙闊度, 打印機機頭闊度)：
        // 80mm 機裝 70mm 標籤 → 得 41 字；58mm 機裝唔落 100mm 卷，min() 會自動截頂。
        template: buildSnapshot(
          "label",
          labelTemplate,
          Math.min(presetColumns, paperColumnsFromSize(printer.paperSize)),
        ),
        status: "pending",
        createdAt: timestamp,
      });
    }
  }
  return jobs;
}

// ── 退菜：廚房單（退）+ 標籤單（退），分區/標籤各自套對應模板 ──
export function buildVoidPrintJobsForOrder(
  order: PosOrder,
  reason: string,
  opts?: { itemsOverride?: PosOrder["items"]; orderNoSuffix?: string },
): PrintJob[] {
  const storeName = loadBootstrapCache()?.storeName ?? "門店";
  const kitchenJobs = buildKitchenPrintJobs(order, {
    ticketType: "void",
    storeName,
    itemNamePrefix: "（退）",
    itemNoteOverride: reason || "線上訂單已取消",
    itemsOverride: opts?.itemsOverride,
    orderNoSuffix: opts?.orderNoSuffix,
  });
  const labelJobs = buildLabelPrintJobs(order, {
    ticketType: "void",
    storeName,
    itemNamePrefix: "（退）",
    itemsOverride: opts?.itemsOverride,
    orderNoSuffix: opts?.orderNoSuffix,
  });
  return [...kitchenJobs, ...labelJobs];
}

/**
 * 返結（反結賬）列印：把已結單退回可編輯狀態時，印一張「返結單」到所有啟用中
 * 分區 / 標籤打印機，記錄原單號、原因、操作人。ticketType 沿用 "void"（修正單）。
 */
export function buildReopenPrintJobs(order: PosOrder, reason: string, operator: string): PrintJob[] {
  const storeName = loadBootstrapCache()?.storeName ?? "門店";
  const voidReason = `原因：${reason || "結帳錯誤"}｜操作人：${operator}`;
  const kitchenJobs = buildKitchenPrintJobs(order, {
    ticketType: "void",
    storeName,
    itemNamePrefix: "【返結】",
    itemNoteOverride: voidReason,
  });
  const labelJobs = buildLabelPrintJobs(order, { ticketType: "void", storeName, itemNamePrefix: "【返結】" });
  return [...kitchenJobs, ...labelJobs];
}

export interface ShiftPrintOpts {
  /** 交班結算資料快照（內容真源，見 `ShiftSettlementSnapshot`）。 */
  data: ShiftSettlementSnapshot;
  /** job 嘅 orderId（即印 = `shift-${now}`；重打 = 記錄 id），用嚟追溯係邊一次交班。 */
  orderId: string;
  /** job 嘅顯示單號（列表 / 打印記錄見到嘅名）。 */
  orderNo: string;
  printerId?: string;
  printerName?: string;
  /** 指定模板（缺省 = 本機 `printTemplates.shift`，即商家設計嘅版本）。 */
  template?: ShiftTemplate;
}

/**
 * 交班結算單打印任務（2026-09-10 由硬編文字改為「模板 + content」）。
 *
 * ## 為何要改
 * 舊做法：`shift-page.tsx` 把整張結算單壓成一串文字，再
 * `items: lines.map(line => ({ name: line, quantity: 1 }))` 塞入 job ——
 * job **冇 `template` 快照、冇 `content`**，於是打印通道（Hub / Companion / APK）
 * 行「冇模板」分支 → `renderKitchenTicket()`：
 * 抬頭變「【廚房單】」、每個「區塊」後面都多一個 `x1`（因為當咗佢係菜品）、
 * 亦完全唔理商家設嘅字型 / 對齊 / 分格線。見 `docs/103` 同交班單根因分析。
 *
 * 新做法：同收據 / 廚房單**完全同構** —— `buildSnapshot("shift", template)` 出模板快照、
 * `buildShiftContent()` 出內容 map、`items` 一律空陣列。三個通道行
 * `renderTemplateTicket()`，出紙 = 設計介面 = 螢幕預覽。
 *
 * ⚠️ `items` 一定要係 `[]`（唔係 `undefined`）：`[]` 令舊版通道都唔會誤入 items 分支，
 * 而 `undefined` 喺部分實作會 fallback 去硬編渲染。
 *
 * ⚠️ 交班單只出一張（唔似廚房單按分區一機一張），所以回傳 0 或 1 個 job；
 * 交班單打印機由 caller 用 `pickShiftPrinter()` 揀（設備設定 → 交班單打印機）。
 */
export function buildShiftPrintJobs(opts: ShiftPrintOpts): PrintJob[] {
  const template = normalizeShiftTemplate(opts.template ?? loadPosLocalSettings().printTemplates.shift);
  // 欄寬跟交班單打印機嘅紙闊（58mm → 32 字 / 80mm → 48 字），同收據 / 廚房同一套計法。
  const shiftPrinter = (loadDeviceConfig() ?? defaultDeviceConfig).printers.find((p) => p.id === opts.printerId);
  const snapshot = buildSnapshot("shift", template, paperColumnsFromSize(shiftPrinter?.paperSize));
  const content = buildShiftContent(opts.data, {
    storeName: opts.data.storeName,
    headerText: template.headerText,
    footerText: template.footerText,
    sectionTitles: template.sectionTitles,
  });
  // 防呆：抬頭空字串 → header 區塊唔會印（renderer 跳過空字串），
  // 但整張單唔會因此壞掉（其餘區塊照印），所以唔當錯誤處理。
  return [
    {
      id: uid("print"),
      orderId: opts.orderId,
      orderNo: opts.orderNo,
      tableName: "",
      ticketType: "normal",
      printerGroup: "receipt",
      printerId: opts.printerId,
      printerName: opts.printerName ?? "收據打印機",
      items: [],
      content,
      template: snapshot,
      status: "pending",
      createdAt: new Date().toISOString(),
    },
  ];
}

export function findPosOrderForLedger(ledgerOrderId: string): PosOrder | null {
  // 線上單唔 mirror 入 POS DB（契約 M3/M8），先查 in-memory bridge registry；
  // 舊 persisted 線上單（legacy）仍會喺 loadOrders() 搵到。
  const bridged = getBridgedPosOrder(ledgerOrderId);
  if (bridged) return bridged;
  const posOrderId = `ledger-${ledgerOrderId}`;
  return loadOrders().find((row) => row.id === posOrderId || row.onlineOrderId === ledgerOrderId) ?? null;
}

export function printReceiptForPosOrder(order: PosOrder): number {
  const bootstrap = loadBootstrapCache();
  if (!bootstrap) return 0;
  const jobs = buildReceiptPrintJobs(order, bootstrap);
  // 一定要帶 PRINT_JOB_CREATED 上雲（見 appendPrintJobsWithSync 註釋）：
  // 補打／自動收據嘅實體出紙係 print-relay APK claim 雲端 pos_print_jobs，
  // 淨寫本機 localStorage APK 永遠收唔到。
  appendPrintJobsWithSync(jobs);
  return jobs.length;
}

/**
 * 補打帳單（收據）：針對已結帳／已付款訂單重新列印帳單。
 *
 * 收據唔係儲存列印時嘅 snapshot，而係每次由訂單資料即時重建 —— `PosOrder`
 * 保留晒 items／折扣／加一／抹零／實收／找贖／付款方式／QR 等欄位，所以呢度
 * 由 localStorage 重讀**權威版**訂單（同「重打單」B2/B3 一致，避免 in-memory
 * order 同 storage 唔同步印錯），再行同結帳一樣嘅 `buildReceiptPrintJobs`，
 * 還原到同原單一致嘅內容。
 *
 * 手動語義：**唔查**收據總開關（`isPrintContentEnabled("receipt")` 係畀自動
 * 結帳路徑用，`printReceiptForLedgerOrder` 先查嗰個；呢度係用家當下明確意圖）。
 *
 * @returns 實際加入隊列嘅張數；0 = 冇收據機 / 冇 bootstrap cache（由 caller 出診斷 toast）。
 */
export function reprintReceiptForOrder(order: PosOrder): number {
  const authoritative = loadOrders().find((row) => row.id === order.id) ?? order;
  return printReceiptForPosOrder(authoritative);
}

/**
 * 0 張收據嘅診斷文案：分開「未配置收據機」同「機喺度但產生唔到 job」兩種成因，
 * 否則用家無從入手（對齊 `describeNoKitchenPrinterError` 嘅做法）。
 */
export function describeNoReceiptPrinterError(): string {
  const hasReceiptPrinter = (loadDeviceConfig() ?? defaultDeviceConfig).printers.some(
    (printer) => printer.enabled && printer.role === "receipt",
  );
  return hasReceiptPrinter
    ? "找不到可用的收據打印機，請檢查設備設置。"
    : "未配置收據打印機，請到設備設置添加。";
}

/**
 * 線上單補打帳單（收據）—— 同線下 `reprintReceiptForOrder` **完全一致**：
 * 行同一個 `buildReceiptPrintJobs`（同一個 `printTemplates.receipt` 模板槽位、
 * 同一批 `role === "receipt"` 打印機、同一套 ESC/POS 內容），只係資料來源由
 * localStorage 換成 Ledger（`resolveLedgerPosOrderForReceipt` 轉成本地 PosOrder）。
 *
 * 手動語義（同線下掣一樣）：**唔查**收據總開關、亦**唔做** once 去重 ——
 * 用家明確撳掣就印，撳幾次印幾次。
 *
 * @returns 實際加入隊列嘅張數；0 = 冇收據機 / 冇 bootstrap cache。
 */
export async function reprintReceiptForLedgerOrder(
  ledgerOrder: LedgerOnlineOrder,
  detail?: LedgerOrderDetail,
): Promise<number> {
  const order = await resolveLedgerPosOrderForReceipt(ledgerOrder, detail);
  return printReceiptForPosOrder(order);
}

/**
 * 自助點餐機小票：本機排隊就得（**唔好推上雲**，docs/87 §3.1）。
 * 任何同步咗上 server 嘅 pending job，收銀端會 merge 落自己 localStorage 再印多一次。
 * 回傳實際加入隊列嘅張數（0 = 冇收據機 / 冇 bootstrap cache）。
 */
export function printKioskReceiptForOrder(order: PosOrder): number {
  const bootstrap = loadBootstrapCache();
  if (!bootstrap) return 0;
  const jobs = buildKioskReceiptPrintJobs(order, bootstrap);
  appendPrintJobs(jobs);
  return jobs.length;
}

export function printVoidForLedgerOrder(ledgerOrderId: string, reason = "線上訂單已取消"): number {
  // 退菜單總開關（2026-09-08）：線上單取消同樣跟 void toggle。手動重打唔會經呢度。
  if (!isPrintContentEnabled("void")) return 0;
  const order = findPosOrderForLedger(ledgerOrderId);
  if (!order || order.items.length === 0) return 0;
  const jobs = buildVoidPrintJobsForOrder(order, reason);
  appendPrintJobs(jobs);
  return jobs.length;
}

export async function printReceiptForLedgerOrder(
  ledgerOrderId: string,
  options?: { paymentMethod?: string; networkOnline?: boolean },
): Promise<number> {
  // 結帳收據總開關（2026-09-08）：線上單完成+已付 / 到店付款都跟 receipt toggle。
  if (!isPrintContentEnabled("receipt")) return 0;
  let order = findPosOrderForLedger(ledgerOrderId);
  if (!order) return 0;

  if (options?.paymentMethod) {
    order = { ...order, paymentMethod: options.paymentMethod };
  }

  return printReceiptForPosOrder(order);
}

const recentVoidLedgerIds = new Set<string>();
const recentReceiptLedgerIds = new Set<string>();

function rememberOnce(set: Set<string>, key: string) {
  if (set.has(key)) return false;
  set.add(key);
  if (typeof window !== "undefined") {
    window.setTimeout(() => set.delete(key), 60_000);
  }
  return true;
}

export function printVoidForLedgerOrderOnce(ledgerOrderId: string, reason = "線上訂單已取消"): number {
  if (!rememberOnce(recentVoidLedgerIds, ledgerOrderId)) return 0;
  return printVoidForLedgerOrder(ledgerOrderId, reason);
}

export async function printReceiptForLedgerOrderOnce(
  ledgerOrderId: string,
  options?: { paymentMethod?: string; networkOnline?: boolean },
): Promise<number> {
  if (!rememberOnce(recentReceiptLedgerIds, ledgerOrderId)) return 0;
  return printReceiptForLedgerOrder(ledgerOrderId, options);
}

/**
 * 經 /api/pos/sync 推送 `PRINT_JOB_DELETED` 事件，真刪伺服器 `pos_print_jobs` 行。
 * 離線 / 失敗唔阻礙：本機 tombstone（addClearedPrintJobIds）已經防止 backfill 復活，
 * 伺服器行喺恢復網絡後由下次 sync 清走（見 docs/52）。
 */
export async function deletePrintJobsOnServer(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  // 用 canonical helper：唔好 fallback 去 bootstrap.storeId（可能係 mock 值 macau-store-a）。
  const storeId = resolveStoreId();
  if (!storeId) return;
  const events = ids.map((id) => ({
    id: `pjd-${id}`,
    type: "PRINT_JOB_DELETED" as const,
    entityId: id,
    payload: { id },
    status: "synced" as const,
    createdAt: new Date().toISOString(),
    // 🛡️ 跨店隔離 L1：事件帶自身 store（呢度係即建即推，冇入本地 queue，
    // 直接用請求同一個 storeId stamp 即可）。
    storeId,
  }));
  try {
    await fetch("/api/pos/sync", {
      method: "POST",
      // 2026-09-10 P0-3：PRINT_JOB_DELETED 屬敏感事件，要帶 POS 終端憑證。
      headers: { "Content-Type": "application/json", ...posDeviceAuthHeaders() },
      body: JSON.stringify({ events, storeId }),
    });
  } catch {
    // 離線：tombstone 已擋復活；成功連線後由 flush / sync 再清伺服器行
  }
}

/**
 * 自動清理：移除已發送（sent）超過 olderThanDays 日嘅打印單，避免 localStorage 無限累積。
 * 保留 recent sent（俾用家短時間內喺打印中心見到「已發送」）+ 所有 pending / failed（等跟進）。
 * flush worker 每次 tick 完會 call（見 dispatch.ts）。
 * 真刪：記錄 clearedPrintJobIds tombstone + 推送伺服器 DELETE（見 docs/52）。
 */
export function pruneSentPrintJobs(olderThanDays = 7): number {
  const jobs = loadPrintJobs();
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const kept = jobs.filter((j) => {
    if (j.status !== "sent" && j.status !== "printed") return true;
    const t = j.createdAt ? new Date(j.createdAt).getTime() : 0;
    return Number.isNaN(t) ? true : t > cutoff;
  });
  const removed = jobs.length - kept.length;
  if (removed > 0) {
    const prunedIds = jobs.filter((j) => !kept.includes(j)).map((j) => j.id);
    savePrintJobs(kept);
    addClearedPrintJobIds(prunedIds);
    void deletePrintJobsOnServer(prunedIds);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("pos-print-jobs-changed", { detail: { printJobs: kept } }));
    }
  }
  return removed;
}

/** 手動「清除已發送」：移除所有 sent 單（保留 printed / pending / failed 等用家跟進）。
 * 2026-09-07 兩級狀態：sent 只代表「已交付打印通道、未確認出紙」，printed 係「真實出紙成功」，
 * 兩者語義不同，分開清除（見 clearPrintedPrintJobs）。打印中心「清除已發送」鈕 call。
 * 真刪：記錄 clearedPrintJobIds tombstone + 推送伺服器 DELETE（見 docs/52）。 */
export function clearSentPrintJobs(): number {
  const jobs = loadPrintJobs();
  const kept = jobs.filter((j) => j.status !== "sent");
  const removed = jobs.length - kept.length;
  if (removed > 0) {
    const removedIds = jobs.filter((j) => j.status === "sent").map((j) => j.id);
    savePrintJobs(kept);
    addClearedPrintJobIds(removedIds);
    void deletePrintJobsOnServer(removedIds);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("pos-print-jobs-changed", { detail: { printJobs: kept } }));
    }
  }
  return removed;
}

/** 手動「清除已成功」：移除所有 printed 單（保留 sent / pending / failed）。打印中心「清除已成功」鈕 call。
 * 真刪：記錄 clearedPrintJobIds tombstone + 推送伺服器 DELETE（見 docs/52）。 */
export function clearPrintedPrintJobs(): number {
  const jobs = loadPrintJobs();
  const kept = jobs.filter((j) => j.status !== "printed");
  const removed = jobs.length - kept.length;
  if (removed > 0) {
    const removedIds = jobs.filter((j) => j.status === "printed").map((j) => j.id);
    savePrintJobs(kept);
    addClearedPrintJobIds(removedIds);
    void deletePrintJobsOnServer(removedIds);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("pos-print-jobs-changed", { detail: { printJobs: kept } }));
    }
  }
  return removed;
}

/** 手動「清除已失敗」：移除所有 failed 單（保留 pending / sent）。打印中心按鈕 call。
 * 真刪：記錄 clearedPrintJobIds tombstone + 推送伺服器 DELETE（見 docs/52）。 */
export function clearFailedPrintJobs(): number {
  const jobs = loadPrintJobs();
  const kept = jobs.filter((j) => j.status !== "failed");
  const removed = jobs.length - kept.length;
  if (removed > 0) {
    const removedIds = jobs.filter((j) => j.status === "failed").map((j) => j.id);
    savePrintJobs(kept);
    addClearedPrintJobIds(removedIds);
    void deletePrintJobsOnServer(removedIds);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("pos-print-jobs-changed", { detail: { printJobs: kept } }));
    }
  }
  return removed;
}
