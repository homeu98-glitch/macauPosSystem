"use client";

import { MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { ResponsiveModal } from "@/components/responsive-modal";
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
  const [activeTab, setActiveTab] = useState<"records" | "receipt-template" | "label-template">("records");
  const [localSettings, setLocalSettings] = useState(() => loadPosLocalSettings() ?? defaultPosLocalSettings);
  const [draggingReceiptSection, setDraggingReceiptSection] = useState<string | null>(null);
  const [draggingLabelSection, setDraggingLabelSection] = useState<string | null>(null);
  const [selectedReceiptSection, setSelectedReceiptSection] = useState<(typeof RECEIPT_SECTION_META)[number]["id"]>("store_name");
  const [selectedLabelSection, setSelectedLabelSection] = useState<(typeof LABEL_SECTION_META)[number]["id"]>("header");
  const [selectedReceiptSections, setSelectedReceiptSections] = useState<Array<(typeof RECEIPT_SECTION_META)[number]["id"]>>(["store_name"]);
  const [selectedLabelSections, setSelectedLabelSections] = useState<Array<(typeof LABEL_SECTION_META)[number]["id"]>>(["header"]);
  const [designerGuide, setDesignerGuide] = useState<{ type: "receipt" | "label"; x: number; y: number } | null>(null);
  const receiptUndoRef = useRef<Array<(typeof localSettings)["printTemplates"]["receipt"]>>([]);
  const receiptRedoRef = useRef<Array<(typeof localSettings)["printTemplates"]["receipt"]>>([]);
  const labelUndoRef = useRef<Array<(typeof localSettings)["printTemplates"]["label"]>>([]);
  const labelRedoRef = useRef<Array<(typeof localSettings)["printTemplates"]["label"]>>([]);
  const [receiptUndoCount, setReceiptUndoCount] = useState(0);
  const [receiptRedoCount, setReceiptRedoCount] = useState(0);
  const [labelUndoCount, setLabelUndoCount] = useState(0);
  const [labelRedoCount, setLabelRedoCount] = useState(0);
  const [reprintingOrderId, setReprintingOrderId] = useState<string | null>(null);
  const designerDragRef = useRef<{
    type: "receipt" | "label";
    section: string;
    mode: "move" | "resize";
    startX: number;
    startY: number;
    startLayout: { x: number; y: number; width: number; height: number };
  } | null>(null);
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

  const receiptPreviewBlocks = useMemo(() => {
    if (!sampleOrder) return {} as Record<(typeof RECEIPT_SECTION_META)[number]["id"], string[]>;
    const template = localSettings.printTemplates.receipt;
    return {
      store_name: template.showStoreName ? ["澳門店 A"] : [],
      order_no: template.showOrderNo ? [sampleOrder.localOrderNo] : [],
      table_name: template.showTableName ? [sampleOrder.tableName] : [],
      items: sampleOrder.items.map((item) => {
        const specs = (item.selectedSpecs ?? []).map((spec) => spec.optionLabel).join(" / ");
        return [item.name, specs, item.note ?? ""].filter(Boolean).join(" · ");
      }),
      total: [`MOP ${sampleOrder.total.toFixed(0)}`],
      payment_method: template.showPaymentMethod ? [sampleOrder.paymentMethod ?? "現金"] : [],
      order_note: template.showOrderNote && sampleOrder.orderNote ? [sampleOrder.orderNote] : [],
      footer: template.footerText ? [template.footerText] : [],
    };
  }, [localSettings.printTemplates.receipt, sampleOrder]);

  const labelPreviewBlocks = useMemo(() => {
    const sourceItem = sampleOrder?.items[0];
    if (!sampleOrder || !sourceItem) return {} as Record<(typeof LABEL_SECTION_META)[number]["id"], string[]>;
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
    return {
      header: localSettings.printTemplates.label.headerText ? [localSettings.printTemplates.label.headerText] : [],
      item_name: [sourceItem.name],
      temperature: temperature ? [temperature] : [],
      cup_type: cupType ? [cupType] : [],
      sugar: sugar ? [sugar] : [],
      ice: ice ? [ice] : [],
      sugar_tag: sugarTag ? [sugarTag] : [],
      ice_tag: iceTag ? [iceTag] : [],
      addons: addons.length ? addons : [],
      specs:
        localSettings.printTemplates.label.showSpecs && (sourceItem.selectedSpecs ?? []).length
          ? [(sourceItem.selectedSpecs ?? []).map((spec) => `${spec.groupName}:${spec.optionLabel}`).join(" / ")]
          : [],
      item_note: localSettings.printTemplates.label.showItemNote && sourceItem.note ? [sourceItem.note] : [],
      order_no: localSettings.printTemplates.label.showOrderNo ? [sampleOrder.localOrderNo] : [],
      footer: localSettings.printTemplates.label.footerText ? [localSettings.printTemplates.label.footerText] : [],
    };
  }, [localSettings.printTemplates.label, sampleOrder]);

  function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  function syncHistoryCounts() {
    setReceiptUndoCount(receiptUndoRef.current.length);
    setReceiptRedoCount(receiptRedoRef.current.length);
    setLabelUndoCount(labelUndoRef.current.length);
    setLabelRedoCount(labelRedoRef.current.length);
  }

  function pushTemplateHistory(nextSettings: typeof localSettings) {
    const receiptChanged = nextSettings.printTemplates.receipt !== localSettings.printTemplates.receipt;
    const labelChanged = nextSettings.printTemplates.label !== localSettings.printTemplates.label;
    if (receiptChanged) {
      receiptUndoRef.current.push(cloneJson(localSettings.printTemplates.receipt));
      if (receiptUndoRef.current.length > 60) receiptUndoRef.current.shift();
      receiptRedoRef.current = [];
    }
    if (labelChanged) {
      labelUndoRef.current.push(cloneJson(localSettings.printTemplates.label));
      if (labelUndoRef.current.length > 60) labelUndoRef.current.shift();
      labelRedoRef.current = [];
    }
    if (receiptChanged || labelChanged) syncHistoryCounts();
  }

  function updateLocalTemplate(nextSettings: typeof localSettings, options?: { recordHistory?: boolean }) {
    if (options?.recordHistory !== false) {
      pushTemplateHistory(nextSettings);
    }
    setLocalSettings(nextSettings);
    savePosLocalSettings(nextSettings);
  }

  function undoTemplate(type: "receipt" | "label") {
    if (type === "receipt") {
      const stack = receiptUndoRef.current;
      if (stack.length === 0) return;
      const prev = stack.pop()!;
      receiptRedoRef.current.push(cloneJson(localSettings.printTemplates.receipt));
      syncHistoryCounts();
      updateLocalTemplate(
        { ...localSettings, printTemplates: { ...localSettings.printTemplates, receipt: prev } },
        { recordHistory: false },
      );
      return;
    }
    const stack = labelUndoRef.current;
    if (stack.length === 0) return;
    const prev = stack.pop()!;
    labelRedoRef.current.push(cloneJson(localSettings.printTemplates.label));
    syncHistoryCounts();
    updateLocalTemplate(
      { ...localSettings, printTemplates: { ...localSettings.printTemplates, label: prev } },
      { recordHistory: false },
    );
  }

  function redoTemplate(type: "receipt" | "label") {
    if (type === "receipt") {
      const stack = receiptRedoRef.current;
      if (stack.length === 0) return;
      const next = stack.pop()!;
      receiptUndoRef.current.push(cloneJson(localSettings.printTemplates.receipt));
      syncHistoryCounts();
      updateLocalTemplate(
        { ...localSettings, printTemplates: { ...localSettings.printTemplates, receipt: next } },
        { recordHistory: false },
      );
      return;
    }
    const stack = labelRedoRef.current;
    if (stack.length === 0) return;
    const next = stack.pop()!;
    labelUndoRef.current.push(cloneJson(localSettings.printTemplates.label));
    syncHistoryCounts();
    updateLocalTemplate(
      { ...localSettings, printTemplates: { ...localSettings.printTemplates, label: next } },
      { recordHistory: false },
    );
  }

  function toggleDesignerSelection<T extends string>(
    current: T[],
    nextId: T,
    append: boolean,
    setter: (value: T[]) => void,
  ) {
    if (!append) {
      setter([nextId]);
      return;
    }
    setter(current.includes(nextId) ? current.filter((item) => item !== nextId) : [...current, nextId]);
  }

  function paperWidthMm(type: "receipt" | "label") {
    const printer = (loadDeviceConfig() ?? defaultDeviceConfig).printers.find((item) => item.enabled && item.role === type);
    const size = printer?.paperSize ?? (type === "receipt" ? "80mm" : "62mm");
    if (size.includes("100x75")) return 100;
    if (size.includes("80")) return 80;
    if (size.includes("62")) return 62;
    return 58;
  }

  function mmStepPx(type: "receipt" | "label") {
    const canvasWidth = type === "receipt" ? localSettings.printTemplates.receipt.canvas.width : localSettings.printTemplates.label.canvas.width;
    return canvasWidth / paperWidthMm(type);
  }

  function alignOrDistribute(type: "receipt" | "label", action: "left" | "center" | "right" | "top" | "middle" | "bottom" | "h-space" | "v-space") {
    if (type === "receipt") {
      const sections = selectedReceiptSections;
      if (sections.length < 2) return;
      const layouts = { ...localSettings.printTemplates.receipt.sectionLayouts };
      const selected = sections.map((id) => ({ id, ...layouts[id] }));
      if (action === "left") {
        const min = Math.min(...selected.map((item) => item.x));
        sections.forEach((id) => (layouts[id] = { ...layouts[id], x: min }));
      } else if (action === "center") {
        const center = selected[0].x + selected[0].width / 2;
        sections.forEach((id) => (layouts[id] = { ...layouts[id], x: Math.round(center - layouts[id].width / 2) }));
      } else if (action === "right") {
        const max = Math.max(...selected.map((item) => item.x + item.width));
        sections.forEach((id) => (layouts[id] = { ...layouts[id], x: Math.round(max - layouts[id].width) }));
      } else if (action === "top") {
        const min = Math.min(...selected.map((item) => item.y));
        sections.forEach((id) => (layouts[id] = { ...layouts[id], y: min }));
      } else if (action === "middle") {
        const middle = selected[0].y + selected[0].height / 2;
        sections.forEach((id) => (layouts[id] = { ...layouts[id], y: Math.round(middle - layouts[id].height / 2) }));
      } else if (action === "bottom") {
        const max = Math.max(...selected.map((item) => item.y + item.height));
        sections.forEach((id) => (layouts[id] = { ...layouts[id], y: Math.round(max - layouts[id].height) }));
      } else if (action === "h-space") {
        const ordered = selected.slice().sort((a, b) => a.x - b.x);
        const min = ordered[0].x;
        const max = ordered[ordered.length - 1].x;
        const gap = ordered.length > 1 ? (max - min) / (ordered.length - 1) : 0;
        ordered.forEach((item, index) => (layouts[item.id as keyof typeof layouts] = { ...layouts[item.id as keyof typeof layouts], x: Math.round(min + gap * index) }));
      } else if (action === "v-space") {
        const ordered = selected.slice().sort((a, b) => a.y - b.y);
        const min = ordered[0].y;
        const max = ordered[ordered.length - 1].y;
        const gap = ordered.length > 1 ? (max - min) / (ordered.length - 1) : 0;
        ordered.forEach((item, index) => (layouts[item.id as keyof typeof layouts] = { ...layouts[item.id as keyof typeof layouts], y: Math.round(min + gap * index) }));
      }
      updateLocalTemplate({
        ...localSettings,
        printTemplates: {
          ...localSettings.printTemplates,
          receipt: { ...localSettings.printTemplates.receipt, sectionLayouts: layouts },
        },
      });
      return;
    }
    const sections = selectedLabelSections;
    if (sections.length < 2) return;
    const layouts = { ...localSettings.printTemplates.label.sectionLayouts };
    const selected = sections.map((id) => ({ id, ...layouts[id] }));
    if (action === "left") {
      const min = Math.min(...selected.map((item) => item.x));
      sections.forEach((id) => (layouts[id] = { ...layouts[id], x: min }));
    } else if (action === "center") {
      const center = selected[0].x + selected[0].width / 2;
      sections.forEach((id) => (layouts[id] = { ...layouts[id], x: Math.round(center - layouts[id].width / 2) }));
    } else if (action === "right") {
      const max = Math.max(...selected.map((item) => item.x + item.width));
      sections.forEach((id) => (layouts[id] = { ...layouts[id], x: Math.round(max - layouts[id].width) }));
    } else if (action === "top") {
      const min = Math.min(...selected.map((item) => item.y));
      sections.forEach((id) => (layouts[id] = { ...layouts[id], y: min }));
    } else if (action === "middle") {
      const middle = selected[0].y + selected[0].height / 2;
      sections.forEach((id) => (layouts[id] = { ...layouts[id], y: Math.round(middle - layouts[id].height / 2) }));
    } else if (action === "bottom") {
      const max = Math.max(...selected.map((item) => item.y + item.height));
      sections.forEach((id) => (layouts[id] = { ...layouts[id], y: Math.round(max - layouts[id].height) }));
    } else if (action === "h-space") {
      const ordered = selected.slice().sort((a, b) => a.x - b.x);
      const min = ordered[0].x;
      const max = ordered[ordered.length - 1].x;
      const gap = ordered.length > 1 ? (max - min) / (ordered.length - 1) : 0;
      ordered.forEach((item, index) => (layouts[item.id as keyof typeof layouts] = { ...layouts[item.id as keyof typeof layouts], x: Math.round(min + gap * index) }));
    } else if (action === "v-space") {
      const ordered = selected.slice().sort((a, b) => a.y - b.y);
      const min = ordered[0].y;
      const max = ordered[ordered.length - 1].y;
      const gap = ordered.length > 1 ? (max - min) / (ordered.length - 1) : 0;
      ordered.forEach((item, index) => (layouts[item.id as keyof typeof layouts] = { ...layouts[item.id as keyof typeof layouts], y: Math.round(min + gap * index) }));
    }
    updateLocalTemplate({
      ...localSettings,
      printTemplates: {
        ...localSettings.printTemplates,
        label: { ...localSettings.printTemplates.label, sectionLayouts: layouts },
      },
    });
  }

  function startDesignerDrag(
    type: "receipt" | "label",
    section: string,
    mode: "move" | "resize",
    event: ReactMouseEvent,
    startLayout: { x: number; y: number; width: number; height: number },
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (type === "receipt") {
      receiptUndoRef.current.push(cloneJson(localSettings.printTemplates.receipt));
      if (receiptUndoRef.current.length > 60) receiptUndoRef.current.shift();
      receiptRedoRef.current = [];
      syncHistoryCounts();
    } else {
      labelUndoRef.current.push(cloneJson(localSettings.printTemplates.label));
      if (labelUndoRef.current.length > 60) labelUndoRef.current.shift();
      labelRedoRef.current = [];
      syncHistoryCounts();
    }
    if (type === "receipt") {
      setSelectedReceiptSection(section as (typeof RECEIPT_SECTION_META)[number]["id"]);
    } else {
      setSelectedLabelSection(section as (typeof LABEL_SECTION_META)[number]["id"]);
    }
    designerDragRef.current = {
      type,
      section,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startLayout,
    };
  }

  useEffect(() => {
    function snapToSiblingEdges(
      layouts: Record<string, { x: number; y: number; width: number; height: number }>,
      activeKey: string,
      proposed: { x: number; y: number; width: number; height: number },
      mode: "move" | "resize",
    ) {
      const threshold = 6;
      const keys = Object.keys(layouts).filter((key) => key !== activeKey);
      if (keys.length === 0) return { layout: proposed, guide: { x: proposed.x, y: proposed.y } };
      const candidatesX: number[] = [];
      const candidatesY: number[] = [];
      keys.forEach((key) => {
        const l = layouts[key];
        candidatesX.push(l.x, l.x + l.width, l.x + l.width / 2);
        candidatesY.push(l.y, l.y + l.height, l.y + l.height / 2);
      });

      let x = proposed.x;
      let y = proposed.y;
      let width = proposed.width;
      let height = proposed.height;

      const trySnapValue = (value: number, candidates: number[]) => {
        let best = value;
        let bestDiff = threshold + 1;
        candidates.forEach((candidate) => {
          const diff = Math.abs(value - candidate);
          if (diff < bestDiff) {
            best = candidate;
            bestDiff = diff;
          }
        });
        return bestDiff <= threshold ? best : value;
      };

      if (mode === "move") {
        const snappedLeft = trySnapValue(x, candidatesX);
        const snappedRight = trySnapValue(x + width, candidatesX);
        const snappedCenter = trySnapValue(x + width / 2, candidatesX);
        if (snappedLeft !== x) {
          x = snappedLeft;
        } else if (snappedRight !== x + width) {
          x = snappedRight - width;
        } else if (snappedCenter !== x + width / 2) {
          x = snappedCenter - width / 2;
        }

        const snappedTop = trySnapValue(y, candidatesY);
        const snappedBottom = trySnapValue(y + height, candidatesY);
        const snappedMiddle = trySnapValue(y + height / 2, candidatesY);
        if (snappedTop !== y) {
          y = snappedTop;
        } else if (snappedBottom !== y + height) {
          y = snappedBottom - height;
        } else if (snappedMiddle !== y + height / 2) {
          y = snappedMiddle - height / 2;
        }
      } else {
        const snappedRight = trySnapValue(x + width, candidatesX);
        if (snappedRight !== x + width) {
          width = Math.max(20, snappedRight - x);
        }
        const snappedBottom = trySnapValue(y + height, candidatesY);
        if (snappedBottom !== y + height) {
          height = Math.max(20, snappedBottom - y);
        }
      }

      return { layout: { ...proposed, x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }, guide: { x: Math.round(x), y: Math.round(y) } };
    }

    function onPointerMove(event: MouseEvent) {
      const drag = designerDragRef.current;
      if (!drag) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (drag.type === "receipt") {
        const current = localSettings.printTemplates.receipt;
        const currentLayout = current.sectionLayouts[drag.section as keyof typeof current.sectionLayouts];
        if (!currentLayout) return;
        const snapGrid = (value: number) => (current.snapToGrid ? Math.round(value / 8) * 8 : value);
        let nextLayout =
          drag.mode === "move"
            ? {
                ...currentLayout,
                x: Math.max(0, snapGrid(drag.startLayout.x + dx)),
                y: Math.max(0, snapGrid(drag.startLayout.y + dy)),
              }
            : {
                ...currentLayout,
                width: Math.max(80, snapGrid(drag.startLayout.width + dx)),
                height: Math.max(28, snapGrid(drag.startLayout.height + dy)),
              };
        if (current.snapToGrid) {
          const snapped = snapToSiblingEdges(current.sectionLayouts, drag.section, nextLayout, drag.mode);
          nextLayout = snapped.layout;
          setDesignerGuide({ type: "receipt", x: snapped.guide.x, y: snapped.guide.y });
        } else {
          setDesignerGuide({ type: "receipt", x: nextLayout.x, y: nextLayout.y });
        }
        const nextSettings = {
          ...localSettings,
          printTemplates: {
            ...localSettings.printTemplates,
            receipt: {
              ...current,
              sectionLayouts: {
                ...current.sectionLayouts,
                [drag.section]: nextLayout,
              },
            },
          },
        };
        setLocalSettings(nextSettings);
        savePosLocalSettings(nextSettings);
      } else {
        const current = localSettings.printTemplates.label;
        const currentLayout = current.sectionLayouts[drag.section as keyof typeof current.sectionLayouts];
        if (!currentLayout) return;
        const snapGrid = (value: number) => (current.snapToGrid ? Math.round(value / 8) * 8 : value);
        let nextLayout =
          drag.mode === "move"
            ? {
                ...currentLayout,
                x: Math.max(0, snapGrid(drag.startLayout.x + dx)),
                y: Math.max(0, snapGrid(drag.startLayout.y + dy)),
              }
            : {
                ...currentLayout,
                width: Math.max(56, snapGrid(drag.startLayout.width + dx)),
                height: Math.max(24, snapGrid(drag.startLayout.height + dy)),
              };
        if (current.snapToGrid) {
          const snapped = snapToSiblingEdges(current.sectionLayouts, drag.section, nextLayout, drag.mode);
          nextLayout = snapped.layout;
          setDesignerGuide({ type: "label", x: snapped.guide.x, y: snapped.guide.y });
        } else {
          setDesignerGuide({ type: "label", x: nextLayout.x, y: nextLayout.y });
        }
        const nextSettings = {
          ...localSettings,
          printTemplates: {
            ...localSettings.printTemplates,
            label: {
              ...current,
              sectionLayouts: {
                ...current.sectionLayouts,
                [drag.section]: nextLayout,
              },
            },
          },
        };
        setLocalSettings(nextSettings);
        savePosLocalSettings(nextSettings);
      }
    }

    function onPointerUp() {
      designerDragRef.current = null;
      setDesignerGuide(null);
    }

    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mouseup", onPointerUp);
    return () => {
      window.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("mouseup", onPointerUp);
    };
  }, [localSettings]);

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
    if (reprintingOrderId) return;
    setReprintingOrderId(order.id);
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
      setReprintingOrderId(null);
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
    setReprintingOrderId(null);
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
                <div className="mt-1 text-sm text-slate-500">查看打印狀態、模板預覽與重打。</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {[
                  ["records", "打印記錄"],
                  ["receipt-template", "收據模板預覽"],
                  ["label-template", "標籤模板預覽"],
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

          <div className="flex-1 overflow-auto p-4">
            {activeTab === "records" ? (
              <>
                <div className="mb-4 flex flex-wrap items-center gap-2">
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
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </>
            ) : null}

            {activeTab === "receipt-template" ? (
              <div className="grid gap-3 lg:grid-cols-[340px_minmax(0,1fr)] xl:grid-cols-[420px_minmax(0,1fr)]">
                <article className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="text-sm font-semibold text-slate-900">收據模板設置</div>
                  <div className="mt-1 text-xs text-slate-500">可拖拽排序，預覽會接近真實收據輸出。</div>
                  <div className="mt-4 grid gap-2">
                    <div className="grid grid-cols-2 gap-2">
                      <label className="flex items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">
                        <span>毫米標尺</span>
                        <input
                          checked={localSettings.printTemplates.receipt.showRuler}
                          onChange={(event) =>
                            updateLocalTemplate({
                              ...localSettings,
                              printTemplates: {
                                ...localSettings.printTemplates,
                                receipt: { ...localSettings.printTemplates.receipt, showRuler: event.target.checked },
                              },
                            })
                          }
                          type="checkbox"
                        />
                      </label>
                      <label className="flex items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">
                        <span>吸附線</span>
                        <input
                          checked={localSettings.printTemplates.receipt.snapToGrid}
                          onChange={(event) =>
                            updateLocalTemplate({
                              ...localSettings,
                              printTemplates: {
                                ...localSettings.printTemplates,
                                receipt: { ...localSettings.printTemplates.receipt, snapToGrid: event.target.checked },
                              },
                            })
                          }
                          type="checkbox"
                        />
                      </label>
                    </div>
                    <label className="flex items-center justify-between gap-3 text-sm text-slate-700">
                      <span>顯示門店名</span>
                      <input
                        checked={localSettings.printTemplates.receipt.showStoreName}
                        onChange={(event) =>
                          updateLocalTemplate({
                            ...localSettings,
                            printTemplates: {
                              ...localSettings.printTemplates,
                              receipt: { ...localSettings.printTemplates.receipt, showStoreName: event.target.checked },
                            },
                          })
                        }
                        type="checkbox"
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3 text-sm text-slate-700">
                      <span>顯示付款方式</span>
                      <input
                        checked={localSettings.printTemplates.receipt.showPaymentMethod}
                        onChange={(event) =>
                          updateLocalTemplate({
                            ...localSettings,
                            printTemplates: {
                              ...localSettings.printTemplates,
                              receipt: { ...localSettings.printTemplates.receipt, showPaymentMethod: event.target.checked },
                            },
                          })
                        }
                        type="checkbox"
                      />
                    </label>
                    <input
                      className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm"
                      onChange={(event) =>
                        updateLocalTemplate({
                          ...localSettings,
                          printTemplates: {
                            ...localSettings.printTemplates,
                            receipt: { ...localSettings.printTemplates.receipt, footerText: event.target.value },
                          },
                        })
                      }
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
                              updateLocalTemplate({
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
                              });
                              setDraggingReceiptSection(null);
                            }}
                          >
                            {RECEIPT_SECTION_META.find((item) => item.id === section)?.label ?? section}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="mt-2 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs font-semibold text-slate-500">
                          區塊樣式：{RECEIPT_SECTION_META.find((item) => item.id === selectedReceiptSection)?.label} {selectedReceiptSections.length > 1 ? `· 已選 ${selectedReceiptSections.length} 個` : ""}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {[
                            ["left", "左齊"],
                            ["center", "中線"],
                            ["right", "右齊"],
                            ["top", "上齊"],
                            ["middle", "中高"],
                            ["bottom", "下齊"],
                            ["h-space", "均分X"],
                            ["v-space", "均分Y"],
                          ].map(([action, label]) => (
                            <button
                              key={action}
                              className="rounded-xl bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200"
                              onClick={() => alignOrDistribute("receipt", action as Parameters<typeof alignOrDistribute>[1])}
                              type="button"
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <label className="grid gap-1 text-xs font-semibold text-slate-600">
                          <span>字體大小</span>
                          <input
                            className="rounded-xl border border-slate-200 bg-white px-2 py-2"
                            min="9"
                            onChange={(event) =>
                              updateLocalTemplate({
                                ...localSettings,
                                printTemplates: {
                                  ...localSettings.printTemplates,
                                  receipt: {
                                    ...localSettings.printTemplates.receipt,
                                    sectionStyles: {
                                      ...localSettings.printTemplates.receipt.sectionStyles,
                                      [selectedReceiptSection]: {
                                        ...localSettings.printTemplates.receipt.sectionStyles[selectedReceiptSection],
                                        fontSize: Number(event.target.value),
                                      },
                                    },
                                  },
                                },
                              })
                            }
                            type="number"
                            value={localSettings.printTemplates.receipt.sectionStyles[selectedReceiptSection].fontSize}
                          />
                        </label>
                        <label className="grid gap-1 text-xs font-semibold text-slate-600">
                          <span>字重</span>
                          <select
                            className="rounded-xl border border-slate-200 bg-white px-2 py-2"
                            onChange={(event) =>
                              updateLocalTemplate({
                                ...localSettings,
                                printTemplates: {
                                  ...localSettings.printTemplates,
                                  receipt: {
                                    ...localSettings.printTemplates.receipt,
                                    sectionStyles: {
                                      ...localSettings.printTemplates.receipt.sectionStyles,
                                      [selectedReceiptSection]: {
                                        ...localSettings.printTemplates.receipt.sectionStyles[selectedReceiptSection],
                                        fontWeight: Number(event.target.value) as 400 | 500 | 600 | 700,
                                      },
                                    },
                                  },
                                },
                              })
                            }
                            value={String(localSettings.printTemplates.receipt.sectionStyles[selectedReceiptSection].fontWeight)}
                          >
                            <option value="400">400</option>
                            <option value="500">500</option>
                            <option value="600">600</option>
                            <option value="700">700</option>
                          </select>
                        </label>
                        <label className="grid gap-1 text-xs font-semibold text-slate-600">
                          <span>對齊</span>
                          <select
                            className="rounded-xl border border-slate-200 bg-white px-2 py-2"
                            onChange={(event) =>
                              updateLocalTemplate({
                                ...localSettings,
                                printTemplates: {
                                  ...localSettings.printTemplates,
                                  receipt: {
                                    ...localSettings.printTemplates.receipt,
                                    sectionStyles: {
                                      ...localSettings.printTemplates.receipt.sectionStyles,
                                      [selectedReceiptSection]: {
                                        ...localSettings.printTemplates.receipt.sectionStyles[selectedReceiptSection],
                                        textAlign: event.target.value as "left" | "center" | "right",
                                      },
                                    },
                                  },
                                },
                              })
                            }
                            value={localSettings.printTemplates.receipt.sectionStyles[selectedReceiptSection].textAlign}
                          >
                            <option value="left">左對齊</option>
                            <option value="center">置中</option>
                            <option value="right">右對齊</option>
                          </select>
                        </label>
                        <label className="grid gap-1 text-xs font-semibold text-slate-600">
                          <span>邊距</span>
                          <input
                            className="rounded-xl border border-slate-200 bg-white px-2 py-2"
                            min="0"
                            onChange={(event) =>
                              updateLocalTemplate({
                                ...localSettings,
                                printTemplates: {
                                  ...localSettings.printTemplates,
                                  receipt: {
                                    ...localSettings.printTemplates.receipt,
                                    sectionStyles: {
                                      ...localSettings.printTemplates.receipt.sectionStyles,
                                      [selectedReceiptSection]: {
                                        ...localSettings.printTemplates.receipt.sectionStyles[selectedReceiptSection],
                                        padding: Number(event.target.value),
                                      },
                                    },
                                  },
                                },
                              })
                            }
                            type="number"
                            value={localSettings.printTemplates.receipt.sectionStyles[selectedReceiptSection].padding}
                          />
                        </label>
                        <label className="grid gap-1 text-xs font-semibold text-slate-600">
                          <span>字體顏色</span>
                          <input
                            className="h-10 rounded-xl border border-slate-200 bg-white px-2 py-1"
                            onChange={(event) =>
                              updateLocalTemplate({
                                ...localSettings,
                                printTemplates: {
                                  ...localSettings.printTemplates,
                                  receipt: {
                                    ...localSettings.printTemplates.receipt,
                                    sectionStyles: {
                                      ...localSettings.printTemplates.receipt.sectionStyles,
                                      [selectedReceiptSection]: {
                                        ...localSettings.printTemplates.receipt.sectionStyles[selectedReceiptSection],
                                        textColor: event.target.value,
                                      },
                                    },
                                  },
                                },
                              })
                            }
                            type="color"
                            value={localSettings.printTemplates.receipt.sectionStyles[selectedReceiptSection].textColor}
                          />
                        </label>
                        <label className="grid gap-1 text-xs font-semibold text-slate-600">
                          <span>邊框顏色</span>
                          <input
                            className="h-10 rounded-xl border border-slate-200 bg-white px-2 py-1"
                            onChange={(event) =>
                              updateLocalTemplate({
                                ...localSettings,
                                printTemplates: {
                                  ...localSettings.printTemplates,
                                  receipt: {
                                    ...localSettings.printTemplates.receipt,
                                    sectionStyles: {
                                      ...localSettings.printTemplates.receipt.sectionStyles,
                                      [selectedReceiptSection]: {
                                        ...localSettings.printTemplates.receipt.sectionStyles[selectedReceiptSection],
                                        borderColor: event.target.value,
                                      },
                                    },
                                  },
                                },
                              })
                            }
                            type="color"
                            value={localSettings.printTemplates.receipt.sectionStyles[selectedReceiptSection].borderColor}
                          />
                        </label>
                        <label className="grid gap-1 text-xs font-semibold text-slate-600">
                          <span>背景色</span>
                          <input
                            className="h-10 rounded-xl border border-slate-200 bg-white px-2 py-1"
                            onChange={(event) =>
                              updateLocalTemplate({
                                ...localSettings,
                                printTemplates: {
                                  ...localSettings.printTemplates,
                                  receipt: {
                                    ...localSettings.printTemplates.receipt,
                                    sectionStyles: {
                                      ...localSettings.printTemplates.receipt.sectionStyles,
                                      [selectedReceiptSection]: {
                                        ...localSettings.printTemplates.receipt.sectionStyles[selectedReceiptSection],
                                        backgroundColor: event.target.value,
                                      },
                                    },
                                  },
                                },
                              })
                            }
                            type="color"
                            value={localSettings.printTemplates.receipt.sectionStyles[selectedReceiptSection].backgroundColor}
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                </article>
                <article className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="text-sm font-semibold text-slate-900">收據預覽</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {receiptPreviewJob ? receiptPreviewJob.printerName : "未設定啟用中的收據打印機"}
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <div className="text-xs text-slate-500">可拖動區塊，右下角可拉伸大小。</div>
                    <div className="flex items-center gap-2">
                      <button
                        className="rounded-xl bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 disabled:opacity-40"
                        disabled={receiptUndoCount === 0}
                        onClick={() => undoTemplate("receipt")}
                        type="button"
                      >
                        撤銷
                      </button>
                      <button
                        className="rounded-xl bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 disabled:opacity-40"
                        disabled={receiptRedoCount === 0}
                        onClick={() => redoTemplate("receipt")}
                        type="button"
                      >
                        重做
                      </button>
                      <span className="text-xs text-slate-500">縮放</span>
                      <input
                        max="1.6"
                        min="0.7"
                        onChange={(event) =>
                          updateLocalTemplate({
                            ...localSettings,
                            printTemplates: {
                              ...localSettings.printTemplates,
                              receipt: {
                                ...localSettings.printTemplates.receipt,
                                canvas: {
                                  ...localSettings.printTemplates.receipt.canvas,
                                  zoom: Number(event.target.value),
                                },
                              },
                            },
                          })
                        }
                        step="0.1"
                        type="range"
                        value={localSettings.printTemplates.receipt.canvas.zoom}
                      />
                    </div>
                  </div>
                  <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    {receiptPreviewJob ? (
                      <div className="overflow-auto">
                        <div
                          className="relative mx-auto rounded-xl border border-dashed border-slate-300 bg-white shadow-sm"
                          style={{
                            width: localSettings.printTemplates.receipt.canvas.width,
                            height: localSettings.printTemplates.receipt.canvas.height,
                            transform: `scale(${localSettings.printTemplates.receipt.canvas.zoom})`,
                            transformOrigin: "top center",
                          }}
                        >
                          {localSettings.printTemplates.receipt.showRuler ? (
                            <>
                              <div className="absolute left-0 top-0 z-20 h-5 w-full border-b border-slate-200 bg-slate-50">
                                {Array.from({ length: Math.ceil(paperWidthMm("receipt") / 5) + 1 }).map((_, index) => (
                                  <div key={`rx-${index}`} className="absolute top-0 h-5 border-l border-slate-300 text-[9px] text-slate-400" style={{ left: index * 5 * mmStepPx("receipt") }}>
                                    <span className="absolute left-1 top-0">{index * 5}mm</span>
                                  </div>
                                ))}
                              </div>
                              <div className="absolute left-0 top-0 z-20 h-full w-5 border-r border-slate-200 bg-slate-50">
                                {Array.from({ length: Math.ceil(localSettings.printTemplates.receipt.canvas.height / (5 * mmStepPx("receipt"))) + 1 }).map((_, index) => (
                                  <div key={`ry-${index}`} className="absolute left-0 w-5 border-t border-slate-300 text-[9px] text-slate-400" style={{ top: index * 5 * mmStepPx("receipt") }}>
                                    <span className="absolute left-0 top-0">{index * 5}</span>
                                  </div>
                                ))}
                              </div>
                            </>
                          ) : null}
                          {designerGuide?.type === "receipt" ? (
                            <>
                              <div className="absolute top-0 z-10 h-full border-l border-dashed border-orange-400" style={{ left: designerGuide.x }} />
                              <div className="absolute left-0 z-10 w-full border-t border-dashed border-orange-400" style={{ top: designerGuide.y }} />
                            </>
                          ) : null}
                          {localSettings.printTemplates.receipt.sectionOrder.map((section) => {
                            const layout = localSettings.printTemplates.receipt.sectionLayouts[section];
                            const lines = receiptPreviewBlocks[section] ?? [];
                            const style = localSettings.printTemplates.receipt.sectionStyles[section];
                            return (
                              <div
                                key={section}
                                className={`absolute cursor-move overflow-hidden rounded-lg ${
                                  selectedReceiptSections.includes(section) ? "border-2 border-orange-500 shadow-md" : "border border-dashed"
                                }`}
                                onClick={(event) => {
                                  setSelectedReceiptSection(section);
                                  toggleDesignerSelection(
                                    selectedReceiptSections,
                                    section,
                                    event.metaKey || event.ctrlKey,
                                    setSelectedReceiptSections,
                                  );
                                }}
                                onMouseDown={(event) => startDesignerDrag("receipt", section, "move", event, layout)}
                                style={{
                                  left: layout.x,
                                  top: layout.y,
                                  width: layout.width,
                                  height: layout.height,
                                  padding: style.padding,
                                  textAlign: style.textAlign,
                                  backgroundColor: style.backgroundColor,
                                  borderColor: style.borderColor,
                                }}
                              >
                                <div className="text-[10px] font-semibold tracking-wide text-orange-700">
                                  {RECEIPT_SECTION_META.find((item) => item.id === section)?.label ?? section}
                                </div>
                                <div
                                  className="mt-1 space-y-1 leading-4"
                                  style={{ fontSize: style.fontSize, fontWeight: style.fontWeight, textAlign: style.textAlign, color: style.textColor }}
                                >
                                  {lines.length > 0 ? lines.slice(0, 6).map((line, index) => <div key={`${section}-${index}`}>{line}</div>) : <div className="text-slate-400">未顯示</div>}
                                </div>
                                <button
                                  className="absolute bottom-1 right-1 h-3 w-3 rounded-sm bg-orange-500"
                                  onMouseDown={(event) => startDesignerDrag("receipt", section, "resize", event, layout)}
                                  type="button"
                                />
                              </div>
                            );
                          })}
                        </div>
                        <div className="mt-4 rounded-xl border border-dashed border-slate-200 bg-white p-3">
                          <div className="text-xs font-semibold text-slate-500">順序輸出預覽</div>
                          <div className="mt-2 grid gap-2">
                            {receiptPreviewJob.items?.map((item, index) => (
                              <div key={`${item.name}-${index}`} className="border-b border-dashed border-slate-100 pb-2 last:border-b-0">
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
                      </div>
                    ) : (
                      <div className="text-sm text-slate-500">未設定啟用中的收據打印機。</div>
                    )}
                  </div>
                </article>
              </div>
            ) : null}

            {activeTab === "label-template" ? (
              <div className="grid gap-3 lg:grid-cols-[340px_minmax(0,1fr)] xl:grid-cols-[420px_minmax(0,1fr)]">
                <article className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="text-sm font-semibold text-slate-900">標籤模板設置</div>
                  <div className="mt-1 text-xs text-slate-500">可拖拽排序，並預覽更接近真實標籤輸出。</div>
                  <div className="mt-4 grid gap-2">
                    <div className="grid grid-cols-2 gap-2">
                      <label className="flex items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">
                        <span>毫米標尺</span>
                        <input
                          checked={localSettings.printTemplates.label.showRuler}
                          onChange={(event) =>
                            updateLocalTemplate({
                              ...localSettings,
                              printTemplates: {
                                ...localSettings.printTemplates,
                                label: { ...localSettings.printTemplates.label, showRuler: event.target.checked },
                              },
                            })
                          }
                          type="checkbox"
                        />
                      </label>
                      <label className="flex items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">
                        <span>吸附線</span>
                        <input
                          checked={localSettings.printTemplates.label.snapToGrid}
                          onChange={(event) =>
                            updateLocalTemplate({
                              ...localSettings,
                              printTemplates: {
                                ...localSettings.printTemplates,
                                label: { ...localSettings.printTemplates.label, snapToGrid: event.target.checked },
                              },
                            })
                          }
                          type="checkbox"
                        />
                      </label>
                    </div>
                    <label className="flex items-center justify-between gap-3 text-sm text-slate-700">
                      <span>顯示規格</span>
                      <input
                        checked={localSettings.printTemplates.label.showSpecs}
                        onChange={(event) =>
                          updateLocalTemplate({
                            ...localSettings,
                            printTemplates: {
                              ...localSettings.printTemplates,
                              label: { ...localSettings.printTemplates.label, showSpecs: event.target.checked },
                            },
                          })
                        }
                        type="checkbox"
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3 text-sm text-slate-700">
                      <span>顯示單號</span>
                      <input
                        checked={localSettings.printTemplates.label.showOrderNo}
                        onChange={(event) =>
                          updateLocalTemplate({
                            ...localSettings,
                            printTemplates: {
                              ...localSettings.printTemplates,
                              label: { ...localSettings.printTemplates.label, showOrderNo: event.target.checked },
                            },
                          })
                        }
                        type="checkbox"
                      />
                    </label>
                    <input
                      className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm"
                      onChange={(event) =>
                        updateLocalTemplate({
                          ...localSettings,
                          printTemplates: {
                            ...localSettings.printTemplates,
                            label: { ...localSettings.printTemplates.label, headerText: event.target.value },
                          },
                        })
                      }
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
                              updateLocalTemplate({
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
                              });
                              setDraggingLabelSection(null);
                            }}
                          >
                            {LABEL_SECTION_META.find((item) => item.id === section)?.label ?? section}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="mt-2 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs font-semibold text-slate-500">
                          區塊樣式：{LABEL_SECTION_META.find((item) => item.id === selectedLabelSection)?.label} {selectedLabelSections.length > 1 ? `· 已選 ${selectedLabelSections.length} 個` : ""}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {[
                            ["left", "左齊"],
                            ["center", "中線"],
                            ["right", "右齊"],
                            ["top", "上齊"],
                            ["middle", "中高"],
                            ["bottom", "下齊"],
                            ["h-space", "均分X"],
                            ["v-space", "均分Y"],
                          ].map(([action, label]) => (
                            <button
                              key={action}
                              className="rounded-xl bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200"
                              onClick={() => alignOrDistribute("label", action as Parameters<typeof alignOrDistribute>[1])}
                              type="button"
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <label className="grid gap-1 text-xs font-semibold text-slate-600">
                          <span>字體大小</span>
                          <input
                            className="rounded-xl border border-slate-200 bg-white px-2 py-2"
                            min="9"
                            onChange={(event) =>
                              updateLocalTemplate({
                                ...localSettings,
                                printTemplates: {
                                  ...localSettings.printTemplates,
                                  label: {
                                    ...localSettings.printTemplates.label,
                                    sectionStyles: {
                                      ...localSettings.printTemplates.label.sectionStyles,
                                      [selectedLabelSection]: {
                                        ...localSettings.printTemplates.label.sectionStyles[selectedLabelSection],
                                        fontSize: Number(event.target.value),
                                      },
                                    },
                                  },
                                },
                              })
                            }
                            type="number"
                            value={localSettings.printTemplates.label.sectionStyles[selectedLabelSection].fontSize}
                          />
                        </label>
                        <label className="grid gap-1 text-xs font-semibold text-slate-600">
                          <span>字重</span>
                          <select
                            className="rounded-xl border border-slate-200 bg-white px-2 py-2"
                            onChange={(event) =>
                              updateLocalTemplate({
                                ...localSettings,
                                printTemplates: {
                                  ...localSettings.printTemplates,
                                  label: {
                                    ...localSettings.printTemplates.label,
                                    sectionStyles: {
                                      ...localSettings.printTemplates.label.sectionStyles,
                                      [selectedLabelSection]: {
                                        ...localSettings.printTemplates.label.sectionStyles[selectedLabelSection],
                                        fontWeight: Number(event.target.value) as 400 | 500 | 600 | 700,
                                      },
                                    },
                                  },
                                },
                              })
                            }
                            value={String(localSettings.printTemplates.label.sectionStyles[selectedLabelSection].fontWeight)}
                          >
                            <option value="400">400</option>
                            <option value="500">500</option>
                            <option value="600">600</option>
                            <option value="700">700</option>
                          </select>
                        </label>
                        <label className="grid gap-1 text-xs font-semibold text-slate-600">
                          <span>對齊</span>
                          <select
                            className="rounded-xl border border-slate-200 bg-white px-2 py-2"
                            onChange={(event) =>
                              updateLocalTemplate({
                                ...localSettings,
                                printTemplates: {
                                  ...localSettings.printTemplates,
                                  label: {
                                    ...localSettings.printTemplates.label,
                                    sectionStyles: {
                                      ...localSettings.printTemplates.label.sectionStyles,
                                      [selectedLabelSection]: {
                                        ...localSettings.printTemplates.label.sectionStyles[selectedLabelSection],
                                        textAlign: event.target.value as "left" | "center" | "right",
                                      },
                                    },
                                  },
                                },
                              })
                            }
                            value={localSettings.printTemplates.label.sectionStyles[selectedLabelSection].textAlign}
                          >
                            <option value="left">左對齊</option>
                            <option value="center">置中</option>
                            <option value="right">右對齊</option>
                          </select>
                        </label>
                        <label className="grid gap-1 text-xs font-semibold text-slate-600">
                          <span>邊距</span>
                          <input
                            className="rounded-xl border border-slate-200 bg-white px-2 py-2"
                            min="0"
                            onChange={(event) =>
                              updateLocalTemplate({
                                ...localSettings,
                                printTemplates: {
                                  ...localSettings.printTemplates,
                                  label: {
                                    ...localSettings.printTemplates.label,
                                    sectionStyles: {
                                      ...localSettings.printTemplates.label.sectionStyles,
                                      [selectedLabelSection]: {
                                        ...localSettings.printTemplates.label.sectionStyles[selectedLabelSection],
                                        padding: Number(event.target.value),
                                      },
                                    },
                                  },
                                },
                              })
                            }
                            type="number"
                            value={localSettings.printTemplates.label.sectionStyles[selectedLabelSection].padding}
                          />
                        </label>
                        <label className="grid gap-1 text-xs font-semibold text-slate-600">
                          <span>字體顏色</span>
                          <input
                            className="h-10 rounded-xl border border-slate-200 bg-white px-2 py-1"
                            onChange={(event) =>
                              updateLocalTemplate({
                                ...localSettings,
                                printTemplates: {
                                  ...localSettings.printTemplates,
                                  label: {
                                    ...localSettings.printTemplates.label,
                                    sectionStyles: {
                                      ...localSettings.printTemplates.label.sectionStyles,
                                      [selectedLabelSection]: {
                                        ...localSettings.printTemplates.label.sectionStyles[selectedLabelSection],
                                        textColor: event.target.value,
                                      },
                                    },
                                  },
                                },
                              })
                            }
                            type="color"
                            value={localSettings.printTemplates.label.sectionStyles[selectedLabelSection].textColor}
                          />
                        </label>
                        <label className="grid gap-1 text-xs font-semibold text-slate-600">
                          <span>邊框顏色</span>
                          <input
                            className="h-10 rounded-xl border border-slate-200 bg-white px-2 py-1"
                            onChange={(event) =>
                              updateLocalTemplate({
                                ...localSettings,
                                printTemplates: {
                                  ...localSettings.printTemplates,
                                  label: {
                                    ...localSettings.printTemplates.label,
                                    sectionStyles: {
                                      ...localSettings.printTemplates.label.sectionStyles,
                                      [selectedLabelSection]: {
                                        ...localSettings.printTemplates.label.sectionStyles[selectedLabelSection],
                                        borderColor: event.target.value,
                                      },
                                    },
                                  },
                                },
                              })
                            }
                            type="color"
                            value={localSettings.printTemplates.label.sectionStyles[selectedLabelSection].borderColor}
                          />
                        </label>
                        <label className="grid gap-1 text-xs font-semibold text-slate-600">
                          <span>背景色</span>
                          <input
                            className="h-10 rounded-xl border border-slate-200 bg-white px-2 py-1"
                            onChange={(event) =>
                              updateLocalTemplate({
                                ...localSettings,
                                printTemplates: {
                                  ...localSettings.printTemplates,
                                  label: {
                                    ...localSettings.printTemplates.label,
                                    sectionStyles: {
                                      ...localSettings.printTemplates.label.sectionStyles,
                                      [selectedLabelSection]: {
                                        ...localSettings.printTemplates.label.sectionStyles[selectedLabelSection],
                                        backgroundColor: event.target.value,
                                      },
                                    },
                                  },
                                },
                              })
                            }
                            type="color"
                            value={localSettings.printTemplates.label.sectionStyles[selectedLabelSection].backgroundColor}
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                </article>
                <article className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="text-sm font-semibold text-slate-900">標籤預覽</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {labelPreviewJob ? labelPreviewJob.printerName : "未設定啟用中的標籤打印機"}
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <div className="text-xs text-slate-500">可拖動區塊，右下角可拉伸大小。</div>
                    <div className="flex items-center gap-2">
                      <button
                        className="rounded-xl bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 disabled:opacity-40"
                        disabled={labelUndoCount === 0}
                        onClick={() => undoTemplate("label")}
                        type="button"
                      >
                        撤銷
                      </button>
                      <button
                        className="rounded-xl bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 disabled:opacity-40"
                        disabled={labelRedoCount === 0}
                        onClick={() => redoTemplate("label")}
                        type="button"
                      >
                        重做
                      </button>
                      <span className="text-xs text-slate-500">縮放</span>
                      <input
                        max="1.6"
                        min="0.7"
                        onChange={(event) =>
                          updateLocalTemplate({
                            ...localSettings,
                            printTemplates: {
                              ...localSettings.printTemplates,
                              label: {
                                ...localSettings.printTemplates.label,
                                canvas: {
                                  ...localSettings.printTemplates.label.canvas,
                                  zoom: Number(event.target.value),
                                },
                              },
                            },
                          })
                        }
                        step="0.1"
                        type="range"
                        value={localSettings.printTemplates.label.canvas.zoom}
                      />
                    </div>
                  </div>
                  <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    {labelPreviewJob ? (
                      <div className="overflow-auto">
                        <div
                          className="relative mx-auto rounded-xl border border-dashed border-slate-300 bg-white shadow-sm"
                          style={{
                            width: localSettings.printTemplates.label.canvas.width,
                            height: localSettings.printTemplates.label.canvas.height,
                            transform: `scale(${localSettings.printTemplates.label.canvas.zoom})`,
                            transformOrigin: "top center",
                          }}
                        >
                          {localSettings.printTemplates.label.showRuler ? (
                            <>
                              <div className="absolute left-0 top-0 z-20 h-5 w-full border-b border-slate-200 bg-slate-50">
                                {Array.from({ length: Math.ceil(paperWidthMm("label") / 5) + 1 }).map((_, index) => (
                                  <div key={`lx-${index}`} className="absolute top-0 h-5 border-l border-slate-300 text-[9px] text-slate-400" style={{ left: index * 5 * mmStepPx("label") }}>
                                    <span className="absolute left-1 top-0">{index * 5}mm</span>
                                  </div>
                                ))}
                              </div>
                              <div className="absolute left-0 top-0 z-20 h-full w-5 border-r border-slate-200 bg-slate-50">
                                {Array.from({ length: Math.ceil(localSettings.printTemplates.label.canvas.height / (5 * mmStepPx("label"))) + 1 }).map((_, index) => (
                                  <div key={`ly-${index}`} className="absolute left-0 w-5 border-t border-slate-300 text-[9px] text-slate-400" style={{ top: index * 5 * mmStepPx("label") }}>
                                    <span className="absolute left-0 top-0">{index * 5}</span>
                                  </div>
                                ))}
                              </div>
                            </>
                          ) : null}
                          {designerGuide?.type === "label" ? (
                            <>
                              <div className="absolute top-0 z-10 h-full border-l border-dashed border-sky-400" style={{ left: designerGuide.x }} />
                              <div className="absolute left-0 z-10 w-full border-t border-dashed border-sky-400" style={{ top: designerGuide.y }} />
                            </>
                          ) : null}
                          {localSettings.printTemplates.label.sectionOrder.map((section) => {
                            const layout = localSettings.printTemplates.label.sectionLayouts[section];
                            const lines = labelPreviewBlocks[section] ?? [];
                            const style = localSettings.printTemplates.label.sectionStyles[section];
                            return (
                              <div
                                key={section}
                                className={`absolute cursor-move overflow-hidden rounded-lg ${
                                  selectedLabelSections.includes(section) ? "border-2 border-sky-500 shadow-md" : "border border-dashed"
                                }`}
                                onClick={(event) => {
                                  setSelectedLabelSection(section);
                                  toggleDesignerSelection(
                                    selectedLabelSections,
                                    section,
                                    event.metaKey || event.ctrlKey,
                                    setSelectedLabelSections,
                                  );
                                }}
                                onMouseDown={(event) => startDesignerDrag("label", section, "move", event, layout)}
                                style={{
                                  left: layout.x,
                                  top: layout.y,
                                  width: layout.width,
                                  height: layout.height,
                                  padding: style.padding,
                                  textAlign: style.textAlign,
                                  backgroundColor: style.backgroundColor,
                                  borderColor: style.borderColor,
                                }}
                              >
                                <div className="text-[10px] font-semibold tracking-wide text-sky-700">
                                  {LABEL_SECTION_META.find((item) => item.id === section)?.label ?? section}
                                </div>
                                <div
                                  className="mt-1 space-y-1 leading-4"
                                  style={{ fontSize: style.fontSize, fontWeight: style.fontWeight, textAlign: style.textAlign, color: style.textColor }}
                                >
                                  {lines.length > 0 ? lines.slice(0, 4).map((line, index) => <div key={`${section}-${index}`}>{line}</div>) : <div className="text-slate-400">未顯示</div>}
                                </div>
                                <button
                                  className="absolute bottom-1 right-1 h-3 w-3 rounded-sm bg-sky-500"
                                  onMouseDown={(event) => startDesignerDrag("label", section, "resize", event, layout)}
                                  type="button"
                                />
                              </div>
                            );
                          })}
                        </div>
                        <div className="mt-4 rounded-xl border border-dashed border-slate-200 bg-white p-3">
                          <div className="text-xs font-semibold text-slate-500">順序輸出預覽</div>
                          <div className="mt-2 grid gap-2">
                            {labelPreviewJob.items?.map((item, index) => (
                              <div key={`${item.name}-${index}`} className="border-b border-dashed border-slate-100 pb-2 last:border-b-0">
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
                      </div>
                    ) : (
                      <div className="text-sm text-slate-500">未設定啟用中的標籤打印機，請先到設置啟用一台標籤打印機。</div>
                    )}
                  </div>
                </article>
              </div>
            ) : null}
          </div>
        </main>
      </div>

      {activeJob ? (
        <ResponsiveModal
          description={`${activeJob.orderNo ?? activeJob.orderId} · ${activeJob.tableName ?? "--"}`}
          onClose={() => setActiveJobId(null)}
          title="打印預覽"
          widthClassName="max-w-2xl"
        >
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
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
        </ResponsiveModal>
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
