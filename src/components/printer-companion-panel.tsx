"use client";

import { useEffect, useState } from "react";

import type { DevicePrinterConfig } from "@/lib/types";
import {
  COMPANION_DEFAULT_URL,
  discoverCompanionLanPrinters,
  enumerateCompanionUsbPrinters,
  isCompanionAvailable,
  testCompanionConnection,
  tryAutoPairCompanion,
  type PrinterCandidate,
} from "@/lib/print-bridge/companion";
import { CHARSET_OPTIONS, PAPER_SIZE_OPTIONS } from "@/lib/print-bridge/printer-models";

export interface PrinterRoleOption {
  value: "zone" | "receipt" | "label";
  label: string;
}

export interface PrinterCompanionPanelProps {
  /** 分區清單（設定頁嘅 printZones），加「分區出單」機時揀對應 zone */
  printZones: Array<{ id: string; name: string }>;
  /** 揀好一部機 + 填好設定後，交返畀上層寫入 config */
  onAddPrinter: (p: DevicePrinterConfig) => void;
  /** 可選：限制可選 role（salon 得收據機就用 [{value:"receipt",label:"收據"}]） */
  roles?: PrinterRoleOption[];
}

const DEFAULT_ROLES: PrinterRoleOption[] = [
  { value: "zone", label: "分區出單" },
  { value: "receipt", label: "收據" },
  { value: "label", label: "標籤" },
];

function uid(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`;
}

type StatusState = "checking" | "online" | "offline";

function CompanionStatusCard() {
  const [status, setStatus] = useState<StatusState>("checking");
  const [version, setVersion] = useState("");
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      await tryAutoPairCompanion();
      const ok = await isCompanionAvailable(true);
      if (!active) return;
      setStatus(ok ? "online" : "offline");
    })();
    return () => {
      active = false;
    };
  }, []);

  async function handleTest() {
    setTesting(true);
    const res = await testCompanionConnection();
    setTesting(false);
    if (res.ok) {
      setStatus("online");
      setVersion(res.version ?? "");
    } else {
      setStatus("offline");
    }
  }

  const dot =
    status === "online"
      ? "bg-emerald-500"
      : status === "offline"
        ? "bg-rose-500"
        : "bg-slate-400";
  const label =
    status === "online"
      ? version
        ? `已連線（v${version}）`
        : "已連線"
      : status === "offline"
        ? "未連線（代理未啟動）"
        : "偵測中…";

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={`h-3 w-3 rounded-full ${dot}`} />
          <div>
            <div className="text-sm font-semibold text-slate-800">桌面 Companion 代理</div>
            <div className="text-xs text-slate-500">{label}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={handleTest}
          disabled={testing}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {testing ? "測試中…" : "測試連線"}
        </button>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs text-slate-500">代理地址（固定，無須設定）</span>
          <input
            value={COMPANION_DEFAULT_URL}
            readOnly
            disabled
            className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-100 px-2 py-1.5 text-sm text-slate-500"
          />
        </label>
        <label className="block">
          <span className="text-xs text-slate-500">配對 Token（留空即可）</span>
          <input
            value="（留空）"
            readOnly
            disabled
            className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-100 px-2 py-1.5 text-sm text-slate-500"
          />
        </label>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
        代理地址固定為 loopback（127.0.0.1:9311），開 App 自動配對；商家無須輸入 IP 或 Token。
      </p>
    </div>
  );
}

function AddPrinterWizard({
  printZones,
  roles,
  onAddPrinter,
}: {
  printZones: Array<{ id: string; name: string }>;
  roles: PrinterRoleOption[];
  onAddPrinter: (p: DevicePrinterConfig) => void;
}) {
  const [scanning, setScanning] = useState<null | "lan" | "usb">(null);
  const [candidates, setCandidates] = useState<PrinterCandidate[]>([]);
  const [selected, setSelected] = useState<PrinterCandidate | null>(null);

  // 表單欄位
  const [name, setName] = useState("");
  const [role, setRole] = useState<"zone" | "receipt" | "label">(roles[0]?.value ?? "zone");
  const [zoneId, setZoneId] = useState<string>("");
  const [paperSize, setPaperSize] = useState<string>(PAPER_SIZE_OPTIONS[1] ?? "80mm");
  const [charset, setCharset] = useState<string>(CHARSET_OPTIONS[0]?.value ?? "gb18030");
  const [bluetoothName, setBluetoothName] = useState("");

  function pick(c: PrinterCandidate) {
    setSelected(c);
    setName(c.name);
    setPaperSize(c.paperSize ?? PAPER_SIZE_OPTIONS[1] ?? "80mm");
    setCharset(c.charset ?? CHARSET_OPTIONS[0]?.value ?? "gb18030");
    if (c.connectionType === "bluetooth") setBluetoothName(c.bluetoothName ?? "");
  }

  async function scanLan() {
    setScanning("lan");
    const list = await discoverCompanionLanPrinters();
    setCandidates(list);
    setScanning(null);
  }
  async function scanUsb() {
    setScanning("usb");
    const list = await enumerateCompanionUsbPrinters();
    setCandidates(list);
    setScanning(null);
  }

  function submit() {
    if (!selected) return;
    const base: DevicePrinterConfig = {
      id: uid("printer"),
      role,
      connectionType: selected.connectionType,
      name: name.trim() || selected.name,
      model: selected.model,
      paperSize,
      charset,
      enabled: true,
      autoDetected: true,
    };
    if (role === "zone") base.zoneId = zoneId || undefined;
    if (selected.connectionType === "lan") {
      base.ipAddress = selected.ipAddress;
      base.lanPort = selected.lanPort ?? 9100;
    }
    if (selected.connectionType === "usb") {
      base.usbVendorId = selected.usbVendorId;
      base.usbProductId = selected.usbProductId;
    }
    if (selected.connectionType === "bluetooth") {
      base.bluetoothName = bluetoothName.trim();
    }
    onAddPrinter(base);
    // 重置 wizard
    setSelected(null);
    setCandidates([]);
    setName("");
    setBluetoothName("");
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-sm font-semibold text-slate-800">加入打印機（自動偵測）</div>
      <p className="mt-1 text-xs text-slate-500">
        按下面掃描，Companion 會列出區網 / USB 打印機，唔使手填 VID/PID。
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={scanLan}
          disabled={scanning !== null}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {scanning === "lan" ? "掃描中…" : "+ 區網 / LAN 打印機"}
        </button>
        <button
          type="button"
          onClick={scanUsb}
          disabled={scanning !== null}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {scanning === "usb" ? "枚舉中…" : "+ USB 打印機"}
        </button>
        <button
          type="button"
          onClick={() => pick({ source: "bluetooth", name: "藍牙打印機", connectionType: "bluetooth" })}
          disabled={scanning !== null}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          + 藍牙打印機
        </button>
      </div>

      {candidates.length > 0 && !selected && (
        <div className="mt-3 space-y-2">
          {candidates.map((c, i) => (
            <button
              key={`${c.connectionType}-${c.ipAddress ?? c.usbVendorId ?? c.bluetoothName ?? i}`}
              type="button"
              onClick={() => pick(c)}
              className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-left hover:border-slate-400 hover:bg-slate-50"
            >
              <span className="text-sm text-slate-800">{c.name}</span>
              <span className="text-[11px] uppercase text-slate-400">{c.connectionType}</span>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
          <div className="text-xs font-medium text-slate-600">
            已選：{selected.name}
            {selected.usbVendorId ? `（VID ${selected.usbVendorId} / PID ${selected.usbProductId}）` : ""}
          </div>

          <label className="block">
            <span className="text-xs text-slate-500">名稱</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-slate-500">類型</span>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as "zone" | "receipt" | "label")}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              >
                {roles.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>

            {role === "zone" && (
              <label className="block">
                <span className="text-xs text-slate-500">對應分區</span>
                <select
                  value={zoneId}
                  onChange={(e) => setZoneId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                >
                  <option value="">—</option>
                  {printZones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="block">
              <span className="text-xs text-slate-500">紙張</span>
              <select
                value={paperSize}
                onChange={(e) => setPaperSize(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              >
                {PAPER_SIZE_OPTIONS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs text-slate-500">編碼</span>
              <select
                value={charset}
                onChange={(e) => setCharset(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              >
                {CHARSET_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {selected.connectionType === "usb" && (
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
              型號自動偵測：VID {selected.usbVendorId} / PID {selected.usbProductId}
              （唔使手填）
            </div>
          )}

          {selected.connectionType === "bluetooth" && (
            <label className="block">
              <span className="text-xs text-slate-500">藍牙名稱 / 配對位址</span>
              <input
                value={bluetoothName}
                onChange={(e) => setBluetoothName(e.target.value)}
                placeholder="例如 BT-Printer-AB12"
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setSelected(null);
                setCandidates([]);
              }}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={role === "zone" && !zoneId}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              加入呢部機
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function PrinterCompanionPanel({
  printZones,
  onAddPrinter,
  roles,
}: PrinterCompanionPanelProps) {
  const roleOptions = roles && roles.length > 0 ? roles : DEFAULT_ROLES;
  return (
    <div className="space-y-3">
      <CompanionStatusCard />
      <AddPrinterWizard printZones={printZones} roles={roleOptions} onAddPrinter={onAddPrinter} />
    </div>
  );
}

export default PrinterCompanionPanel;
