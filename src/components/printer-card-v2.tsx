"use client";

import { DevicePrinterConfig } from "@/lib/types";
import { suggestLabelCommandSet } from "@/lib/print-bridge/printer-models";

interface PrinterCardV2Props {
  printer: DevicePrinterConfig;
  printZones: { id: string; name: string }[];
  testing: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
  onTestPrint: (printer: DevicePrinterConfig) => void;
  onUpdate: (id: string, patch: Partial<DevicePrinterConfig>) => void;
}

function readinessDot(printer: DevicePrinterConfig): { color: string; label: string } {
  if (!printer.enabled) return { color: "bg-slate-300", label: "已停用" };
  if (printer.connectionType === "lan") {
    return printer.ipAddress
      ? { color: "bg-emerald-500", label: "已連線" }
      : { color: "bg-rose-500", label: "未連線" };
  }
  if (printer.connectionType === "usb") {
    return printer.usbVendorId
      ? { color: "bg-emerald-500", label: "已連線" }
      : { color: "bg-rose-500", label: "未連線" };
  }
  return { color: "bg-rose-500", label: "未連線" };
}

function roleLabel(role: DevicePrinterConfig["role"]): string {
  return role === "receipt" ? "小票機" : role === "label" ? "標籤機" : "廚房機";
}

function connLabel(conn: DevicePrinterConfig["connectionType"]): string {
  return conn === "lan" ? "LAN" : conn === "usb" ? "USB" : "藍牙";
}

/**
 * 標籤機紙張尺寸 → 人話。
 *
 * 標籤機同票據機最關鍵嘅分別就係**紙張尺寸**（成卷標籤 vs 連續紙），
 * 所以卡片一定要顯示出嚟，唔可以只顯示「80mm」令商家以為同票據機一樣。
 */
function labelPaperHint(paperSize: string | undefined): string {
  switch (paperSize) {
    case "40x30mm":
      return "40 × 30 mm";
    case "50x30mm":
      return "50 × 30 mm";
    case "60x40mm":
      return "60 × 40 mm";
    case "70x50mm":
      return "70 × 50 mm";
    case "100x75mm":
      return "100 × 75 mm";
    case "62mm":
      return "62 mm（舊預設）";
    default:
      return paperSize ?? "未設定";
  }
}

export function PrinterCardV2({
  printer,
  printZones,
  testing,
  onToggle,
  onRemove,
  onTestPrint,
  onUpdate,
}: PrinterCardV2Props) {
  const dot = readinessDot(printer);
  const isLabel = printer.role === "label";
  const isZone = printer.role === "zone";

  return (
    <article className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 p-4">
      {/* Row 1: status dot + name + actions */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              title={dot.label}
              className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${dot.color}`}
            />
            <div className="truncate text-sm font-semibold text-slate-900">{printer.name}</div>
            {isLabel ? (
              <span className="shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700">
                TSPL
              </span>
            ) : null}
          </div>
          <div className="mt-1 break-words text-xs text-slate-500">
            {roleLabel(printer.role)} · {connLabel(printer.connectionType)} · {printer.model ?? "未知型號"}
            <span className="ml-1 text-slate-400">🔒</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
            <input
              checked={printer.enabled}
              onChange={(e) => onToggle(printer.id, e.target.checked)}
              type="checkbox"
            />
            啟用
          </label>
          <button
            className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-rose-600 shadow-sm ring-1 ring-slate-200 hover:bg-rose-50"
            onClick={() => onRemove(printer.id)}
            type="button"
          >
            刪除
          </button>
        </div>
      </div>

      {/* Row 2: editable fields — IP (LAN) / USB state / 用途相關欄位 */}
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {printer.connectionType === "lan" ? (
          <label className="grid gap-1 text-sm font-semibold text-slate-700">
            <span className="text-xs text-slate-500">IP 地址</span>
            <input
              className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
              onChange={(e) => onUpdate(printer.id, { ipAddress: e.target.value })}
              placeholder="192.168.1.110"
              value={printer.ipAddress ?? ""}
              inputMode="decimal"
            />
          </label>
        ) : null}

        {printer.connectionType === "usb" ? (
          <div className="grid gap-1 text-sm font-semibold text-slate-700">
            <span className="text-xs text-slate-500">USB 連接</span>
            <div className="rounded-2xl border border-slate-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              ✅ 已連接
            </div>
          </div>
        ) : null}

        {/*
          🔴 分區只屬於廚房機（zone）。
          2026-09-13 修正：之前 condition 係 `printer.role !== "receipt"`，
          連標籤機都顯示「標籤分區」下拉 —— 但標籤機（價籤 / 杯貼）
          同廚房分區完全無關。標籤機要顯示嘅係**紙張尺寸**。
          見 docs/144。
        */}
        {isZone ? (
          <label className="grid gap-1 text-sm font-semibold text-slate-700">
            <span className="text-xs text-slate-500">打印分區</span>
            <select
              className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
              onChange={(e) => onUpdate(printer.id, { zoneId: e.target.value })}
              value={printer.zoneId ?? printZones[0]?.id ?? ""}
            >
              {printZones.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {isLabel ? (
          <label className="grid gap-1 text-sm font-semibold text-slate-700">
            <span className="text-xs text-slate-500">標籤紙尺寸</span>
            <select
              className="rounded-2xl border border-violet-200 bg-white px-3 py-2 text-sm"
              onChange={(e) => onUpdate(printer.id, { paperSize: e.target.value })}
              value={printer.paperSize ?? "100x75mm"}
            >
              <option value="40x30mm">40 × 30 mm（細標籤 / 條碼）</option>
              <option value="50x30mm">50 × 30 mm（零售價籤）</option>
              <option value="60x40mm">60 × 40 mm（飲品杯貼）</option>
              <option value="70x50mm">70 × 50 mm（外帶袋 / 備料）</option>
              <option value="100x75mm">100 × 75 mm（物流面單）</option>
              <option value="62mm">62 mm（舊系統預設）</option>
            </select>
          </label>
        ) : null}

        {isLabel ? (
          <div className="grid gap-1 text-sm font-semibold text-slate-700">
            <span className="text-xs text-slate-500">紙張 / 指令集</span>
            <div className="rounded-2xl border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-800">
              {labelPaperHint(printer.paperSize)}
              {" · "}
              {suggestLabelCommandSet(printer.model ?? "").toUpperCase()}
            </div>
          </div>
        ) : null}

        {printer.role === "receipt" ? (
          <div className="grid gap-1 text-sm font-semibold text-slate-700">
            <span className="text-xs text-slate-500">用途</span>
            <div className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
              收銀台收據打印機
            </div>
          </div>
        ) : null}
      </div>

      {/* Row 3: test print */}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
          aria-busy={testing}
          disabled={testing}
          onClick={() => onTestPrint(printer)}
          type="button"
        >
          {testing ? "打印中…" : isLabel ? "測試打印標籤" : "測試打印"}
        </button>
      </div>
    </article>
  );
}

// ── Helper: empty state ──
export function PrinterEmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center">
      <div className="text-sm font-semibold text-slate-600">尚未添加打印機</div>
      <div className="mt-1 text-xs text-slate-400">點擊下方按鈕，一步一步引導添加</div>
      <button
        className="mt-4 rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
        onClick={onAdd}
        type="button"
      >
        + 添加打印機
      </button>
    </div>
  );
}
