"use client";

import { useEffect, useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import {
  loadDeviceConfig,
  loadOfflineMode,
  loadOrders,
  loadPosLocalSettings,
  loadPrintJobs,
  loadQueue,
  savePosLocalSettings,
  savePrintJobs,
  saveQueue,
} from "@/lib/storage";
import { defaultDeviceConfig, defaultPosLocalSettings } from "@/lib/mock-data";
import { PosOrder, PrintJob, QueueEvent } from "@/lib/types";

const RECEIPT_SECTION_META = [
  { id: "store_name", label: "門店名" },
  { id: "order_no", label: "單號" },
  { id: "table_name", label: "類型/桌台" },
  { id: "items", label: "菜品明細" },
  { id: "total", label: "總計" },
  { id: "payment_method", label: "付款方式" },
  { id: "order_note", label: "全單備註" },
  { id: "footer", label: "頁尾文案" },
] as const;

const LABEL_SECTION_META = [
  { id: "header", label: "標題" },
  { id: "item_name", label: "菜品名" },
  { id: "temperature", label: "熱 / 冷" },
  { id: "cup_type", label: "杯型" },
  { id: "sugar", label: "甜度" },
  { id: "ice", label: "冰量" },
  { id: "sugar_tag", label: "甜度標籤" },
  { id: "ice_tag", label: "冰量標籤" },
  { id: "addons", label: "加料" },
  { id: "specs", label: "規格" },
  { id: "item_note", label: "單品備註" },
  { id: "order_no", label: "單號" },
  { id: "footer", label: "頁尾文案" },
] as const;

function reorderSections<T extends string>(list: T[], fromId: T, toId: T) {
  const next = [...list];
  const fromIndex = next.indexOf(fromId);
  const toIndex = next.indexOf(toId);
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return next;
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function getLabelSpecValue(specs: Array<{ groupName: string; optionLabel: string }> | undefined, keywords: string[]) {
  const hit = (specs ?? []).find((spec) => keywords.some((keyword) => spec.groupName.includes(keyword)));
  return hit?.optionLabel ?? "";
}

function getLabelOptionByKeywords(
  specs: Array<{ groupName: string; optionLabel: string }> | undefined,
  optionKeywords: string[],
) {
  const hit = (specs ?? []).find((spec) => optionKeywords.some((keyword) => spec.optionLabel.includes(keyword)));
  return hit?.optionLabel ?? "";
}

function getLabelAddonValues(specs: Array<{ groupName: string; optionLabel: string }> | undefined) {
  return (specs ?? [])
    .filter((spec) => ["加料", "配料", "小料", "附加", "addon"].some((keyword) => spec.groupName.toLowerCase().includes(keyword.toLowerCase())))
    .map((spec) => spec.optionLabel)
    .filter(Boolean);
}

function getLabelTextTag(note: string | undefined, keywords: string[]) {
  const text = note ?? "";
  return keywords.find((keyword) => text.includes(keyword)) ?? "";
}

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function ticketTypeLabel(type: PrintJob["ticketType"]) {
  if (type === "addon") return "加單";
  if (type === "void") return "退菜";
  return "正常";
}

export function PrintCenter() {
  const [printJobs, setPrintJobs] = useState<PrintJob[]>(() => loadPrintJobs());
  const [orders] = useState<PosOrder[]>(() => loadOrders());
  const [offlineMode, setOfflineMode] = useState(() => loadOfflineMode());
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "pending" | "sent" | "failed">("all");
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [templatePreviewType, setTemplatePreviewType] = useState<"receipt" | "label" | null>(null);
  const [localSettings, setLocalSettings] = useState(() => loadPosLocalSettings() ?? defaultPosLocalSettings);
  const [draggingReceiptSection, setDraggingReceiptSection] = useState<string | null>(null);
  const [draggingLabelSection, setDraggingLabelSection] = useState<string | null>(null);
  type PreviewItem = NonNullable<PrintJob["items"]>[number];

  useEffect(() => {
    function onOfflineModeChanged(event: Event) {
      const detail = (event as CustomEvent<{ offlineMode?: boolean }>).detail;
      if (typeof detail?.offlineMode === "boolean") {
        setOfflineMode(detail.offlineMode);
      } else {
        setOfflineMode(loadOfflineMode());
      }
    }
    window.addEventListener("pos-offline-mode-changed", onOfflineModeChanged as EventListener);
    return () => window.removeEventListener("pos-offline-mode-changed", onOfflineModeChanged as EventListener);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    function onPrintJobsChanged() {
      setPrintJobs(loadPrintJobs());
    }
    window.addEventListener("pos-print-jobs-changed", onPrintJobsChanged);
    return () => window.removeEventListener("pos-print-jobs-changed", onPrintJobsChanged);
  }, []);

  const filteredJobs = useMemo(() => {
    const base = printJobs.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (filter === "all") return base;
    return base.filter((job) => job.status === filter);
  }, [printJobs, filter]);

  const activeJob = useMemo(
    () => (activeJobId ? filteredJobs.find((job) => job.id === activeJobId) ?? null : null),
    [activeJobId, filteredJobs],
  );

  const orderMap = useMemo(() => new Map(orders.map((order) => [order.id, order])), [orders]);
  const sampleOrder = useMemo(() => orders[0] ?? null, [orders]);
  const receiptPreviewJob = useMemo<PrintJob | null>(() => {
    const printer = (loadDeviceConfig() ?? defaultDeviceConfig).printers.find((item) => item.enabled && item.role === "receipt");
    if (!printer || !sampleOrder) return null;
    const template = localSettings.printTemplates.receipt;
    const sectionItems: Record<(typeof template.sectionOrder)[number], PreviewItem[]> = {
      store_name: template.showStoreName ? [{ name: "門店", quantity: 1, specs: [], note: "澳門店 A" }] : [],
      order_no: template.showOrderNo ? [{ name: "單號", quantity: 1, specs: [], note: sampleOrder.localOrderNo }] : [],
      table_name: template.showTableName ? [{ name: "類型", quantity: 1, specs: [], note: sampleOrder.tableName }] : [],
      items: sampleOrder.items.map<PreviewItem>((item) => ({
        name: item.name,
        quantity: item.quantity,
        specs: (item.selectedSpecs ?? []).map((spec) => `${spec.groupName}:${spec.optionLabel}`),
        note: item.note,
      })),
      total: [{ name: "總計", quantity: 1, specs: [], note: `MOP ${sampleOrder.total.toFixed(0)}` }],
      payment_method: template.showPaymentMethod ? [{ name: "付款方式", quantity: 1, specs: [], note: sampleOrder.paymentMethod ?? "現金" }] : [],
      order_note: template.showOrderNote && sampleOrder.orderNote ? [{ name: "全單備註", quantity: 1, specs: [], note: sampleOrder.orderNote }] : [],
      footer: template.footerText ? [{ name: "頁尾", quantity: 1, specs: [], note: template.footerText }] : [],
    } as const;
    return {
      id: "preview-receipt",
      orderId: sampleOrder.id,
      orderNo: sampleOrder.localOrderNo,
      tableName: sampleOrder.tableName,
      ticketType: "normal",
      printerGroup: "receipt",
      printerName: `${printer.name}${printer.paperSize ? ` · ${printer.paperSize}` : ""}`,
      status: "sent",
      createdAt: sampleOrder.updatedAt,
      items: template.sectionOrder.flatMap((section) => sectionItems[section]),
    };
  }, [localSettings.printTemplates.receipt, sampleOrder]);
  const labelPreviewJob = useMemo<PrintJob | null>(() => {
    const printer = (loadDeviceConfig() ?? defaultDeviceConfig).printers.find((item) => item.enabled && item.role === "label");
    const sourceItem = sampleOrder?.items[0];
    if (!printer || !sampleOrder || !sourceItem) return null;
    const template = localSettings.printTemplates.label;
    const temperature =
      getLabelSpecValue(sourceItem.selectedSpecs, ["溫度", "熱冷", "冷热", "冷熱"]) ||
      getLabelOptionByKeywords(sourceItem.selectedSpecs, ["熱", "凍", "冷"]) ||
      getLabelTextTag(sourceItem.note, ["熱", "凍", "冷"]);
    const cupType = getLabelSpecValue(sourceItem.selectedSpecs, ["杯", "杯型", "大小", "尺寸"]);
    const sugar = getLabelSpecValue(sourceItem.selectedSpecs, ["甜"]);
    const ice = getLabelSpecValue(sourceItem.selectedSpecs, ["冰"]);
    const sugarTag =
      getLabelOptionByKeywords(sourceItem.selectedSpecs, ["半糖", "少甜", "微糖", "走糖", "無糖"]) ||
      getLabelTextTag(sourceItem.note, ["半糖", "少甜", "微糖", "走糖", "無糖"]);
    const iceTag =
      getLabelOptionByKeywords(sourceItem.selectedSpecs, ["少冰", "微冰", "走冰", "去冰"]) ||
      getLabelTextTag(sourceItem.note, ["少冰", "微冰", "走冰", "去冰"]);
    const addonsFromNote = ["珍珠", "椰果", "奶蓋", "布丁", "仙草", "紅豆"].filter((keyword) =>
      (sourceItem.note ?? "").includes(keyword),
    );
    const addons = Array.from(new Set([...getLabelAddonValues(sourceItem.selectedSpecs), ...addonsFromNote]));
    const sectionItems: Record<(typeof template.sectionOrder)[number], PreviewItem[]> = {
      header: template.headerText ? [{ name: "標題", quantity: 1, specs: [], note: template.headerText }] : [],
      item_name: [{ name: sourceItem.name, quantity: sourceItem.quantity, specs: [], note: undefined }],
      temperature: temperature ? [{ name: "溫度", quantity: 1, specs: [], note: temperature }] : [],
      cup_type: cupType ? [{ name: "杯型", quantity: 1, specs: [], note: cupType }] : [],
      sugar: sugar ? [{ name: "甜度", quantity: 1, specs: [], note: sugar }] : [],
      ice: ice ? [{ name: "冰量", quantity: 1, specs: [], note: ice }] : [],
      sugar_tag: sugarTag ? [{ name: "甜度標籤", quantity: 1, specs: [], note: sugarTag }] : [],
      ice_tag: iceTag ? [{ name: "冰量標籤", quantity: 1, specs: [], note: iceTag }] : [],
      addons: addons.length ? [{ name: "加料", quantity: 1, specs: [], note: addons.join(" / ") }] : [],
      specs:
        template.showSpecs && (sourceItem.selectedSpecs ?? []).length
          ? [{ name: "規格", quantity: 1, specs: [], note: (sourceItem.selectedSpecs ?? []).map((spec) => `${spec.groupName}:${spec.optionLabel}`).join(" / ") }]
          : [],
      item_note: template.showItemNote && sourceItem.note ? [{ name: "備註", quantity: 1, specs: [], note: sourceItem.note }] : [],
      order_no: template.showOrderNo ? [{ name: "單號", quantity: 1, specs: [], note: sampleOrder.localOrderNo }] : [],
      footer: template.footerText ? [{ name: "頁尾", quantity: 1, specs: [], note: template.footerText }] : [],
    } as const;
    return {
      id: "preview-label",
      orderId: sampleOrder.id,
      orderNo: sampleOrder.localOrderNo,
      tableName: sampleOrder.tableName,
      ticketType: "normal",
      printerGroup: printer.zoneId ?? "",
      printerName: `${printer.name}${printer.paperSize ? ` · ${printer.paperSize}` : ""}`,
      status: "sent",
      createdAt: sampleOrder.updatedAt,
      items: template.sectionOrder.flatMap((section) => sectionItems[section]),
    };
  }, [localSettings.printTemplates.label, sampleOrder]);

  function updateLocalTemplate(nextSettings: typeof localSettings) {
    setLocalSettings(nextSettings);
    savePosLocalSettings(nextSettings);
  }

  function persistPrintJobs(next: PrintJob[]) {
    setPrintJobs(next);
    savePrintJobs(next);
    window.dispatchEvent(new CustomEvent("pos-print-jobs-changed"));
  }

  function pushEvents(events: QueueEvent[]) {
    const currentQueue = loadQueue();
    const nextQueue = [...currentQueue, ...events];
    saveQueue(nextQueue);
  }

  function reprintOrder(order: PosOrder) {
    const deviceConfig = loadDeviceConfig() ?? defaultDeviceConfig;
    const enabledPrinters = deviceConfig.printers.filter((printer) => printer.enabled);
    const timestamp = new Date().toISOString();

    const nextPrintJobs = enabledPrinters
      .filter(
        (printer) =>
          (printer.role === "zone" || printer.role === "label") &&
          order.items.some((item) => item.printerGroup === (printer.zoneId ?? "")),
      )
      .map<PrintJob>((printer) => ({
        id: uid("print"),
        orderId: order.id,
        orderNo: `${order.localOrderNo} (重打)`,
        tableName: order.tableName,
        ticketType: "normal",
        printerGroup: printer.zoneId ?? "",
        printerName: printer.name,
        items: [
          ...order.items
            .filter((item) => item.printerGroup === (printer.zoneId ?? ""))
            .map((item) => ({
              name: item.name,
              quantity: item.quantity,
              specs: (item.selectedSpecs ?? []).map((spec) => `${spec.groupName}:${spec.optionLabel}`),
              note: item.note,
            })),
          ...(order.orderNote
            ? [
                {
                  name: "全單備註",
                  quantity: 1,
                  specs: [],
                  note: order.orderNote,
                },
              ]
            : []),
        ],
        status: offlineMode ? "pending" : "sent",
        createdAt: timestamp,
      }));

    if (nextPrintJobs.length === 0) {
      setToast({ tone: "error", message: "沒有可打印的內容。" });
      return;
    }

    persistPrintJobs([...nextPrintJobs, ...printJobs]);
    const events = nextPrintJobs.map<QueueEvent>((job) => ({
      id: uid("evt"),
      type: "PRINT_JOB_CREATED",
      entityId: job.id,
      payload: job,
      status: offlineMode ? "pending" : "synced",
      createdAt: timestamp,
    }));
    pushEvents(events);
    setToast({ tone: "success", message: "已加入重打單打印隊列。" });
  }

  return (
    <div className="h-screen overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="flex h-screen overflow-hidden lg:pl-[72px]">
        <main className="flex h-full flex-1 flex-col overflow-hidden">
          <div className="border-b border-slate-200 bg-white px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">打印</div>
                <div className="mt-1 text-sm text-slate-500">查看打印狀態、預覽與重打。</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {[
                  ["all", "全部"],
                  ["sent", "已發送"],
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
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-auto p-4">
            <div className="mb-4 grid gap-3 lg:grid-cols-2">
              <article className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">收據模板預覽</div>
                    <div className="mt-1 text-xs text-slate-500">檢查客單格式、尺寸與打印內容。</div>
                  </div>
                  <button
                    className="rounded-2xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                    disabled={!receiptPreviewJob}
                    onClick={() => setTemplatePreviewType("receipt")}
                    type="button"
                  >
                    查看模板
                  </button>
                </div>
                <div className="mt-3 text-xs text-slate-500">
                  {receiptPreviewJob ? receiptPreviewJob.printerName : "未設定啟用中的收據打印機"}
                </div>
                <div className="mt-4 grid gap-2">
                  <label className="flex items-center justify-between gap-3 text-sm text-slate-700">
                    <span>顯示門店名</span>
                    <input
                      checked={localSettings.printTemplates.receipt.showStoreName}
                      onChange={(event) => {
                        const next = {
                          ...localSettings,
                          printTemplates: {
                            ...localSettings.printTemplates,
                            receipt: { ...localSettings.printTemplates.receipt, showStoreName: event.target.checked },
                          },
                        };
                        setLocalSettings(next);
                        savePosLocalSettings(next);
                      }}
                      type="checkbox"
                    />
                  </label>
                  <label className="flex items-center justify-between gap-3 text-sm text-slate-700">
                    <span>顯示付款方式</span>
                    <input
                      checked={localSettings.printTemplates.receipt.showPaymentMethod}
                      onChange={(event) => {
                        const next = {
                          ...localSettings,
                          printTemplates: {
                            ...localSettings.printTemplates,
                            receipt: { ...localSettings.printTemplates.receipt, showPaymentMethod: event.target.checked },
                          },
                        };
                        setLocalSettings(next);
                        savePosLocalSettings(next);
                      }}
                      type="checkbox"
                    />
                  </label>
                  <input
                    className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm"
                    onChange={(event) => {
                      const next = {
                        ...localSettings,
                        printTemplates: {
                          ...localSettings.printTemplates,
                          receipt: { ...localSettings.printTemplates.receipt, footerText: event.target.value },
                        },
                      };
                      updateLocalTemplate(next);
                    }}
                    placeholder="收據頁尾文案"
                    value={localSettings.printTemplates.receipt.footerText}
                  />
                  <div className="mt-2 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-3">
                    <div className="text-xs font-semibold text-slate-500">拖拽排序</div>
                    <div className="mt-2 grid gap-2">
                      {localSettings.printTemplates.receipt.sectionOrder.map((section) => (
                        <div
                          key={section}
                          className="cursor-move rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700"
                          draggable
                          onDragOver={(event) => event.preventDefault()}
                          onDragStart={() => setDraggingReceiptSection(section)}
                          onDrop={() => {
                            if (!draggingReceiptSection) return;
                            const next = {
                              ...localSettings,
                              printTemplates: {
                                ...localSettings.printTemplates,
                                receipt: {
                                  ...localSettings.printTemplates.receipt,
                                  sectionOrder: reorderSections(
                                    localSettings.printTemplates.receipt.sectionOrder,
                                    draggingReceiptSection as (typeof localSettings.printTemplates.receipt.sectionOrder)[number],
                                    section,
                                  ),
                                },
                              },
                            };
                            updateLocalTemplate(next);
                            setDraggingReceiptSection(null);
                          }}
                        >
                          {RECEIPT_SECTION_META.find((item) => item.id === section)?.label ?? section}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </article>
              <article className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">標籤模板預覽</div>
                    <div className="mt-1 text-xs text-slate-500">檢查飲品杯貼 / 包裝標籤的核心內容。</div>
                  </div>
                  <button
                    className="rounded-2xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                    disabled={!labelPreviewJob}
                    onClick={() => setTemplatePreviewType("label")}
                    type="button"
                  >
                    查看模板
                  </button>
                </div>
                <div className="mt-3 text-xs text-slate-500">
                  {labelPreviewJob ? labelPreviewJob.printerName : "未設定啟用中的標籤打印機"}
                </div>
                <div className="mt-4 grid gap-2">
                  <label className="flex items-center justify-between gap-3 text-sm text-slate-700">
                    <span>顯示規格</span>
                    <input
                      checked={localSettings.printTemplates.label.showSpecs}
                      onChange={(event) => {
                        const next = {
                          ...localSettings,
                          printTemplates: {
                            ...localSettings.printTemplates,
                            label: { ...localSettings.printTemplates.label, showSpecs: event.target.checked },
                          },
                        };
                        setLocalSettings(next);
                        savePosLocalSettings(next);
                      }}
                      type="checkbox"
                    />
                  </label>
                  <label className="flex items-center justify-between gap-3 text-sm text-slate-700">
                    <span>顯示單號</span>
                    <input
                      checked={localSettings.printTemplates.label.showOrderNo}
                      onChange={(event) => {
                        const next = {
                          ...localSettings,
                          printTemplates: {
                            ...localSettings.printTemplates,
                            label: { ...localSettings.printTemplates.label, showOrderNo: event.target.checked },
                          },
                        };
                        setLocalSettings(next);
                        savePosLocalSettings(next);
                      }}
                      type="checkbox"
                    />
                  </label>
                  <input
                    className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm"
                    onChange={(event) => {
                      const next = {
                        ...localSettings,
                        printTemplates: {
                          ...localSettings.printTemplates,
                          label: { ...localSettings.printTemplates.label, headerText: event.target.value },
                        },
                      };
                      updateLocalTemplate(next);
                    }}
                    placeholder="標籤標題"
                    value={localSettings.printTemplates.label.headerText}
                  />
                  <div className="mt-2 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-3">
                    <div className="text-xs font-semibold text-slate-500">拖拽排序</div>
                    <div className="mt-2 grid gap-2">
                      {localSettings.printTemplates.label.sectionOrder.map((section) => (
                        <div
                          key={section}
                          className="cursor-move rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700"
                          draggable
                          onDragOver={(event) => event.preventDefault()}
                          onDragStart={() => setDraggingLabelSection(section)}
                          onDrop={() => {
                            if (!draggingLabelSection) return;
                            const next = {
                              ...localSettings,
                              printTemplates: {
                                ...localSettings.printTemplates,
                                label: {
                                  ...localSettings.printTemplates.label,
                                  sectionOrder: reorderSections(
                                    localSettings.printTemplates.label.sectionOrder,
                                    draggingLabelSection as (typeof localSettings.printTemplates.label.sectionOrder)[number],
                                    section,
                                  ),
                                },
                              },
                            };
                            updateLocalTemplate(next);
                            setDraggingLabelSection(null);
                          }}
                        >
                          {LABEL_SECTION_META.find((item) => item.id === section)?.label ?? section}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </article>
            </div>

            {filteredJobs.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
                目前沒有打印記錄
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
                          job.status === "sent"
                            ? "bg-emerald-50 text-emerald-700"
                            : job.status === "pending"
                              ? "bg-amber-50 text-amber-700"
                              : "bg-red-50 text-red-700"
                        }`}
                      >
                        {job.status === "sent" ? "已發送" : job.status === "pending" ? "待補傳" : "失敗"}
                      </span>
                    </div>

                    <div className="mt-3 text-xs text-slate-500">{job.createdAt.replace("T", " ").slice(0, 16)}</div>

                    <div className="mt-4 grid grid-cols-2 gap-2">
                      <button
                        className="rounded-2xl bg-white px-3 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                        onClick={() => setActiveJobId(job.id)}
                        type="button"
                      >
                        查看
                      </button>
                      <button
                        className="rounded-2xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
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
                        重打整單
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>

      {activeJob ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/45 p-4">
          <div className="w-full max-w-2xl rounded-3xl bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">打印預覽</div>
                <div className="mt-1 text-sm text-slate-500">
                  {activeJob.orderNo ?? activeJob.orderId} · {activeJob.tableName ?? "--"}
                </div>
              </div>
              <button
                className="rounded-full bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"
                onClick={() => setActiveJobId(null)}
                type="button"
              >
                關閉
              </button>
            </div>

            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-start justify-between gap-3 border-b border-dashed border-slate-200 pb-3">
                <div>
                  <div className="text-sm font-semibold text-slate-900">{activeJob.printerName}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {activeJob.printerGroup} · {ticketTypeLabel(activeJob.ticketType)} ·{" "}
                    {activeJob.status === "sent" ? "已發送" : activeJob.status === "pending" ? "待補傳" : "失敗"}
                  </div>
                </div>
                <div className="text-right text-xs text-slate-500">{activeJob.createdAt.replace("T", " ").slice(0, 16)}</div>
              </div>

              <div className="mt-3 grid gap-3">
                {(activeJob.items ?? []).map((item, index) => (
                  <div key={`${item.name}-${index}`} className="border-b border-dashed border-slate-100 pb-3 last:border-b-0 last:pb-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-sm font-semibold text-slate-900">{item.name}</div>
                      <div className="text-sm font-semibold text-slate-900">x{item.quantity}</div>
                    </div>
                    {item.specs?.length ? <div className="mt-1 text-xs text-slate-500">{item.specs.join(" / ")}</div> : null}
                    {item.note ? <div className="mt-1 text-xs text-slate-500">備註：{item.note}</div> : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {templatePreviewType ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/45 p-4">
          <div className="w-full max-w-xl rounded-3xl bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">
                  {templatePreviewType === "receipt" ? "收據模板預覽" : "標籤模板預覽"}
                </div>
                <div className="mt-1 text-sm text-slate-500">
                  {templatePreviewType === "receipt" ? "這是客人收據的大致出紙內容。" : "這是杯貼 / 包裝標籤的大致打印內容。"}
                </div>
              </div>
              <button
                className="rounded-full bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"
                onClick={() => setTemplatePreviewType(null)}
                type="button"
              >
                關閉
              </button>
            </div>
            <div className="mt-4 rounded-2xl border border-slate-300 bg-slate-50 p-4">
              {(() => {
                const job = templatePreviewType === "receipt" ? receiptPreviewJob : labelPreviewJob;
                if (!job) {
                  return <div className="text-sm text-slate-500">目前沒有可預覽模板。</div>;
                }
                return (
                  <div className={`mx-auto rounded-xl border border-dashed border-slate-300 bg-white p-4 ${templatePreviewType === "receipt" ? "max-w-[280px]" : "max-w-[360px]"}`}>
                    <div className="text-center text-xs font-semibold tracking-[0.18em] text-slate-500">
                      {templatePreviewType === "receipt" ? "RECEIPT PREVIEW" : "LABEL PREVIEW"}
                    </div>
                    <div className="mt-3 text-center text-sm font-semibold text-slate-900">{job.orderNo}</div>
                    <div className="mt-1 text-center text-xs text-slate-500">{job.printerName}</div>
                    <div className="mt-4 grid gap-3">
                      {(job.items ?? []).map((item, index) => (
                        <div key={`${item.name}-${index}`} className="border-b border-dashed border-slate-200 pb-2 last:border-b-0">
                          <div className="flex items-start justify-between gap-3 text-sm">
                            <span className="font-semibold text-slate-900">{item.name}</span>
                            <span className="shrink-0 font-semibold text-slate-900">x{item.quantity}</span>
                          </div>
                          {item.specs?.length ? <div className="mt-1 text-xs text-slate-500">{item.specs.join(" / ")}</div> : null}
                          {item.note ? <div className="mt-1 text-xs text-slate-500">{item.note}</div> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div
          className={`fixed bottom-4 right-4 z-40 rounded-2xl px-4 py-3 text-sm font-semibold text-white shadow-lg ${
            toast.tone === "success" ? "bg-emerald-600" : "bg-red-600"
          }`}
        >
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}
