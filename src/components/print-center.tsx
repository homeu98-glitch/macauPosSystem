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
import { buildKitchenPrintJobs, buildLabelPrintJobs, clearFailedPrintJobs, clearSentPrintJobs } from "@/lib/print-jobs";
import {
  loadBootstrapCache,
  loadDeviceConfig,
  loadOrders,
  loadPosLocalSettings,
  loadPrintJobs,
  loadQueue,
  savePosLocalSettings,
  savePrintJobs,
  saveQueue,
} from "@/lib/storage";
import { useNetworkOnline } from "@/lib/use-network-online";
import { defaultDeviceConfig, defaultPosLocalSettings } from "@/lib/mock-data";
import { DeviceConfig, EscPosAlign, EscPosBlockStyle, EscPosSize, PosOrder, PrintJob, QueueEvent } from "@/lib/types";
import {
  buildKitchenContent,
  buildLabelContent,
  buildReceiptContent,
  buildSnapshot,
  KITCHEN_SECTION_META,
  LABEL_SECTION_META,
  RECEIPT_SECTION_META,
} from "@/lib/escpos-template";
import { EscPosLine, PrintItemLine, renderEscPosLines } from "@/lib/escpos-render";

type TemplateKindState = "receipt" | "label" | "kitchen";

const SECTION_META: Record<TemplateKindState, { id: string; label: string }[]> = {
  receipt: RECEIPT_SECTION_META as unknown as { id: string; label: string }[],
  label: LABEL_SECTION_META as unknown as { id: string; label: string }[],
  kitchen: KITCHEN_SECTION_META as unknown as { id: string; label: string }[],
};

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

export function PrintCenter() {
  const [printJobs, setPrintJobs] = useState<PrintJob[]>(() => loadPrintJobs());
  const [orders] = useState<PosOrder[]>(() => loadOrders());
  const networkOnline = useNetworkOnline();
  const offlineMode = !networkOnline;
  // A1（docs/56）：打印通道健康自檢。三通道皆無 → 所有單據只排佇列唔出紙，出 banner 提示。
  const hasChannel = isNativeBridgeAvailable() || isCompanionConfigured() || isRelayConfigured();
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "pending" | "sent" | "failed">("all");
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [activeTab, setActiveTab] = useState<"records" | "receipt-template" | "label-template" | "kitchen-template">("records");
  const [localSettings, setLocalSettings] = useState(() => loadPosLocalSettings() ?? defaultPosLocalSettings);
  const [deviceConfig, setDeviceConfig] = useState<DeviceConfig>(() => loadDeviceConfig() ?? defaultDeviceConfig);
  const [selectedSection, setSelectedSection] = useState<Record<TemplateKindState, string>>({
    receipt: "store_name",
    label: "header",
    kitchen: "store_name",
  });
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [reprintingOrderId, setReprintingOrderId] = useState<string | null>(null);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const historyRef = useRef<{ past: unknown[]; future: unknown[] }>({ past: [], future: [] });

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

  // 聯合設置模組：設置內新增/啟用/改用途打印機後，即時同步到預覽
  useEffect(() => {
    function onDeviceConfigChanged() {
      setDeviceConfig(loadDeviceConfig() ?? defaultDeviceConfig);
    }
    window.addEventListener("pos-device-config-changed", onDeviceConfigChanged);
    return () => window.removeEventListener("pos-device-config-changed", onDeviceConfigChanged);
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
  };

  function readTemplate(kind: TemplateKindState): AnyTemplate {
    return localSettings.printTemplates[kind] as unknown as AnyTemplate;
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

  function setHeader(kind: TemplateKindState, text: string) {
    const t = readTemplate(kind);
    applyTemplate(kind, { ...t, headerText: text });
  }

  function buildPreviewLines(kind: TemplateKindState): EscPosLine[] {
    const t = readTemplate(kind);
    const snapshot = buildSnapshot(kind, t as unknown as Parameters<typeof buildSnapshot>[1]);
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
      });
      const items: PrintItemLine[] = sampleOrder.items.map((it) => ({
        name: it.name,
        quantity: it.quantity,
        specs: (it.selectedSpecs ?? []).map((s) => `${s.groupName}:${s.optionLabel}`),
        note: it.note,
      }));
      return renderEscPosLines(snapshot, content, items);
    }
    const content = buildReceiptContent(sampleOrder, {
      storeName: PREVIEW_STORE_NAME,
      currency: "MOP",
      footerText: t.footerText,
    });
    const items: PrintItemLine[] = sampleOrder.items.map((it) => ({
      name: it.name,
      quantity: it.quantity,
      specs: (it.selectedSpecs ?? []).map((s) => `${s.groupName}:${s.optionLabel}`),
      note: it.note,
    }));
    return renderEscPosLines(snapshot, content, items);
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
      status: offlineMode ? "pending" : "synced",
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
    const title =
      kind === "receipt" ? "收據模板（ESC/POS）" : kind === "label" ? "飲品標籤模板（ESC/POS）" : "廚房單模板（ESC/POS）";
    return (
      <div className="grid gap-3 lg:grid-cols-[360px_minmax(0,1fr)]">
        <article className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="text-sm font-semibold text-slate-900">{title}</div>
          <div className="mt-1 text-xs text-slate-500">
            真實可打印設定：開關、字型大小、粗體、對齊。設計介面 = 螢幕預覽 = 實際出紙。
          </div>
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
          <div className="mt-3 grid grid-cols-3 gap-2">
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
          </div>
          <div className="mt-4 text-sm font-semibold text-slate-900">即時預覽（真實熱敏樣式）</div>
          <div className="mt-2">
            {kind === "label" && sampleOrder.items.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
                需要最少一個菜品嚟預覽標籤。
              </div>
            ) : (
              <EscPosPreview lines={buildPreviewLines(kind)} paperWidthMm={kind === "label" ? 62 : 80} />
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
                  <button
                    className="ml-auto rounded-full bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-300"
                    onClick={() => clearSentPrintJobs()}
                    type="button"
                  >
                    清除已發送
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
          </div>
        </main>
      </div>

      {activeJob ? (
        <ResponsiveModal description={`${activeJob.orderNo ?? activeJob.orderId} · ${activeJob.tableName ?? "--"}`}>
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">{activeJob.printerName}</div>
                <div className="mt-1 text-xs text-slate-500">
                  {activeJob.printerGroup} · {ticketTypeLabel(activeJob.ticketType)} ·{" "}
                  {activeJob.status === "sent" ? "已發送" : activeJob.status === "pending" ? "待補傳" : "失敗"}
                </div>
              </div>
              <div className="text-right text-xs text-slate-500">{formatMacauDateTime(activeJob.createdAt)}</div>
            </div>
            <div className="mt-3">
              {activeJob.template ? (
                <EscPosPreview
                  lines={renderEscPosLines(activeJob.template, activeJob.content, activeJob.items ?? [])}
                  paperWidthMm={activeJob.template.kind === "label" ? 62 : 80}
                />
              ) : (
                <KitchenTicketPreview job={activeJob} />
              )}
            </div>
          </div>
        </ResponsiveModal>
      ) : null}
    </div>
  );
}
