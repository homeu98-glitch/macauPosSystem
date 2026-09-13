"use client";

import { useEffect, useMemo, useState } from "react";
import { ResponsiveModal } from "@/components/responsive-modal";
import { DevicePrinterConfig, PrinterRole } from "@/lib/types";
import { PrinterCandidate, enumerateCompanionUsbPrinters, isCompanionAvailable, probeLan } from "@/lib/print-bridge/companion";
import {
  LABEL_COMMAND_SETS,
  LABEL_MODEL_PAPER_SIZES,
  LanModelOption,
  LabelCommandSet,
  familyForRole,
  getLanModelOptions,
  suggestLabelCommandSet,
} from "@/lib/print-bridge/printer-models";

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
  /**
   * 標籤機專屬：標籤紙尺寸（`LABEL_MODEL_PAPER_SIZES` 嘅 value）。
   *
   * 🔴 2026-09-13 新增。**標籤機唔應該問「分區」，應該問「紙張尺寸」** ——
   * 之前標籤機走咗 kitchen 邏輯（`role !== "receipt"` → 顯示分區選擇），
   * 但餐飲杯貼 / 零售價籤同「廚房分區」完全無關，反而紙寬（40×30 vs 100×75）
   * 係決定出紙排版嘅關鍵。見 docs/144。
   */
  labelPaperSize: string;
  /**
   * 標籤機專屬：指令集（TSPL / ZPL / ESC/POS …）。
   *
   * 🔴 國內標籤機行 **TSPL**，唔食 ESC/POS。呢個欄位決定下游 renderer
   * 用邊套指令，缺咗就靜靜用錯指令集 → 出白紙或亂碼。
   */
  labelCommandSet: LabelCommandSet;
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
  /**
   * 鎖定用途（2026-09-11）。
   *
   * 自助點餐機打印機**一定係小票機**（`role: "receipt"`）—— `buildKioskReceiptPrintJobs()`
   * 只認 `role === "receipt"`。若果畀商家喺 kiosk 設定入面揀到「廚房機 / 標籤機」，
   * 佢加完會**靜靜地唔出紙**（job 建唔到，冇 error）。所以喺 kiosk 場景鎖死用途，
   * 略過第 1 步嘅用途選擇，直接入連線方式。
   */
  lockRole?: PrinterRole;
}

export function PrinterWizardModal({ open, onClose, onAdd, printZones, lockRole }: PrinterWizardModalProps) {
  const [state, setState] = useState<WizardState>({
    step: 1,
    role: null,
    connectionType: null,
    model: null,
    resolvedMeta: null,
    ipAddress: "",
    zoneId: null,
    labelPaperSize: "100x75mm",
    labelCommandSet: "tspl",
    connectionTested: false,
    testing: false,
    usbCandidates: [],
    usbScanning: false,
  });

  /**
   * 型號清單**按用途過濾**。
   *
   * 🔴 呢個係本次修正嘅核心：之前係 `getLanModelOptions()` 無參數 → 標籤機
   * 見到嘅係票據機清單（Epson / 商頌 POS-80 / 芯燁 XP-Q800…）。
   * 而家傳 `familyForRole(state.role)`：標籤機只出標籤機、廚房/小票機只出票據機。
   */
  const lanModels = useMemo(
    () => getLanModelOptions(familyForRole(state.role)),
    [state.role],
  );

  const isLabel = state.role === "label";

  // Reset wizard when opened
  useEffect(() => {
    if (open) {
      setState({
        step: 1,
        role: lockRole ?? null,
        connectionType: null,
        model: null,
        resolvedMeta: null,
        ipAddress: "",
        zoneId: printZones.length === 1 ? printZones[0].id : null,
        labelPaperSize: "100x75mm",
        labelCommandSet: "tspl",
        connectionTested: false,
        testing: false,
        usbCandidates: [],
        usbScanning: false,
      });
    }
  }, [open, printZones, lockRole]);

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
    // 換用途 = 之前揀嘅型號一定唔啱（票據機型號 != 標籤機型號）→ 一齊清走。
    // 唔清 = 商家由「廚房機」改「標籤機」之後，model 仲留住上一份清單嘅值。
    setState((s) => ({
      ...s,
      role,
      model: null,
      resolvedMeta: null,
      labelCommandSet: role === "label" ? "tspl" : s.labelCommandSet,
    }));
  }

  function selectConnectionType(connectionType: "lan" | "usb") {
    setState((s) => ({ ...s, connectionType }));
  }

  function selectLanModel(opt: LanModelOption) {
    setState((s) => ({
      ...s,
      model: opt.model,
      resolvedMeta: opt,
      // 標籤機：由型號帶入建議指令集（商家可喺 Step 3 改）
      labelCommandSet: opt.family === "label" ? suggestLabelCommandSet(opt.brand) : s.labelCommandSet,
      labelPaperSize: opt.family === "label" ? opt.paperSize : s.labelPaperSize,
      step: 3,
    }));
  }

  function selectUsbDevice(candidate: PrinterCandidate) {
    const labelish = state.role === "label";
    // Companion 已經由 VID/PID 判斷硬件族（漢印 SL42=label / TP805=receipt）。
    // 佢有值就信佢；冇值（舊版 Companion）就按商家所選用途 fallback。
    const family = candidate.family ?? (labelish ? "label" : "receipt");
    const isLabelFamily = family === "label";
    const opt: LanModelOption = {
      brand: candidate.model || "USB 打印機",
      model: candidate.model || candidate.name || "USB 打印機",
      charset: (candidate.charset as LanModelOption["charset"]) || (isLabelFamily ? "utf-8" : "gb18030"),
      paperSize:
        (candidate.paperSize as LanModelOption["paperSize"]) || (isLabelFamily ? "100x75mm" : "80mm"),
      kanjiEnlarge: candidate.kanjiEnlarge || "GS!",
      family,
      alsoKnownAs: [],
    };
    setState((s) => ({
      ...s,
      model: opt.model,
      resolvedMeta: opt,
      usbVendorId: candidate.usbVendorId,
      usbProductId: candidate.usbProductId,
      usbPort: "USB001", // Companion 會自動偵測，呢度係 fallback
      labelCommandSet: isLabelFamily ? suggestLabelCommandSet(opt.brand) : s.labelCommandSet,
      labelPaperSize: isLabelFamily ? opt.paperSize : s.labelPaperSize,
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
      // 標籤機：用商家喺 Step 3 揀嘅標籤紙尺寸（唔用型號表預設，因為同一部機
      // 可以換卷）；其他角色照用型號表預設。
      paperSize: isLabel ? state.labelPaperSize : state.resolvedMeta.paperSize,
      charset: state.resolvedMeta.charset,
      kanjiEnlarge: state.resolvedMeta.kanjiEnlarge,
      ipAddress: state.connectionType === "lan" ? state.ipAddress.trim() : undefined,
      lanPort: state.connectionType === "lan" ? 9100 : undefined,
      usbVendorId: state.connectionType === "usb" ? state.usbVendorId : undefined,
      usbProductId: state.connectionType === "usb" ? state.usbProductId : undefined,
      usbPort: state.connectionType === "usb" ? state.usbPort : undefined,
      // 🔴 標籤機**唔應該**有 zoneId —— 杯貼 / 價籤同廚房分區無關。
      // 舊行為：`role !== "receipt"` 會塞一個 zoneId 落標籤機，令排位 / 分區
      // 邏輯誤以為佢係廚房機。
      zoneId: state.role === "zone" ? (state.zoneId ?? printZones[0]?.id ?? "kitchen") : undefined,
      /**
       * 標籤機指令集（TSPL / ZPL / ESC/POS…）。
       *
       * ⚠️ `DevicePrinterConfig` 目前**未有** `labelCommandSet` 欄位 —— 呢度
       * 用 `role: "label"` + `paperSize` 已足夠令下游行標籤分支；指令集欄位
       * 屬跨 repo 改動（四個 renderer 都要認），留待 Phase 2 連埋 TSPL 渲染器一齊做
       * （見 docs/144 §4）。現階段先**存在 UI 讓商家記錄**，寫入 `name` 尾部太醜，
       * 所以暫時只喺 console 標示，唔污染 config。
       */
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
    { value: "label", label: "標籤機", desc: "價籤 / 杯貼（TSPL）", icon: "🏷️" },
  ];

  const connOptions: { value: "lan" | "usb"; label: string; desc: string; icon: string }[] = [
    { value: "lan", label: "LAN", desc: "區網 / 網線", icon: "🌐" },
    { value: "usb", label: "USB", desc: "USB 直連", icon: "🔌" },
  ];

  if (!open) return null;

  return (
    <ResponsiveModal
      onClose={onClose}
      title={isLabel ? "添加標籤機" : "添加打印機"}
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
          {lockRole ? null : (
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
          )}

          {state.role ? (
            <div>
              <div className="text-sm font-semibold text-slate-900">
                {lockRole ? "選擇連接方式" : "2. 選擇連接方式"}
              </div>
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

          {/*
            🔴 分區**只屬於廚房機**（zone）。
            2026-09-13 修正：之前 condition 係 `state.role !== "receipt"`，
            連標籤機都逼佢揀廚房分區 —— 但標籤機（零售價籤 / 餐飲杯貼）
            同廚房分區毫無關係。標籤機要問嘅係「紙張尺寸」（Step 3），
            唔係「所屬分區」。
          */}
          {state.role === "zone" && printZones.length > 1 ? (
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
            {isLabel ? "選擇標籤機型號" : "選擇打印機型號"}
            <span className="ml-2 text-xs font-normal text-slate-400">選定後不可更改</span>
          </div>

          {/* 已選摘要 */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-100 px-3 py-2 text-xs text-slate-600">
            <span
              className={`rounded-full px-2 py-0.5 font-semibold ${
                isLabel ? "bg-violet-100 text-violet-700" : "bg-slate-200 text-slate-700"
              }`}
            >
              {state.role === "receipt" ? "小票機" : state.role === "label" ? "標籤機" : "廚房機"}
            </span>
            {" · "}
            {state.connectionType === "lan" ? "LAN" : "USB"}
          </div>

          {/*
            🔴 標籤機專屬提示：唔食 ESC/POS。
            國內標籤機行 TSPL，同票據機嘅 ESC/POS 係兩套指令集。商家
            如果當佢票據機用，會出白紙。呢個警告一定要喺揀型號之前出。
          */}
          {isLabel ? (
            <div className="rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-700">
              🏷️ 標籤機走 <b>TSPL / ZPL</b> 指令集，同票據機（ESC/POS）唔通用。
              下面只列標籤機型號。
            </div>
          ) : null}

          {/* LAN 型號列表（已按用途過濾） */}
          {state.connectionType === "lan" ? (
            <div className="grid max-h-[400px] gap-2 overflow-y-auto">
              {lanModels.length === 0 ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-6 text-center text-sm text-amber-700">
                  未收錄此用途嘅型號，請回上一步或改用 USB 自動偵測
                </div>
              ) : (
                lanModels.map((opt, i) => (
                  <button
                    key={`${opt.brand}-${opt.model}-${i}`}
                    className="flex items-center justify-between rounded-2xl border-2 border-slate-200 bg-white px-4 py-3 text-left hover:border-slate-300"
                    onClick={() => selectLanModel(opt)}
                    type="button"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-bold text-slate-900">{opt.model}</div>
                      <div className="truncate text-xs text-slate-500">
                        {opt.brand} · {opt.paperSize}
                        {opt.genericFallback ? " · 通用" : ""}
                      </div>
                    </div>
                    <span className="text-slate-300">→</span>
                  </button>
                ))
              )}
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
                      <div className="min-w-0">
                        <div className="truncate text-sm font-bold text-slate-900">
                          {candidate.model || candidate.name}
                        </div>
                        <div className="truncate text-xs text-slate-500">
                          {candidate.paperSize || (isLabel ? "100x75mm" : "80mm")}
                          {candidate.usbVendorId ? ` · ${candidate.usbVendorId}` : ""}
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
                {state.model} · {isLabel ? state.labelPaperSize : state.resolvedMeta?.paperSize}
              </div>
            </div>
          ) : null}

          {/*
            🔴 標籤機專屬設定區（Step 3）。
            呢個係「標籤機應有自己獨立且合適嘅設置選項」嘅落點：
              ① 標籤紙尺寸（40×30 … 100×75）—— 決定排版闊度
              ② 指令集（TSPL / ZPL / ESC/POS…）—— 決定下游用邊套 bytes
            呢兩項**票據機完全唔會見到**（下面 `!isLabel` 分支只有 IP/USB 確認）。
          */}
          {isLabel ? (
            <div className="grid gap-3 rounded-2xl border border-violet-200 bg-violet-50/60 p-3">
              <div className="text-sm font-semibold text-violet-900">🏷️ 標籤機設定</div>

              <div className="grid gap-1">
                <span className="text-xs font-semibold text-violet-800">標籤紙尺寸</span>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {LABEL_MODEL_PAPER_SIZES.map((p) => (
                    <button
                      key={p.value}
                      className={`rounded-xl border-2 px-2 py-2 text-left text-xs transition ${
                        state.labelPaperSize === p.value
                          ? "border-violet-600 bg-white"
                          : "border-violet-200 bg-white/70 hover:border-violet-300"
                      }`}
                      onClick={() => setState((s) => ({ ...s, labelPaperSize: p.value }))}
                      type="button"
                    >
                      <div className="font-bold text-slate-900">{p.label}</div>
                      <div className="mt-0.5 text-[10px] leading-tight text-slate-500">{p.hint}</div>
                    </button>
                  ))}
                </div>
              </div>

              <label className="grid gap-1">
                <span className="text-xs font-semibold text-violet-800">指令集</span>
                <select
                  className="rounded-xl border border-violet-200 bg-white px-3 py-2 text-sm"
                  onChange={(e) =>
                    setState((s) => ({ ...s, labelCommandSet: e.target.value as LabelCommandSet }))
                  }
                  value={state.labelCommandSet}
                >
                  {LABEL_COMMAND_SETS.map((cs) => (
                    <option key={cs.value} value={cs.value}>
                      {cs.label} —— {cs.hint}
                    </option>
                  ))}
                </select>
              </label>

              {state.labelCommandSet !== "tspl" && state.labelCommandSet !== "zpl" ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                  ⚠️ 國內標籤機（佳博 / 漢印 / 得力 / 快麥 / 啟銳 / 立象 / 台半）絕大多數行
                  <b> TSPL</b>。揀錯指令集會出白紙或亂碼。
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </ResponsiveModal>
  );
}
