"use client";

import { useEffect, useState } from "react";
import { ResponsiveModal } from "@/components/responsive-modal";
import { DevicePrinterConfig, PrinterRole } from "@/lib/types";
import { PrinterCandidate, enumerateCompanionUsbPrinters, isCompanionAvailable, probeLan } from "@/lib/print-bridge/companion";
import { getLanModelOptions, LanModelOption } from "@/lib/print-bridge/printer-models";

type WizardStep = 1 | 2 | 3;

interface WizardState {
  step: WizardStep;
  role: PrinterRole | null;
  connectionType: "lan" | "usb" | null;
  model: string | null;
  resolvedMeta: LanModelOption | null;
  usbVendorId?: string;
  usbProductId?: string;
  usbPort?: string;
  ipAddress: string;
  zoneId: string | null;
  connectionTested: boolean;
  testing: boolean;
  usbCandidates: PrinterCandidate[];
  usbScanning: boolean;
}

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

interface PrinterWizardModalProps {
  open: boolean;
  onClose: () => void;
  onAdd: (printer: DevicePrinterConfig) => void;
  printZones: { id: string; name: string }[];
}

export function PrinterWizardModal({ open, onClose, onAdd, printZones }: PrinterWizardModalProps) {
  const [state, setState] = useState<WizardState>({
    step: 1,
    role: null,
    connectionType: null,
    model: null,
    resolvedMeta: null,
    ipAddress: "",
    zoneId: null,
    connectionTested: false,
    testing: false,
    usbCandidates: [],
    usbScanning: false,
  });

  const lanModels = getLanModelOptions();

  // Reset wizard when opened
  useEffect(() => {
    if (open) {
      setState({
        step: 1,
        role: null,
        connectionType: null,
        model: null,
        resolvedMeta: null,
        ipAddress: "",
        zoneId: printZones.length === 1 ? printZones[0].id : null,
        connectionTested: false,
        testing: false,
        usbCandidates: [],
        usbScanning: false,
      });
    }
  }, [open, printZones]);

  // Scan USB when entering step 2 with USB
  useEffect(() => {
    if (state.step === 2 && state.connectionType === "usb" && state.usbCandidates.length === 0 && !state.usbScanning) {
      void scanUsb();
    }
  }, [state.step, state.connectionType, state.usbCandidates.length, state.usbScanning]);

  async function scanUsb() {
    setState((s) => ({ ...s, usbScanning: true }));
    try {
      const available = await isCompanionAvailable(true);
      if (!available) {
        setState((s) => ({ ...s, usbScanning: false }));
        return;
      }
      const candidates = await enumerateCompanionUsbPrinters();
      setState((s) => ({ ...s, usbCandidates: candidates, usbScanning: false }));
    } catch {
      setState((s) => ({ ...s, usbScanning: false }));
    }
  }

  function selectRole(role: PrinterRole) {
    setState((s) => ({ ...s, role }));
  }

  function selectConnectionType(connectionType: "lan" | "usb") {
    setState((s) => ({ ...s, connectionType }));
  }

  function selectLanModel(opt: LanModelOption) {
    setState((s) => ({
      ...s,
      model: opt.model,
      resolvedMeta: opt,
      step: 3,
    }));
  }

  function selectUsbDevice(candidate: PrinterCandidate) {
    const opt: LanModelOption = {
      brand: candidate.model || "USB 打印機",
      model: candidate.model || candidate.name || "USB 打印機",
      charset: (candidate.charset as LanModelOption["charset"]) || "gb18030",
      paperSize: (candidate.paperSize as LanModelOption["paperSize"]) || "80mm",
      kanjiEnlarge: candidate.kanjiEnlarge || "GS!",
    };
    setState((s) => ({
      ...s,
      model: opt.model,
      resolvedMeta: opt,
      usbVendorId: candidate.usbVendorId,
      usbProductId: candidate.usbProductId,
      usbPort: "USB001", // Companion 會自動偵測，呢度係 fallback
      step: 3,
    }));
  }

  async function testLanConnection() {
    const ip = state.ipAddress.trim();
    if (!ip) return;
    setState((s) => ({ ...s, testing: true }));
    try {
      const result = await probeLan(ip, 9100);
      setState((s) => ({ ...s, testing: false, connectionTested: result.ok }));
    } catch {
      setState((s) => ({ ...s, testing: false, connectionTested: false }));
    }
  }

  function complete() {
    if (!state.role || !state.connectionType || !state.model || !state.resolvedMeta) return;
    if (state.connectionType === "lan" && !state.ipAddress.trim()) return;

    const roleLabel = state.role === "receipt" ? "小票機" : state.role === "label" ? "標籤機" : "廚房機";
    const printer: DevicePrinterConfig = {
      id: uid("printer"),
      role: state.role,
      connectionType: state.connectionType,
      name: `${roleLabel} · ${state.model}`,
      model: state.model,
      paperSize: state.resolvedMeta.paperSize,
      charset: state.resolvedMeta.charset,
      kanjiEnlarge: state.resolvedMeta.kanjiEnlarge,
      ipAddress: state.connectionType === "lan" ? state.ipAddress.trim() : undefined,
      lanPort: state.connectionType === "lan" ? 9100 : undefined,
      usbVendorId: state.connectionType === "usb" ? state.usbVendorId : undefined,
      usbProductId: state.connectionType === "usb" ? state.usbProductId : undefined,
      usbPort: state.connectionType === "usb" ? state.usbPort : undefined,
      zoneId: state.role !== "receipt" ? (state.zoneId ?? printZones[0]?.id ?? "kitchen") : undefined,
      enabled: true,
    };
    onAdd(printer);
    onClose();
  }

  const canComplete =
    state.connectionType === "usb"
      ? Boolean(state.model && state.resolvedMeta)
      : Boolean(state.model && state.resolvedMeta && state.ipAddress.trim());

  // ---- Step 1 ----
  const roleOptions: { value: PrinterRole; label: string; desc: string; icon: string }[] = [
    { value: "zone", label: "廚房機", desc: "分區出單", icon: "🍳" },
    { value: "receipt", label: "小票機", desc: "收銀台收據", icon: "🧾" },
    { value: "label", label: "標籤機", desc: "杯貼標籤", icon: "🏷️" },
  ];

  const connOptions: { value: "lan" | "usb"; label: string; desc: string; icon: string }[] = [
    { value: "lan", label: "LAN", desc: "區網 / 網線", icon: "🌐" },
    { value: "usb", label: "USB", desc: "USB 直連", icon: "🔌" },
  ];

  if (!open) return null;

  return (
    <ResponsiveModal
      onClose={onClose}
      title="添加打印機"
      description={`第 ${state.step} 步 / 共 3 步`}
      widthClassName="max-w-lg"
      actions={
        <>
          {state.step > 1 && (
            <button
              className="rounded-2xl bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700"
              onClick={() => setState((s) => ({ ...s, step: (s.step - 1) as WizardStep }))}
              type="button"
            >
              上一步
            </button>
          )}
          {state.step === 3 && canComplete ? (
            <button
              className="rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white"
              onClick={complete}
              type="button"
            >
              完成
            </button>
          ) : null}
          {state.step < 3 && state.step === 1 && state.role && state.connectionType ? (
            <button
              className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
              onClick={() => setState((s) => ({ ...s, step: 2 }))}
              type="button"
            >
              下一步
            </button>
          ) : null}
        </>
      }
    >
      {/* Step 1: 用途 + 連接方式 */}
      {state.step === 1 ? (
        <div className="grid gap-6">
          <div>
            <div className="text-sm font-semibold text-slate-900">1. 選擇打印機用途</div>
            <div className="mt-3 grid gap-2">
              {roleOptions.map((opt) => (
                <button
                  key={opt.value}
                  className={`flex items-center gap-3 rounded-2xl border-2 px-4 py-3 text-left transition ${
                    state.role === opt.value
                      ? "border-slate-900 bg-slate-50"
                      : "border-slate-200 bg-white hover:border-slate-300"
                  }`}
                  onClick={() => selectRole(opt.value)}
                  type="button"
                >
                  <span className="text-2xl">{opt.icon}</span>
                  <div className="flex-1">
                    <div className="text-sm font-bold text-slate-900">{opt.label}</div>
                    <div className="text-xs text-slate-500">{opt.desc}</div>
                  </div>
                  {state.role === opt.value ? <span className="text-emerald-500">✅</span> : null}
                </button>
              ))}
            </div>
          </div>

          {state.role ? (
            <div>
              <div className="text-sm font-semibold text-slate-900">2. 選擇連接方式</div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {connOptions.map((opt) => (
                  <button
                    key={opt.value}
                    className={`flex items-center gap-3 rounded-2xl border-2 px-4 py-3 text-left transition ${
                      state.connectionType === opt.value
                        ? "border-slate-900 bg-slate-50"
                        : "border-slate-200 bg-white hover:border-slate-300"
                    }`}
                    onClick={() => selectConnectionType(opt.value)}
                    type="button"
                  >
                    <span className="text-2xl">{opt.icon}</span>
                    <div className="flex-1">
                      <div className="text-sm font-bold text-slate-900">{opt.label}</div>
                      <div className="text-xs text-slate-500">{opt.desc}</div>
                    </div>
                    {state.connectionType === opt.value ? <span className="text-emerald-500">✅</span> : null}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* 廚房機/標籤機要選分區 */}
          {state.role && state.role !== "receipt" && printZones.length > 1 ? (
            <div>
              <div className="text-sm font-semibold text-slate-900">3. 所屬分區</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {printZones.map((zone) => (
                  <button
                    key={zone.id}
                    className={`rounded-2xl border-2 px-3 py-2 text-sm font-semibold transition ${
                      state.zoneId === zone.id
                        ? "border-slate-900 bg-slate-50"
                        : "border-slate-200 bg-white hover:border-slate-300"
                    }`}
                    onClick={() => setState((s) => ({ ...s, zoneId: zone.id }))}
                    type="button"
                  >
                    {zone.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Step 2: 選擇型號 */}
      {state.step === 2 ? (
        <div className="grid gap-3">
          <div className="text-sm font-semibold text-slate-900">
            選擇打印機型號
            <span className="ml-2 text-xs font-normal text-slate-400">選定後不可更改</span>
          </div>

          {/* 已選摘要 */}
          <div className="flex items-center gap-2 rounded-xl bg-slate-100 px-3 py-2 text-xs text-slate-600">
            {state.role === "receipt" ? "小票機" : state.role === "label" ? "標籤機" : "廚房機"}
            {" · "}
            {state.connectionType === "lan" ? "LAN" : "USB"}
          </div>

          {/* LAN 型號列表 */}
          {state.connectionType === "lan" ? (
            <div className="grid max-h-[400px] gap-2 overflow-y-auto">
              {lanModels.map((opt, i) => (
                <button
                  key={`${opt.brand}-${opt.model}-${i}`}
                  className="flex items-center justify-between rounded-2xl border-2 border-slate-200 bg-white px-4 py-3 text-left hover:border-slate-300"
                  onClick={() => selectLanModel(opt)}
                  type="button"
                >
                  <div>
                    <div className="text-sm font-bold text-slate-900">{opt.model}</div>
                    <div className="text-xs text-slate-500">{opt.brand} · {opt.paperSize}</div>
                  </div>
                  <span className="text-slate-300">→</span>
                </button>
              ))}
            </div>
          ) : null}

          {/* USB 偵測設備列表 */}
          {state.connectionType === "usb" ? (
            <div className="grid gap-3">
              {state.usbScanning ? (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                  正在偵測 USB 設備…
                </div>
              ) : state.usbCandidates.length === 0 ? (
                <div className="grid gap-3">
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-8 text-center text-sm text-amber-700">
                    未偵測到 USB 打印機
                    <br />
                    <span className="text-xs">請確認打印機已接上 USB 並開啟電源</span>
                  </div>
                  <button
                    className="rounded-2xl bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700"
                    onClick={() => void scanUsb()}
                    type="button"
                  >
                    重新掃描
                  </button>
                </div>
              ) : (
                <div className="grid max-h-[400px] gap-2 overflow-y-auto">
                  {state.usbCandidates.map((candidate, i) => (
                    <button
                      key={`${candidate.usbVendorId}-${candidate.usbProductId}-${i}`}
                      className="flex items-center justify-between rounded-2xl border-2 border-slate-200 bg-white px-4 py-3 text-left hover:border-slate-300"
                      onClick={() => selectUsbDevice(candidate)}
                      type="button"
                    >
                      <div>
                        <div className="text-sm font-bold text-slate-900">
                          {candidate.model || candidate.name}
                        </div>
                        <div className="text-xs text-slate-500">
                          {candidate.model || "USB 設備"} · {candidate.paperSize || "80mm"}
                        </div>
                      </div>
                      <span className="text-slate-300">→</span>
                    </button>
                  ))}
                  <button
                    className="rounded-2xl bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700"
                    onClick={() => void scanUsb()}
                    type="button"
                  >
                    重新掃描
                  </button>
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Step 3: 完成連接 */}
      {state.step === 3 ? (
        <div className="grid gap-4">
          {/* 已選摘要 */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-100 px-3 py-2 text-xs text-slate-600">
            {state.role === "receipt" ? "小票機" : state.role === "label" ? "標籤機" : "廚房機"}
            {" · "}
            {state.connectionType === "lan" ? "LAN" : "USB"}
            {" · "}
            {state.model}
            <span className="text-slate-400">🔒 已鎖定</span>
          </div>

          {/* LAN：輸入 IP */}
          {state.connectionType === "lan" ? (
            <div className="grid gap-3">
              <label className="grid gap-1 text-sm font-semibold text-slate-900">
                打印機 IP 地址
                <input
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  onChange={(e) => setState((s) => ({ ...s, ipAddress: e.target.value, connectionTested: false }))}
                  placeholder="192.168.1.110"
                  value={state.ipAddress}
                  inputMode="decimal"
                />
              </label>
              <div className="flex items-center gap-3">
                <button
                  className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  disabled={!state.ipAddress.trim() || state.testing}
                  onClick={() => void testLanConnection()}
                  type="button"
                >
                  {state.testing ? "測試中…" : "測試連接"}
                </button>
                {state.connectionTested ? (
                  <span className="text-sm font-semibold text-emerald-600">✅ 連接成功</span>
                ) : state.ipAddress.trim() && !state.testing ? (
                  <span className="text-sm text-slate-400">點擊測試連接</span>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* USB：已偵測到設備 */}
          {state.connectionType === "usb" ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              ✅ USB 打印機已連接
              <div className="mt-1 text-xs text-emerald-600">
                {state.model} · {state.resolvedMeta?.paperSize}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </ResponsiveModal>
  );
}
