"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { ResponsiveModal } from "@/components/responsive-modal";
import { defaultDeviceConfig, defaultPosLocalSettings, mockBootstrap } from "@/lib/mock-data";
import {
  loadBootstrapCache,
  loadDeviceConfig,
  loadPosLocalSettings,
  loadQueue,
  loadSoldOutState,
  normalizeDeviceConfig,
  normalizePosLocalSettings,
  saveBootstrapCache,
  saveDeviceConfig,
  savePosLocalSettings,
  saveQueue,
  saveSoldOutState,
} from "@/lib/storage";
import { DeviceConfig, DevicePrinterConfig, MenuSpecGroup, PosLocalSettings, QueueEvent } from "@/lib/types";
import { normalizeBootstrapPayload } from "@/lib/bootstrap-normalizer";
import { fetchLedgerOrderMenu, LedgerOrderMenu } from "@/lib/ledger/menu";
import {
  LedgerMenuImportPreview,
  mergeLedgerMenuReference,
  previewLedgerMenuImport,
} from "@/lib/ledger/menu-import";
import { formatSpecGroupsSummary } from "@/lib/ledger/menu-spec";
import { restoreLedgerSession } from "@/lib/ledger/session";
import { isPrintBridgeEnabled, requestTestPrintBridge, syncPrintBridgeConfig } from "@/lib/print-bridge/client";
import {
  isWebUsbSupported,
  listWebUsbDevices,
  requestWebUsbDevice,
  requestTestPrintWebUsb,
  webUsbDeviceLabel,
} from "@/lib/print-webusb";
import { printBrowserTestPage } from "@/lib/print-browser";
import { usePrintBridgeHealth } from "@/components/print-bridge-worker";

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function cloneSpecGroups(specGroups?: MenuSpecGroup[]) {
  return specGroups ? (JSON.parse(JSON.stringify(specGroups)) as MenuSpecGroup[]) : [];
}

export function DeviceSettings() {
  const bridgeHealth = usePrintBridgeHealth();
  const cachedConfig = loadDeviceConfig();
  const cachedLocalSettings = loadPosLocalSettings();
  const cachedBootstrap = loadBootstrapCache() ?? mockBootstrap;
  const [config, setConfig] = useState<DeviceConfig>(cachedConfig ?? defaultDeviceConfig);
  const [localSettings, setLocalSettings] = useState<PosLocalSettings>(cachedLocalSettings ?? defaultPosLocalSettings);
  const [status, setStatus] = useState(cachedConfig ? "已載入本機設定。" : "尚未同步設定。");
  const [activeTab, setActiveTab] = useState<
    "device" | "menu-print" | "menu" | "tables" | "payments" | "online-orders" | "notes"
  >("device");
  const [menuDraft, setMenuDraft] = useState(() => normalizeBootstrapPayload(cachedBootstrap));
  const [menuSaving, setMenuSaving] = useState(false);
  const [menuSyncing, setMenuSyncing] = useState(false);
  const [ledgerImportOpen, setLedgerImportOpen] = useState(false);
  const [ledgerImportLoading, setLedgerImportLoading] = useState(false);
  const [ledgerImportApplying, setLedgerImportApplying] = useState(false);
  const [ledgerImportPreview, setLedgerImportPreview] = useState<LedgerMenuImportPreview | null>(null);
  const [ledgerMenuPending, setLedgerMenuPending] = useState<LedgerOrderMenu | null>(null);
  const [ledgerImportRemoveLocal, setLedgerImportRemoveLocal] = useState(false);
  const [ledgerImportError, setLedgerImportError] = useState<string | null>(null);
  const [syncingConfig, setSyncingConfig] = useState(false);
  const [testingPrinterId, setTestingPrinterId] = useState<string | null>(null);
  const [webusbLabel, setWebusbLabel] = useState<Record<string, string>>({});

  // 載入頁面時，列出已授權嘅 WebUSB 打印機；按 serial 填回 label，
  // 咁已綁定嘅 printer 唔使再撳掣就顯示設備名（零設定體驗）。
  useEffect(() => {
    if (!isWebUsbSupported()) return;
    listWebUsbDevices()
      .then((devices) => {
        if (devices.length === 0) return;
        setWebusbLabel((current) => {
          const next = { ...current };
          for (const device of devices) {
            if (device?.serialNumber) next[device.serialNumber] = webUsbDeviceLabel(device);
          }
          return next;
        });
      })
      .catch(() => {});
  }, []);
  const [menuSubTab, setMenuSubTab] = useState<"categories" | "specs" | "items">("items");
  const [specEditor, setSpecEditor] = useState<{
    open: boolean;
    mode: "item" | "template";
    itemId: string | null;
    templateId: string | null;
    templateName: string;
    draft: MenuSpecGroup[];
  }>({ open: false, mode: "item", itemId: null, templateId: null, templateName: "", draft: [] });
  const [bulkSelectedMenuIds, setBulkSelectedMenuIds] = useState<string[]>([]);
  const [bulkPrinterGroup, setBulkPrinterGroup] = useState<string>(cachedLocalSettings?.printZones?.[0]?.id ?? "kitchen");
  const [menuPrintCategoryId, setMenuPrintCategoryId] = useState<string>("all");
  const [menuPrintPage, setMenuPrintPage] = useState(1);
  const menuPrintPageSize = 50;
  const [menuCategoryId, setMenuCategoryId] = useState<string>("all");
  const [menuPage, setMenuPage] = useState(1);
  const menuPageSize = 50;
  const [newNotePreset, setNewNotePreset] = useState("");
  const [newPrintZoneName, setNewPrintZoneName] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(cachedLocalSettings?.specTemplates?.[0]?.id ?? "");
  const [devicePrinterTab, setDevicePrinterTab] = useState<"zones" | "printers">("zones");
  const [newCancelNotePreset, setNewCancelNotePreset] = useState("");

  const menuFilteredItems = useMemo(() => {
    return menuDraft.menuItems.filter((item) => menuCategoryId === "all" || item.categoryId === menuCategoryId);
  }, [menuDraft.menuItems, menuCategoryId]);

  const menuTotalPages = useMemo(() => Math.max(1, Math.ceil(menuFilteredItems.length / menuPageSize)), [menuFilteredItems.length]);

  const menuPageItems = useMemo(() => {
    const safePage = Math.min(menuPage, menuTotalPages);
    const start = (safePage - 1) * menuPageSize;
    return menuFilteredItems.slice(start, start + menuPageSize);
  }, [menuFilteredItems, menuPage, menuTotalPages]);

  const categoryNameMap = useMemo(() => {
    const normalized = normalizeBootstrapPayload(cachedBootstrap);
    return Object.fromEntries(normalized.categories.map((category) => [category.id, category.name]));
  }, [cachedBootstrap]);

  const selectedSpecTemplate = useMemo(
    () => localSettings.specTemplates.find((template) => template.id === selectedTemplateId) ?? null,
    [localSettings.specTemplates, selectedTemplateId],
  );

  useEffect(() => {
    if (!cachedConfig) {
      saveDeviceConfig(defaultDeviceConfig);
    }
    if (!cachedLocalSettings) {
      savePosLocalSettings(defaultPosLocalSettings);
    }
  }, [cachedConfig, cachedLocalSettings]);

  function saveTablesLocal() {
    savePosLocalSettings(localSettings);
    setStatus("已保存樓層與桌台到本機。");
  }

  async function beginLedgerMenuImport() {
    setLedgerImportLoading(true);
    setLedgerImportError(null);
    try {
      const restored = await restoreLedgerSession();
      if (!restored) {
        throw new Error("請先登入 POS（Ledger 商戶帳號）。");
      }
      const ledgerMenu = await fetchLedgerOrderMenu();
      if (!ledgerMenu.enabled) {
        throw new Error("Ledger 線上點餐未啟用，無法匯入。");
      }
      if (ledgerMenu.categories.length === 0 && ledgerMenu.products.length === 0) {
        throw new Error("Ledger 返回空菜單，請先在會員通後台設定線上菜品。");
      }
      setLedgerMenuPending(ledgerMenu);
      setLedgerImportRemoveLocal(false);
      setLedgerImportPreview(previewLedgerMenuImport(menuDraft, ledgerMenu, { removeLocalMenu: false }));
      setLedgerImportOpen(true);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "讀取 Ledger 菜單失敗。");
    } finally {
      setLedgerImportLoading(false);
    }
  }

  async function applyLedgerMenuImport() {
    if (!ledgerMenuPending) return;
    setLedgerImportApplying(true);
    setLedgerImportError(null);
    try {
      const { bootstrap, soldOut, stats } = mergeLedgerMenuReference(
        menuDraft,
        ledgerMenuPending,
        loadSoldOutState(),
        { removeLocalMenu: ledgerImportRemoveLocal },
      );
      const normalizedBootstrap = normalizeBootstrapPayload(bootstrap);
      setMenuDraft(normalizedBootstrap);
      saveBootstrapCache(normalizedBootstrap);
      saveSoldOutState(soldOut);
      window.dispatchEvent(new CustomEvent("pos-soldout-changed", { detail: { soldOutMap: soldOut } }));
      setLedgerImportOpen(false);
      setLedgerMenuPending(null);
      setLedgerImportPreview(null);
      setLedgerImportRemoveLocal(false);
      const removedNote =
        stats.localItemsRemoved > 0 || stats.localCategoriesRemoved > 0
          ? `；已刪除本地 ${stats.localCategoriesRemoved} 分類、${stats.localItemsRemoved} 菜品`
          : "";
      setStatus(
        `已從 Ledger 參考匯入：${stats.ledgerCategoryCount} 分類、${stats.ledgerProductCount} 菜品（新增 ${stats.itemsAdded}、更新 ${stats.itemsUpdated}）；同步售罄 ${stats.soldOutCount} 項${removedNote}。請再按「保存菜單」寫入後台。`,
      );
    } catch (err) {
      setLedgerImportError(err instanceof Error ? err.message : "匯入失敗。");
    } finally {
      setLedgerImportApplying(false);
    }
  }

  useEffect(() => {
    async function loadOnlineOrderSettings() {
      try {
        const response = await fetch("/api/online-order-settings");
        const payload = (await response.json()) as { autoAccept?: boolean };
        setLocalSettings((current) => ({
          ...current,
          onlineOrderSettings: {
            autoAccept: payload.autoAccept ?? current.onlineOrderSettings.autoAccept,
          },
        }));
      } catch {
        // 保留本機設定
      }
    }

    void loadOnlineOrderSettings();
  }, []);

  useEffect(() => {
    async function loadRemoteConfig() {
      try {
        const response = await fetch("/api/pos/device-config");
        const payload = (await response.json()) as {
          deviceConfig?: DeviceConfig | null;
          localSettings?: PosLocalSettings | null;
        };
        if (payload.deviceConfig) {
          const normalizedDevice = normalizeDeviceConfig(payload.deviceConfig);
          if (normalizedDevice) {
            setConfig(normalizedDevice);
            saveDeviceConfig(normalizedDevice);
          }
        }
        if (payload.localSettings) {
          const normalized = normalizePosLocalSettings(payload.localSettings);
          setLocalSettings(normalized);
          savePosLocalSettings(normalized);
        }
      } catch {
        // 保留本機設定
      }
    }

    void loadRemoteConfig();
  }, []);

  const printerGroupOptions = useMemo(
    () =>
      config.printers
        .filter((printer) => printer.enabled && printer.role === "zone")
        .map((printer) => ({
          value: printer.zoneId ?? "",
          label: `${printer.name} (${localSettings.printZones.find((zone) => zone.id === printer.zoneId)?.name ?? printer.zoneId ?? "未分區"})`,
        })),
    [config.printers, localSettings.printZones],
  );

  function updatePrinter(printerId: string, patch: Partial<DevicePrinterConfig>) {
    setConfig((current) => {
      const nextPrinters = current.printers.map((printer) => {
        if (printer.id !== printerId) {
          if (patch.role === "receipt" && printer.role === "receipt") {
            return {
              ...printer,
              role: "zone" as DevicePrinterConfig["role"],
              zoneId: printer.zoneId ?? localSettings.printZones[0]?.id ?? "kitchen",
            };
          }
          return printer;
        }
        const merged = { ...printer, ...patch };
        if (merged.role === "zone" || merged.role === "label") {
          merged.zoneId = merged.zoneId ?? localSettings.printZones[0]?.id ?? "kitchen";
        } else {
          merged.zoneId = undefined;
        }
        if (merged.role === "receipt") {
          merged.paperSize = merged.paperSize || "80mm";
        }
        return merged;
      });
      return {
        ...current,
        updatedAt: new Date().toISOString(),
        printers: nextPrinters,
      };
    });
  }

  function addPrinter(role: DevicePrinterConfig["role"]) {
    const newPrinter: DevicePrinterConfig = {
      id: uid("printer"),
      role,
      zoneId: role === "zone" || role === "label" ? localSettings.printZones[0]?.id ?? "kitchen" : undefined,
      connectionType: "lan",
      name: role === "receipt" ? "新收據打印機" : role === "label" ? "新標籤打印機" : "新分區打印機",
      model: "",
      paperSize: role === "receipt" ? "80mm" : role === "label" ? "62mm" : "80mm",
      ipAddress: "",
      lanPort: 9100,
      usbLabel: "",
      enabled: true,
    };
    setConfig((current) => ({
      ...current,
      updatedAt: new Date().toISOString(),
      printers:
        role === "receipt"
          ? [
              ...current.printers.map((printer) =>
                printer.role === "receipt"
                  ? {
                      ...printer,
                      role: "zone" as DevicePrinterConfig["role"],
                      zoneId: printer.zoneId ?? localSettings.printZones[0]?.id ?? "kitchen",
                    }
                  : printer,
              ),
              newPrinter,
            ]
          : [...current.printers, newPrinter],
    }));
  }

  function removePrinter(printerId: string) {
    setConfig((current) => ({
      ...current,
      updatedAt: new Date().toISOString(),
      printers: current.printers.filter((printer) => printer.id !== printerId),
    }));
  }

  function saveLocal() {
    saveDeviceConfig(config);
    savePosLocalSettings(localSettings);
    setStatus("已保存到本機，尚未回寫後台。");
  }

  function openSpecEditorForItem(itemId: string, specGroups?: MenuSpecGroup[]) {
    setSpecEditor({
      open: true,
      mode: "item",
      itemId,
      templateId: null,
      templateName: "",
      draft: cloneSpecGroups(specGroups),
    });
  }

  function openSpecEditorForTemplate(templateId?: string) {
    const template = templateId
      ? localSettings.specTemplates.find((item) => item.id === templateId) ?? null
      : null;
    setSpecEditor({
      open: true,
      mode: "template",
      itemId: null,
      templateId: template?.id ?? null,
      templateName: template?.name ?? "新規格模板",
      draft: cloneSpecGroups(template?.specGroups),
    });
  }

  function closeSpecEditor() {
    setSpecEditor({ open: false, mode: "item", itemId: null, templateId: null, templateName: "", draft: [] });
  }

  async function syncConfig() {
    if (syncingConfig) return;
    setSyncingConfig(true);
    const updatedConfig = { ...config, updatedAt: new Date().toISOString() };
    saveDeviceConfig(updatedConfig);
    savePosLocalSettings(localSettings);
    setConfig(updatedConfig);

    const event: QueueEvent = {
      id: uid("evt"),
      type: "DEVICE_CONFIG_UPDATED",
      entityId: updatedConfig.deviceId,
      payload: {
        device: updatedConfig,
        tables: localSettings.floors,
        paymentMethods: localSettings.paymentMethods,
        menuPrinterOverrides: localSettings.menuPrinterOverrides,
        printZones: localSettings.printZones,
        specTemplates: localSettings.specTemplates,
        printTemplates: localSettings.printTemplates,
        cancelNotePresets: localSettings.cancelNotePresets,
        onlineOrderSettings: localSettings.onlineOrderSettings,
      },
      status: "pending",
      createdAt: updatedConfig.updatedAt,
    };

    const nextQueue = [...loadQueue(), event];
    saveQueue(nextQueue);

    try {
      await fetch("/api/pos/device-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...updatedConfig,
          localSettings,
        }),
      });
      await fetch("/api/online-order-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(localSettings.onlineOrderSettings),
      });
      saveQueue(nextQueue.map((item) => (item.id === event.id ? { ...item, status: "synced" } : item)));
      setStatus("已同步到後台設定接口。");
    } catch {
      setStatus("同步失敗，已保留在本機待補傳。");
    } finally {
      setSyncingConfig(false);
    }
  }

  async function testPrint(printer: DevicePrinterConfig) {
    if (testingPrinterId) return;
    setTestingPrinterId(printer.id);

    try {
      if (printer.connectionType === "webusb") {
        if (!isWebUsbSupported()) {
          setStatus("此瀏覽器唔支援 WebUSB，請用 Chrome / Edge 並以 https / localhost 開啟。");
          return;
        }
        const result = await requestTestPrintWebUsb(printer);
        setStatus(result.ok ? `已透過 WebUSB 直印 ${printer.name} 測試頁。` : result.error);
        return;
      }

      if (printer.connectionType === "browser") {
        const result = await printBrowserTestPage(printer);
        setStatus(result.ok ? `已透過瀏覽器打印 ${printer.name} 測試頁（請在打印對話框揀部機）。` : result.error);
        return;
      }

      if (isPrintBridgeEnabled()) {
        await syncPrintBridgeConfig(config);
        const result = await requestTestPrintBridge(printer);
        if (result.ok) {
          setStatus(`已透過本機橋接送出 ${printer.name} 測試打印。`);
        } else {
          setStatus(result.error);
        }
        return;
      }

      const event: QueueEvent = {
        id: uid("evt"),
        type: "TEST_PRINT_REQUESTED",
        entityId: printer.id,
        payload: {
          printerId: printer.id,
          printerName: printer.name,
          connectionType: printer.connectionType,
        },
        status: "pending",
        createdAt: new Date().toISOString(),
      };

      const nextQueue = [...loadQueue(), event];
      saveQueue(nextQueue);

      await fetch("/api/pos/device-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "test-print",
          printerId: printer.id,
          printerName: printer.name,
        }),
      });
      saveQueue(nextQueue.map((item) => (item.id === event.id ? { ...item, status: "synced" } : item)));
      setStatus(`已送出 ${printer.name} 測試打印。`);
    } catch {
      setStatus(`未能送出 ${printer.name} 測試打印，事件已排隊。`);
    } finally {
      setTestingPrinterId(null);
    }
  }

  return (
    <div className="h-[100dvh] overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="h-[100dvh] overflow-auto pb-[calc(env(safe-area-inset-bottom)+16px)]">
        <div className="sticky top-0 z-20 border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4 px-4 py-3 md:pl-[88px]">
            <div>
              <div className="text-lg font-semibold text-slate-900">設置</div>
              <div className="mt-1 text-sm text-slate-500">
                打印機、菜品打印、樓層桌台、支付方式、線上訂單都集中在這裡。
              </div>
            </div>
            <Link className="rounded-full bg-indigo-600 px-3 py-2 text-sm font-semibold text-white" href="/">
              返回收銀台
            </Link>
          </div>
        </div>

        <div className="mx-auto max-w-[1600px] px-4 py-3 md:pl-[88px]">
        <div className="mb-3 flex flex-wrap gap-2">
          {[
            ["device", "打印機"],
            ["menu-print", "菜品打印設置"],
            ["menu", "菜單"],
            ["tables", "樓層與桌台"],
            ["payments", "支付方式"],
            ["notes", "備註"],
          ].map(([key, label]) => (
            <button
              key={key}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${
                activeTab === key ? "bg-orange-500 text-white" : "bg-white text-slate-700 ring-1 ring-slate-200"
              }`}
              onClick={() => setActiveTab(key as typeof activeTab)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mb-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
          {status}
        </div>

        {activeTab === "device" ? (
          <div className="grid min-w-0 gap-3 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[380px_minmax(0,1fr)]">
            <div className="lg:col-span-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm">
              <div className="font-semibold text-slate-900">打印橋接（Android POS / print-bridge）</div>
              <p className="mt-1 text-xs text-slate-500">
                填寫店內橋接服務地址。若 POS 部署在 HTTPS 網站（如 Vercel），橋接必須用{" "}
                <code className="rounded bg-slate-100 px-1">https://</code>（見 docs/33-print-bridge-https-lan.md）；
                純本機／LAN 可用 <code className="rounded bg-slate-100 px-1">http://192.168.1.50:9222</code>
                。優先使用下方本機設定；若留空則使用部署環境變量{" "}
                <code className="rounded bg-slate-100 px-1">NEXT_PUBLIC_PRINT_BRIDGE_URL</code>。
              </p>
              <label className="mt-3 grid gap-1 text-sm font-semibold text-slate-700">
                <span className="text-xs text-slate-500">橋接 URL</span>
                <input
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  onChange={(event) =>
                    setConfig((current) => ({ ...current, printBridgeUrl: event.target.value.trim() }))
                  }
                  placeholder="https://bridge.yourdomain.com:8443"
                  value={config.printBridgeUrl ?? ""}
                />
              </label>
              {isPrintBridgeEnabled() ? (
                <div className="mt-2">
                  <span className="font-semibold text-slate-900">狀態：</span>
                  {bridgeHealth?.ok ? (
                    <span className="text-emerald-700">
                      已連線 · v{bridgeHealth.version ?? "?"} · {bridgeHealth.printerCount ?? 0} 台打印機設定
                    </span>
                  ) : (
                    <span className="text-red-700">
                      {bridgeHealth?.error ?? "橋接服務離線，請確認 Android POS App 或 print-bridge 已啟動"}
                    </span>
                  )}
                </div>
              ) : (
                <div className="mt-2 text-xs text-amber-700">尚未設定橋接 URL，打印任務只會留在隊列中。</div>
              )}
            </div>
            <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4">
              <div className="text-base font-semibold text-slate-900">本機資料</div>
              <div className="mt-4 grid gap-3">
                <label className="grid gap-1 text-sm font-semibold text-slate-700">
                  <span className="text-xs text-slate-500">設備 ID</span>
                  <input
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    onChange={(event) => setConfig((current) => ({ ...current, deviceId: event.target.value }))}
                    value={config.deviceId}
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-slate-700">
                  <span className="text-xs text-slate-500">收銀機名稱</span>
                  <input
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    onChange={(event) => setConfig((current) => ({ ...current, terminalName: event.target.value }))}
                    value={config.terminalName}
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-slate-700">
                  <span className="text-xs text-slate-500">門店 ID</span>
                  <input
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    onChange={(event) => setConfig((current) => ({ ...current, storeId: event.target.value }))}
                    value={config.storeId}
                  />
                </label>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                  onClick={saveLocal}
                  type="button"
                >
                  只保存到本機
                </button>
                <button
                  className="rounded-2xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white"
                  aria-busy={syncingConfig}
                  disabled={syncingConfig}
                  onClick={syncConfig}
                  type="button"
                >
                  {syncingConfig ? "同步中…" : "保存並同步後台"}
                </button>
              </div>
            </section>

            <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 max-h-[calc(100dvh-150px)] flex flex-col">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-base font-semibold text-slate-900">打印機綁定</div>
                  <div className="mt-1 text-sm text-slate-500">
                    支援自定義分區、唯一收據打印機，以及綁定分區的標籤機。
                  </div>
                </div>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                  {config.printers.length} printers
                </span>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  className={`rounded-full px-4 py-2 text-sm font-semibold ${
                    devicePrinterTab === "zones" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
                  }`}
                  onClick={() => setDevicePrinterTab("zones")}
                  type="button"
                >
                  打印分區
                </button>
                <button
                  className={`rounded-full px-4 py-2 text-sm font-semibold ${
                    devicePrinterTab === "printers" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
                  }`}
                  onClick={() => setDevicePrinterTab("printers")}
                  type="button"
                >
                  打印機列表
                </button>
              </div>

              <div className="mt-4 flex-1 overflow-auto pr-1">
              {devicePrinterTab === "zones" ? (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm font-semibold text-slate-900">打印分區</div>
                <div className="mt-1 text-xs text-slate-500">分區可自由新增，例如：廚房、水吧、甜品、燒味。</div>
                <div className="mt-3 grid gap-2">
                  {localSettings.printZones.map((zone) => (
                    <div key={zone.id} className="flex items-center gap-2">
                      <input
                        className="flex-1 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                        onChange={(event) => {
                          const next = {
                            ...localSettings,
                            printZones: localSettings.printZones.map((item) =>
                              item.id === zone.id ? { ...item, name: event.target.value } : item,
                            ),
                          };
                          setLocalSettings(next);
                          savePosLocalSettings(next);
                        }}
                        value={zone.name}
                      />
                      <button
                        className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 disabled:opacity-50"
                        disabled={localSettings.printZones.length <= 1}
                        onClick={() => {
                          const nextZones = localSettings.printZones.filter((item) => item.id !== zone.id);
                          const fallbackZoneId = nextZones[0]?.id ?? "kitchen";
                          const nextSettings = {
                            ...localSettings,
                            printZones: nextZones,
                            menuPrinterOverrides: Object.fromEntries(
                              Object.entries(localSettings.menuPrinterOverrides).map(([itemId, zoneId]) => [
                                itemId,
                                zoneId === zone.id ? fallbackZoneId : zoneId,
                              ]),
                            ),
                          };
                          setLocalSettings(nextSettings);
                          setConfig((current) => ({
                            ...current,
                            printers: current.printers.map((printer) =>
                              printer.zoneId === zone.id ? { ...printer, zoneId: fallbackZoneId } : printer,
                            ),
                          }));
                          savePosLocalSettings(nextSettings);
                          setStatus("已刪除打印分區。");
                        }}
                        type="button"
                      >
                        刪除
                      </button>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm lg:w-[240px]"
                    onChange={(event) => setNewPrintZoneName(event.target.value)}
                    placeholder="新增分區，例如：甜品"
                    value={newPrintZoneName}
                  />
                  <button
                    className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                    onClick={() => {
                      const text = newPrintZoneName.trim();
                      if (!text) return;
                      const next = {
                        ...localSettings,
                        printZones: [
                          ...localSettings.printZones,
                          { id: `${text.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`, name: text },
                        ],
                      };
                      setLocalSettings(next);
                      savePosLocalSettings(next);
                      setNewPrintZoneName("");
                      setStatus("已新增打印分區。");
                    }}
                    type="button"
                  >
                    新增分區
                  </button>
                </div>
              </div>
              ) : null}

              {devicePrinterTab === "printers" ? (
              <div className="mt-4 min-w-0 overflow-auto pr-1 max-h-[calc(100dvh-420px)]">
                <div className="grid gap-3">
                  {config.printers.map((printer) => (
                    <article key={printer.id} className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-900">{printer.name}</div>
                          <div className="mt-1 break-words text-xs text-slate-500">
                            {printer.role === "receipt"
                              ? "收據"
                              : printer.role === "label"
                                ? `標籤 · ${localSettings.printZones.find((zone) => zone.id === printer.zoneId)?.name ?? printer.zoneId ?? "--"}`
                                : `分區 · ${localSettings.printZones.find((zone) => zone.id === printer.zoneId)?.name ?? printer.zoneId ?? "--"}`}{" "}
                            · {printer.connectionType.toUpperCase()}
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                            <input
                              checked={printer.enabled}
                              onChange={(event) => updatePrinter(printer.id, { enabled: event.target.checked })}
                              type="checkbox"
                            />
                            啟用
                          </label>
                          <button
                            className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                            onClick={() => removePrinter(printer.id)}
                            type="button"
                          >
                            刪除
                          </button>
                        </div>
                      </div>

                      <div className="mt-4 grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                        <label className="grid gap-1 text-sm font-semibold text-slate-700">
                          <span className="text-xs text-slate-500">打印機名稱</span>
                          <input
                            className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                            onChange={(event) => updatePrinter(printer.id, { name: event.target.value })}
                            value={printer.name}
                          />
                        </label>
                        <label className="grid gap-1 text-sm font-semibold text-slate-700">
                          <span className="text-xs text-slate-500">用途</span>
                          <select
                            className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                            onChange={(event) => updatePrinter(printer.id, { role: event.target.value as DevicePrinterConfig["role"] })}
                            value={printer.role}
                          >
                            <option value="zone">分區出單</option>
                            <option value="receipt">收據</option>
                            <option value="label">標籤</option>
                          </select>
                        </label>
                        {printer.role !== "receipt" ? (
                          <label className="grid gap-1 text-sm font-semibold text-slate-700">
                            <span className="text-xs text-slate-500">{printer.role === "label" ? "標籤分區" : "打印分區"}</span>
                            <select
                              className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                              onChange={(event) => updatePrinter(printer.id, { zoneId: event.target.value })}
                              value={printer.zoneId ?? localSettings.printZones[0]?.id ?? ""}
                            >
                              {localSettings.printZones.map((zone) => (
                                <option key={zone.id} value={zone.id}>
                                  {zone.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : (
                          <div className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
                            收銀台只會指定 1 台收據打印機
                          </div>
                        )}
                        <label className="grid gap-1 text-sm font-semibold text-slate-700">
                          <span className="text-xs text-slate-500">連接方式</span>
                          <select
                            className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                            onChange={(event) =>
                              updatePrinter(printer.id, {
                                connectionType: event.target.value as DevicePrinterConfig["connectionType"],
                              })
                            }
                            value={printer.connectionType}
                          >
                            <option value="lan">LAN</option>
                            <option value="usb">USB</option>
                            <option value="webusb">WebUSB（browser 直印）</option>
                            <option value="browser">瀏覽器打印（window.print）</option>
                          </select>
                        </label>
                        <label className="grid gap-1 text-sm font-semibold text-slate-700">
                          <span className="text-xs text-slate-500">打印機型號</span>
                          <input
                            className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                            onChange={(event) => updatePrinter(printer.id, { model: event.target.value })}
                            placeholder="例如：TM-T82X / QL-820NWB"
                            value={printer.model ?? ""}
                          />
                        </label>
                        <label className="grid gap-1 text-sm font-semibold text-slate-700">
                          <span className="text-xs text-slate-500">紙寬 / 尺寸</span>
                          <select
                            className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                            onChange={(event) => updatePrinter(printer.id, { paperSize: event.target.value })}
                            value={printer.paperSize ?? ""}
                          >
                            <option value="">請選擇</option>
                            <option value="58mm">58mm</option>
                            <option value="80mm">80mm</option>
                            <option value="62mm">62mm 標籤</option>
                            <option value="100x75mm">100x75mm 標籤</option>
                          </select>
                        </label>
                        {printer.connectionType !== "webusb" && printer.connectionType !== "browser" && (
                        <label className="grid gap-1 text-sm font-semibold text-slate-700">
                          <span className="text-xs text-slate-500">IP 地址（LAN）</span>
                          <input
                            className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                            onChange={(event) => updatePrinter(printer.id, { ipAddress: event.target.value })}
                            placeholder="192.168.1.110"
                            value={printer.ipAddress ?? ""}
                          />
                        </label>
                        )}
                        {printer.connectionType !== "webusb" && printer.connectionType !== "browser" && (
                        <label className="grid gap-1 text-sm font-semibold text-slate-700">
                          <span className="text-xs text-slate-500">LAN 端口</span>
                          <input
                            className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                            inputMode="numeric"
                            onChange={(event) =>
                              updatePrinter(printer.id, { lanPort: Number(event.target.value) || 9100 })
                            }
                            placeholder="9100"
                            value={String(printer.lanPort ?? 9100)}
                          />
                        </label>
                        )}
                        {printer.connectionType !== "webusb" && printer.connectionType !== "browser" && (
                        <label className="grid gap-1 text-sm font-semibold text-slate-700 md:col-span-2 2xl:col-span-2">
                          <span className="text-xs text-slate-500">USB 系統印表機名稱</span>
                          <input
                            className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                            onChange={(event) => updatePrinter(printer.id, { usbLabel: event.target.value })}
                            value={printer.usbLabel ?? ""}
                          />
                        </label>
                        )}
                        {printer.connectionType === "webusb" && (
                          <div className="grid gap-1 text-sm font-semibold text-slate-700 md:col-span-2 2xl:col-span-2">
                            <span className="text-xs text-slate-500">WebUSB 打印機（browser 直印 · 零設定）</span>
                            {!isWebUsbSupported() ? (
                              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                                此瀏覽器唔支援 WebUSB，請用 Chrome / Edge 並以 https 或 localhost 開啟本頁。
                              </div>
                            ) : (
                              <div className="flex flex-wrap items-center gap-2">
                                <button
                                  className="rounded-2xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white"
                                  onClick={async () => {
                                    try {
                                      const device = await requestWebUsbDevice();
                                      if (!device) {
                                        setStatus("未選擇任何 WebUSB 打印機。");
                                        return;
                                      }
                                      const label = webUsbDeviceLabel(device);
                                      updatePrinter(printer.id, { webusbSerial: device.serialNumber ?? undefined });
                                      if (device.serialNumber) {
                                        setWebusbLabel((current) => ({
                                          ...current,
                                          [device.serialNumber as string]: label,
                                        }));
                                      }
                                      setStatus(`已綁定 WebUSB 打印機：${label}`);
                                    } catch (error) {
                                      setStatus(`WebUSB 授權失敗：${error instanceof Error ? error.message : String(error)}`);
                                    }
                                  }}
                                  type="button"
                                >
                                  偵測 / 綁定 WebUSB 打印機
                                </button>
                                {printer.webusbSerial ? (
                                  <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                                    已綁定：{webusbLabel[printer.webusbSerial] ?? printer.webusbSerial}
                                  </span>
                                ) : null}
                                {printer.webusbSerial ? (
                                  <button
                                    className="rounded-2xl bg-white px-3 py-1 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                                    onClick={() => {
                                      updatePrinter(printer.id, { webusbSerial: undefined });
                                      setStatus("已解除 WebUSB 打印機綁定。");
                                    }}
                                    type="button"
                                  >
                                    解除綁定
                                  </button>
                                ) : null}
                              </div>
                            )}
                          </div>
                        )}
                        {printer.connectionType === "browser" && (
                          <div className="grid gap-1 text-sm font-semibold text-slate-700 md:col-span-2 2xl:col-span-2">
                            <span className="text-xs text-slate-500">瀏覽器打印（window.print · 零額外安裝）</span>
                            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600">
                              經瀏覽器「列印」對話框出紙，web app 唔使裝任何嘢。需 Windows 已安裝打印機 driver（例如 WL-R80A-win），並在對話框揀部機。無 ESC/POS 切紙 / 錢箱指令。
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="mt-4 flex flex-wrap justify-end gap-2">
                        <button
                          className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                          aria-busy={testingPrinterId === printer.id}
                          disabled={Boolean(testingPrinterId)}
                          onClick={() => testPrint(printer)}
                          type="button"
                        >
                          {testingPrinterId === printer.id ? "打印中…" : "測試打印"}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
              ) : null}

              </div>

              {devicePrinterTab === "printers" ? (
                <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
                  <button
                    className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                    onClick={() => addPrinter("zone")}
                    type="button"
                  >
                    新增廚房 / 分區打印機
                  </button>
                  <button
                    className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                    onClick={() => addPrinter("receipt")}
                    type="button"
                  >
                    新增收據打印機
                  </button>
                  <button
                    className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                    onClick={() => addPrinter("label")}
                    type="button"
                  >
                    新增標籤打印機
                  </button>
                </div>
              ) : null}
            </section>
          </div>
        ) : null}

        {activeTab === "notes" ? (
          <div className="grid gap-3 lg:grid-cols-2">
            <section className="rounded-2xl border border-slate-200 bg-white p-4 max-h-[calc(100dvh-150px)] flex flex-col overflow-hidden">
              <div className="text-base font-semibold text-slate-900">常用備註</div>
              <div className="mt-1 text-sm text-slate-500">用於點餐時快速選擇（多選）。</div>

              <div className="mt-4 flex-1 overflow-auto pr-1">
                <div className="grid gap-2">
                  {localSettings.notePresets.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                      暫時沒有常用備註
                    </div>
                  ) : (
                    localSettings.notePresets.map((note) => (
                      <div
                        key={note}
                        className="flex items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2"
                      >
                        <div className="text-sm font-semibold text-slate-900">{note}</div>
                        <button
                          className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                          onClick={() => {
                            const next = {
                              ...localSettings,
                              notePresets: localSettings.notePresets.filter((item) => item !== note),
                            };
                            setLocalSettings(next);
                            setStatus("已更新常用備註草稿，請先保存。");
                          }}
                          type="button"
                        >
                          刪除
                        </button>
                      </div>
                    ))
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm lg:w-[320px]"
                    onChange={(event) => setNewNotePreset(event.target.value)}
                    placeholder="新增常用備註..."
                    value={newNotePreset}
                  />
                  <button
                    className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                    onClick={() => {
                      const text = newNotePreset.trim();
                      if (!text) return;
                      const next = {
                        ...localSettings,
                        notePresets: Array.from(new Set([...localSettings.notePresets, text])),
                      };
                      setLocalSettings(next);
                      setNewNotePreset("");
                      setStatus("已新增常用備註草稿，請先保存。");
                    }}
                    type="button"
                  >
                    加入
                  </button>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-4 max-h-[calc(100dvh-150px)] flex flex-col overflow-hidden">
              <div className="text-base font-semibold text-slate-900">取消備註</div>
              <div className="mt-1 text-sm text-slate-500">用於退菜/取消時快速選擇。</div>

              <div className="mt-4 flex-1 overflow-auto pr-1">
                <div className="grid gap-2">
                  {localSettings.cancelNotePresets.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                      暫時沒有取消備註
                    </div>
                  ) : (
                    localSettings.cancelNotePresets.map((note) => (
                      <div
                        key={note}
                        className="flex items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2"
                      >
                        <div className="text-sm font-semibold text-slate-900">{note}</div>
                        <button
                          className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                          onClick={() => {
                            const next = {
                              ...localSettings,
                              cancelNotePresets: localSettings.cancelNotePresets.filter((item) => item !== note),
                            };
                            setLocalSettings(next);
                            setStatus("已更新取消備註草稿，請先保存。");
                          }}
                          type="button"
                        >
                          刪除
                        </button>
                      </div>
                    ))
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm lg:w-[320px]"
                    onChange={(event) => setNewCancelNotePreset(event.target.value)}
                    placeholder="新增取消備註..."
                    value={newCancelNotePreset}
                  />
                  <button
                    className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                    onClick={() => {
                      const text = newCancelNotePreset.trim();
                      if (!text) return;
                      const next = {
                        ...localSettings,
                        cancelNotePresets: Array.from(new Set([...localSettings.cancelNotePresets, text])),
                      };
                      setLocalSettings(next);
                      setNewCancelNotePreset("");
                      setStatus("已新增取消備註草稿，請先保存。");
                    }}
                    type="button"
                  >
                    加入
                  </button>
                </div>

                <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-sm font-semibold text-slate-900">全部退菜後的整單狀態</div>
                  <div className="mt-1 text-xs text-slate-500">可設定全部退菜後，未結帳整單是標成已取消還是已退完。</div>
                  <div className="mt-3 grid gap-2">
                    <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm font-semibold text-slate-900">
                      <input
                        checked={localSettings.fullVoidBehavior === "cancelled"}
                        onChange={() =>
                          setLocalSettings((current) => ({
                            ...current,
                            fullVoidBehavior: "cancelled",
                          }))
                        }
                        type="radio"
                      />
                      <span>已取消</span>
                    </label>
                    <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm font-semibold text-slate-900">
                      <input
                        checked={localSettings.fullVoidBehavior === "refunded"}
                        onChange={() =>
                          setLocalSettings((current) => ({
                            ...current,
                            fullVoidBehavior: "refunded",
                          }))
                        }
                        type="radio"
                      />
                      <span>已退完</span>
                    </label>
                  </div>
                </div>
              </div>
            </section>

            <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4 lg:col-span-2">
              <button
                className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                onClick={() => {
                  savePosLocalSettings(localSettings);
                  setStatus("備註已保存到本機，可立即使用。");
                }}
                type="button"
              >
                保存備註
              </button>
              <button
                className="rounded-2xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white"
                aria-busy={syncingConfig}
                disabled={syncingConfig}
                onClick={syncConfig}
                type="button"
              >
                {syncingConfig ? "同步中…" : "保存並同步後台"}
              </button>
            </div>
          </div>
        ) : null}

        {activeTab === "menu-print" ? (
          <section className="min-h-0 rounded-2xl border border-slate-200 bg-white p-4 max-h-[calc(100dvh-150px)] flex flex-col overflow-hidden">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-base font-semibold text-slate-900">菜品打印設置</div>
                <div className="mt-1 text-sm text-slate-500">菜品先分配到打印分區，再由分區打印機或標籤機接收。</div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <div className="text-sm text-slate-700">
                已選 {bulkSelectedMenuIds.length} 個菜品
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  onChange={(event) => {
                    setMenuPrintCategoryId(event.target.value);
                    setMenuPrintPage(1);
                    setBulkSelectedMenuIds([]);
                  }}
                  value={menuPrintCategoryId}
                >
                  <option value="all">全部分類</option>
                  {menuDraft.categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
                <select
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  onChange={(event) => setBulkPrinterGroup(event.target.value)}
                  value={bulkPrinterGroup}
                >
                  {localSettings.printZones.map((zone) => (
                    <option key={zone.id} value={zone.id}>
                      {zone.name}
                    </option>
                  ))}
                </select>
                <button
                  className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  disabled={bulkSelectedMenuIds.length === 0}
                  onClick={() => {
                    setLocalSettings((current) => ({
                      ...current,
                      menuPrinterOverrides: {
                        ...current.menuPrinterOverrides,
                        ...Object.fromEntries(bulkSelectedMenuIds.map((id) => [id, bulkPrinterGroup])),
                      },
                    }));
                    setBulkSelectedMenuIds([]);
                    setStatus("已套用批量打印分組，請記得保存。");
                  }}
                  type="button"
                >
                  批量套用
                </button>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              {(() => {
                const filteredCount = cachedBootstrap.menuItems.filter(
                  (item) => menuPrintCategoryId === "all" || item.categoryId === menuPrintCategoryId,
                ).length;
                const totalPages = Math.max(1, Math.ceil(filteredCount / menuPrintPageSize));
                return (
                  <>
                    <div className="text-sm text-slate-600">
                      共 {filteredCount} 個菜品 · 第 {menuPrintPage}/{totalPages} 頁（每頁 {menuPrintPageSize}）
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 disabled:opacity-50"
                        disabled={menuPrintPage <= 1}
                        onClick={() => setMenuPrintPage((current) => Math.max(1, current - 1))}
                        type="button"
                      >
                        上一頁
                      </button>
                      <button
                        className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 disabled:opacity-50"
                        disabled={menuPrintPage >= totalPages}
                        onClick={() => setMenuPrintPage((current) => Math.min(totalPages, current + 1))}
                        type="button"
                      >
                        下一頁
                      </button>
                    </div>
                  </>
                );
              })()}
            </div>

            <div className="mt-2 overflow-auto rounded-2xl border border-slate-200 flex-1 min-h-0">
              <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0 z-10 bg-white">
                  <tr className="text-left text-xs font-semibold text-slate-500">
                    <th className="border-b border-slate-200 py-2 pr-3">
                      {(() => {
                        const filtered = cachedBootstrap.menuItems.filter(
                          (item) => menuPrintCategoryId === "all" || item.categoryId === menuPrintCategoryId,
                        );
                        const totalPages = Math.max(1, Math.ceil(filtered.length / menuPrintPageSize));
                        const safePage = Math.min(menuPrintPage, totalPages);
                        const start = (safePage - 1) * menuPrintPageSize;
                        const pageIds = filtered.slice(start, start + menuPrintPageSize).map((item) => item.id);
                        const allSelected =
                          pageIds.length > 0 && pageIds.every((id) => bulkSelectedMenuIds.includes(id));
                        return (
                          <label className="inline-flex items-center gap-2">
                            <input
                              checked={allSelected}
                              onChange={(event) => {
                                const checked = event.target.checked;
                                setBulkSelectedMenuIds((current) => {
                                  const set = new Set(current);
                                  if (checked) {
                                    pageIds.forEach((id) => set.add(id));
                                  } else {
                                    pageIds.forEach((id) => set.delete(id));
                                  }
                                  return Array.from(set);
                                });
                              }}
                              type="checkbox"
                            />
                            <span>選擇</span>
                          </label>
                        );
                      })()}
                    </th>
                    <th className="border-b border-slate-200 py-2 pr-3">菜品</th>
                    <th className="border-b border-slate-200 py-2 pr-3">分類</th>
                    <th className="border-b border-slate-200 py-2 pr-3">當前分區</th>
                    <th className="border-b border-slate-200 py-2">會打印到</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const filtered = cachedBootstrap.menuItems.filter(
                      (item) => menuPrintCategoryId === "all" || item.categoryId === menuPrintCategoryId,
                    );
                    const totalPages = Math.max(1, Math.ceil(filtered.length / menuPrintPageSize));
                    const safePage = Math.min(menuPrintPage, totalPages);
                    const start = (safePage - 1) * menuPrintPageSize;
                    const pageItems = filtered.slice(start, start + menuPrintPageSize);

                    const grouped = pageItems.reduce<Record<string, typeof pageItems>>((acc, row) => {
                      acc[row.categoryId] = acc[row.categoryId] ?? [];
                      acc[row.categoryId].push(row);
                      return acc;
                    }, {});

                    return Object.entries(grouped).flatMap(([categoryId, items]) => {
                      const categoryName = categoryNameMap[categoryId] ?? categoryId;
                      return [
                        <tr key={`cat-${categoryId}`} className="bg-slate-50">
                          <td className="border-b border-slate-200 py-2 pr-3 text-xs font-semibold text-slate-500" colSpan={5}>
                            {categoryName}
                          </td>
                        </tr>,
                        ...items.map((item) => {
                    const group = localSettings.menuPrinterOverrides[item.id] ?? item.printerGroup;
                    const checked = bulkSelectedMenuIds.includes(item.id);
                    return (
                      <tr key={item.id}>
                        <td className="border-b border-slate-100 py-2 pr-3">
                          <input
                            checked={checked}
                            onChange={(event) =>
                              setBulkSelectedMenuIds((current) =>
                                event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id),
                              )
                            }
                            type="checkbox"
                          />
                        </td>
                        <td className="border-b border-slate-100 py-2 pr-3 font-semibold text-slate-900">{item.name}</td>
                        <td className="border-b border-slate-100 py-2 pr-3 text-slate-600">
                          {categoryNameMap[item.categoryId] ?? item.categoryId}
                        </td>
                        <td className="border-b border-slate-100 py-2 pr-3">
                          <select
                            className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                            onChange={(event) =>
                              setLocalSettings((current) => ({
                                ...current,
                                menuPrinterOverrides: {
                                  ...current.menuPrinterOverrides,
                                  [item.id]: event.target.value,
                                },
                              }))
                            }
                            value={group}
                          >
                            {localSettings.printZones.map((zone) => (
                              <option key={zone.id} value={zone.id}>
                                {zone.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="border-b border-slate-100 py-2 text-slate-600">
                          {printerGroupOptions.filter((printer) => printer.value === group).map((printer) => printer.label).join("、") || "未綁定啟用打印機"}
                        </td>
                      </tr>
                    );
                        }),
                      ];
                    });
                  })()}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex justify-end border-t border-slate-100 pt-4">
              <button
                className="rounded-2xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white"
                aria-busy={syncingConfig}
                disabled={syncingConfig}
                onClick={syncConfig}
                type="button"
              >
                {syncingConfig ? "同步中…" : "保存菜品打印設置"}
              </button>
            </div>
          </section>
        ) : null}

        {activeTab === "menu" ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-4 max-h-[calc(100dvh-150px)] flex flex-col overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-base font-semibold text-slate-900">菜單</div>
                <div className="mt-1 text-sm text-slate-500">
                  本店菜單以 POS 為準。可從 Ledger 一鍵參考匯入線上菜品（名稱／價格／售罄），本地自建菜品會保留。
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  aria-busy={ledgerImportLoading}
                  disabled={ledgerImportLoading || menuSaving || menuSyncing}
                  onClick={() => void beginLedgerMenuImport()}
                  type="button"
                >
                  {ledgerImportLoading ? "讀取 Ledger…" : "從 Ledger 參考匯入"}
                </button>
                <button
                  className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                  aria-busy={menuSyncing}
                  disabled={menuSyncing || menuSaving}
                  onClick={async () => {
                    setMenuSyncing(true);
                    setStatus("正在重新載入後台菜單…");
                    try {
                      const response = await fetch("/api/pos/bootstrap");
                      const raw = (await response.json()) as unknown as Parameters<typeof normalizeBootstrapPayload>[0];
                      const payload = normalizeBootstrapPayload(raw);
                      setMenuDraft(payload);
                      saveBootstrapCache(payload);
                      setStatus("已重新載入後台菜單。");
                    } catch {
                      setStatus("重新載入失敗，請稍後再試。");
                    } finally {
                      setMenuSyncing(false);
                    }
                  }}
                  type="button"
                >
                  {menuSyncing ? "同步中…" : "同步菜單"}
                </button>
                <button
                  className="rounded-2xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  aria-busy={menuSaving}
                  disabled={menuSaving}
                  onClick={async () => {
                    setMenuSaving(true);
                    setStatus("正在保存菜單到後台…");
                    try {
                      await fetch("/api/pos/bootstrap", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          storeId: menuDraft.storeId,
                          storeName: menuDraft.storeName,
                          currency: menuDraft.currency,
                          categories: menuDraft.categories,
                          menuItems: menuDraft.menuItems,
                          tables: menuDraft.tables,
                          rules: menuDraft.rules,
                          printerGroups: menuDraft.printerGroups,
                        }),
                      });
                      saveBootstrapCache(menuDraft);
                      setStatus("菜單已保存到後台。");
                    } catch (err) {
                      setStatus(err instanceof Error ? err.message : "菜單保存失敗，請稍後再試。");
                    } finally {
                      setMenuSaving(false);
                    }
                  }}
                  type="button"
                >
                  {menuSaving ? "保存中…" : "保存菜單"}
                </button>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <div className="text-sm font-semibold text-slate-700">內容</div>
              <div className="flex flex-wrap gap-2">
                {[
                  ["categories", "菜品分類"],
                  ["specs", "規格管理"],
                  ["items", "菜品設置"],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    className={`rounded-full px-4 py-2 text-sm font-semibold ${
                      menuSubTab === key ? "bg-orange-500 text-white" : "bg-white text-slate-700 ring-1 ring-slate-200"
                    }`}
                    onClick={() => setMenuSubTab(key as typeof menuSubTab)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {menuSubTab === "categories" ? (
              <div className="mt-4 flex flex-1 min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-slate-900">分類</div>
                  <button
                    className="rounded-2xl bg-orange-500 px-3 py-2 text-xs font-semibold text-white"
                    onClick={() =>
                      setMenuDraft((current) => ({
                        ...current,
                        categories: [...current.categories, { id: crypto.randomUUID(), name: "新分類" }],
                      }))
                    }
                    type="button"
                  >
                    新增分類
                  </button>
                </div>
                <div className="mt-3 flex-1 min-h-0 overflow-auto pr-1">
                  <div className="grid gap-2">
                    {menuDraft.categories.map((category) => (
                      <input
                        key={category.id}
                        className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900"
                        onChange={(event) =>
                          setMenuDraft((current) => ({
                            ...current,
                            categories: current.categories.map((item) =>
                              item.id === category.id ? { ...item, name: event.target.value } : item,
                            ),
                          }))
                        }
                        value={category.name}
                      />
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            {menuSubTab === "specs" ? (
              <div className="mt-4 flex flex-1 min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">規格模板</div>
                    <div className="mt-1 text-xs text-slate-500">先建立模板，再到「菜品設置」一鍵套用到菜品。</div>
                  </div>
                  <button
                    className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                    onClick={() => openSpecEditorForTemplate(undefined)}
                    type="button"
                  >
                    新增模板
                  </button>
                </div>

                <div className="mt-4 flex-1 min-h-0 overflow-auto rounded-2xl border border-slate-200">
                  <table className="w-full border-collapse text-sm">
                    <thead className="bg-white">
                      <tr className="text-left text-xs font-semibold text-slate-500">
                        <th className="border-b border-slate-200 px-3 py-2">模板</th>
                        <th className="border-b border-slate-200 px-3 py-2">規格組</th>
                        <th className="border-b border-slate-200 px-3 py-2">選項數</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {localSettings.specTemplates.length === 0 ? (
                        <tr>
                          <td className="px-3 py-6 text-slate-500" colSpan={4}>
                            目前沒有規格模板
                          </td>
                        </tr>
                      ) : (
                        localSettings.specTemplates.map((template) => (
                          <tr key={template.id}>
                            <td className="border-b border-slate-100 px-3 py-2 font-semibold text-slate-900">
                              {template.name}
                            </td>
                            <td className="border-b border-slate-100 px-3 py-2 text-slate-600">
                              {template.specGroups?.length ?? 0}
                            </td>
                            <td className="border-b border-slate-100 px-3 py-2 text-slate-600">
                              {template.specGroups?.reduce((sum, g) => sum + (g.options?.length ?? 0), 0) ?? 0}
                            </td>
                            <td className="border-b border-slate-100 px-3 py-2 text-right">
                              <button
                                className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                                onClick={() => openSpecEditorForTemplate(template.id)}
                                type="button"
                              >
                                編輯
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {menuSubTab === "items" ? (
              <div className="mt-4 flex flex-1 min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">菜品</div>
                    <div className="mt-1 text-xs text-slate-500">規格可直接選模板套用；需要微調再按「編輯」。</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                      onChange={(event) => {
                        setMenuCategoryId(event.target.value);
                        setMenuPage(1);
                      }}
                      value={menuCategoryId}
                    >
                      <option value="all">全部分類</option>
                      {menuDraft.categories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white"
                      onClick={() =>
                        setMenuDraft((current) => ({
                          ...current,
                          menuItems: [
                            ...current.menuItems,
                            {
                              id: crypto.randomUUID(),
                              categoryId: current.categories[0]?.id ?? "cat",
                              name: "新菜品",
                              price: 0,
                              printerGroup: localSettings.printZones[0]?.id ?? "kitchen",
                            },
                          ],
                        }))
                      }
                      type="button"
                    >
                      新增菜品
                    </button>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                  {(() => {
                    const filteredCount = menuFilteredItems.length;
                    const totalPages = menuTotalPages;
                    return (
                      <>
                        <div className="text-xs text-slate-500">
                          共 {filteredCount} 個菜品 · 第 {menuPage}/{totalPages} 頁（每頁 {menuPageSize}）
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 disabled:opacity-50"
                            disabled={menuPage <= 1}
                            onClick={() => setMenuPage((current) => Math.max(1, current - 1))}
                            type="button"
                          >
                            上一頁
                          </button>
                          <button
                            className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 disabled:opacity-50"
                            disabled={menuPage >= totalPages}
                            onClick={() => setMenuPage((current) => Math.min(totalPages, current + 1))}
                            type="button"
                          >
                            下一頁
                          </button>
                        </div>
                      </>
                    );
                  })()}
                </div>

                <div className="mt-2 flex-1 min-h-0 overflow-auto rounded-2xl border border-slate-200">
                  <table className="w-full border-collapse text-sm">
                    <thead className="sticky top-0 z-10 bg-white">
                      <tr className="text-left text-xs font-semibold text-slate-500">
                        <th className="border-b border-slate-200 py-2 pr-3">名稱</th>
                        <th className="border-b border-slate-200 py-2 pr-3">分類</th>
                        <th className="border-b border-slate-200 py-2 pr-3">價格</th>
                        <th className="border-b border-slate-200 py-2 pr-3">打印分區</th>
                        <th className="border-b border-slate-200 py-2">規格</th>
                      </tr>
                    </thead>
                    <tbody>
                      {menuPageItems.map((item) => {
                        const specKey = JSON.stringify(item.specGroups ?? []);
                        const matchedTemplateId =
                          localSettings.specTemplates.find((t) => JSON.stringify(t.specGroups ?? []) === specKey)?.id ??
                          "";
                        return (
                          <tr key={item.id} className="align-top">
                            <td className="border-b border-slate-100 py-2 pr-3">
                              <input
                                className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                onChange={(event) =>
                                  setMenuDraft((current) => ({
                                    ...current,
                                    menuItems: current.menuItems.map((row) =>
                                      row.id === item.id ? { ...row, name: event.target.value } : row,
                                    ),
                                  }))
                                }
                                value={item.name}
                              />
                            </td>
                            <td className="border-b border-slate-100 py-2 pr-3">
                              <select
                                className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                onChange={(event) =>
                                  setMenuDraft((current) => ({
                                    ...current,
                                    menuItems: current.menuItems.map((row) =>
                                      row.id === item.id ? { ...row, categoryId: event.target.value } : row,
                                    ),
                                  }))
                                }
                                value={item.categoryId}
                              >
                                {menuDraft.categories.map((category) => (
                                  <option key={category.id} value={category.id}>
                                    {category.name}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="border-b border-slate-100 py-2 pr-3">
                              <input
                                className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                inputMode="decimal"
                                onChange={(event) =>
                                  setMenuDraft((current) => ({
                                    ...current,
                                    menuItems: current.menuItems.map((row) =>
                                      row.id === item.id ? { ...row, price: Number(event.target.value) || 0 } : row,
                                    ),
                                  }))
                                }
                                value={String(item.price)}
                              />
                              <label className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                                <input
                                  checked={Boolean(item.isMarketPrice)}
                                  className="h-3.5 w-3.5 rounded border-slate-300"
                                  onChange={(event) =>
                                    setMenuDraft((current) => ({
                                      ...current,
                                      menuItems: current.menuItems.map((row) =>
                                        row.id === item.id
                                          ? { ...row, isMarketPrice: event.target.checked }
                                          : row,
                                      ),
                                    }))
                                  }
                                  type="checkbox"
                                />
                                時價菜（落單時改價）
                              </label>
                            </td>
                            <td className="border-b border-slate-100 py-2 pr-3">
                              <select
                                className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                onChange={(event) =>
                                  setMenuDraft((current) => ({
                                    ...current,
                                    menuItems: current.menuItems.map((row) =>
                                      row.id === item.id ? { ...row, printerGroup: event.target.value } : row,
                                    ),
                                  }))
                                }
                                value={item.printerGroup}
                              >
                                {localSettings.printZones.map((zone) => (
                                  <option key={zone.id} value={zone.id}>
                                    {zone.name}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="border-b border-slate-100 py-2 pr-3">
                              <div className="grid gap-2">
                                <div className="text-xs text-slate-500">{formatSpecGroupsSummary(item.specGroups)}</div>
                                <select
                                  className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                  onChange={(event) => {
                                    const templateId = event.target.value;
                                    if (!templateId) {
                                      setMenuDraft((current) => ({
                                        ...current,
                                        menuItems: current.menuItems.map((row) =>
                                          row.id === item.id ? { ...row, specGroups: undefined } : row,
                                        ),
                                      }));
                                      setStatus("已清空菜品規格，請保存菜單。");
                                      return;
                                    }
                                    const template =
                                      localSettings.specTemplates.find((t) => t.id === templateId) ?? null;
                                    if (!template) return;
                                    const nextSpec = cloneSpecGroups(template.specGroups);
                                    setMenuDraft((current) => ({
                                      ...current,
                                      menuItems: current.menuItems.map((row) =>
                                        row.id === item.id ? { ...row, specGroups: nextSpec } : row,
                                      ),
                                    }));
                                    setStatus(`已套用模板「${template.name}」，請保存菜單。`);
                                  }}
                                  value={matchedTemplateId}
                                >
                                  <option value="">無規格</option>
                                  {localSettings.specTemplates.map((template) => (
                                    <option key={template.id} value={template.id}>
                                      {template.name}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                                  onClick={() => openSpecEditorForItem(item.id, item.specGroups)}
                                  type="button"
                                >
                                  編輯
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {activeTab === "tables" ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-4 max-h-[calc(100dvh-150px)] flex flex-col overflow-hidden">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-base font-semibold text-slate-900">樓層與桌台</div>
                <div className="mt-1 text-sm text-slate-500">兩層結構：先樓層，再桌號。</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white"
                  onClick={() =>
                    setLocalSettings((current) => ({
                      ...current,
                      floors: [...current.floors, { id: crypto.randomUUID(), name: "新樓層", tables: [] }],
                    }))
                  }
                  type="button"
                >
                  新增樓層
                </button>
                <button
                  className="rounded-2xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white"
                  onClick={saveTablesLocal}
                  type="button"
                >
                  保存
                </button>
              </div>
            </div>

            <div className="mt-4 grid gap-3 overflow-auto pr-1 flex-1">
              {localSettings.floors.map((floor) => (
                <article key={floor.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <input
                      className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900"
                      onChange={(event) =>
                        setLocalSettings((current) => ({
                          ...current,
                          floors: current.floors.map((item) =>
                            item.id === floor.id ? { ...item, name: event.target.value } : item,
                          ),
                        }))
                      }
                      value={floor.name}
                    />
                    <button
                      className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                      onClick={() =>
                        setLocalSettings((current) => ({
                          ...current,
                          floors: current.floors.map((item) =>
                            item.id === floor.id
                              ? {
                                  ...item,
                                  tables: [
                                    ...item.tables,
                                    { id: crypto.randomUUID(), name: `桌號${item.tables.length + 1}`, area: item.name, floorId: item.id },
                                  ],
                                }
                              : item,
                          ),
                        }))
                      }
                      type="button"
                    >
                      新增桌子
                    </button>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
                    {floor.tables.map((table) => (
                      <input
                        key={table.id}
                        className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm font-semibold text-slate-900"
                        onChange={(event) =>
                          setLocalSettings((current) => ({
                            ...current,
                            floors: current.floors.map((item) =>
                              item.id === floor.id
                                ? {
                                    ...item,
                                    tables: item.tables.map((currentTable) =>
                                      currentTable.id === table.id
                                        ? { ...currentTable, name: event.target.value, area: item.name }
                                        : currentTable,
                                    ),
                                  }
                                : item,
                            ),
                          }))
                        }
                        value={table.name}
                      />
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}


        {activeTab === "payments" ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-4 max-h-[calc(100dvh-150px)] flex flex-col overflow-hidden">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-base font-semibold text-slate-900">支付方式</div>
                <div className="mt-1 text-sm text-slate-500">自由文字方式，會記錄到交易裡。預設：現金、Mpay、中銀。</div>
              </div>
              <button
                className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white"
                onClick={() =>
                  setLocalSettings((current) => ({
                    ...current,
                    paymentMethods: [...current.paymentMethods, "新支付方式"],
                  }))
                }
                type="button"
              >
                新增支付方式
              </button>
            </div>
            <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3 overflow-auto pr-1 flex-1">
              {localSettings.paymentMethods.map((method, index) => (
                <input
                  key={`${method}-${index}`}
                  className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-900"
                  onChange={(event) =>
                    setLocalSettings((current) => ({
                      ...current,
                      paymentMethods: current.paymentMethods.map((item, itemIndex) =>
                        itemIndex === index ? event.target.value : item,
                      ),
                    }))
                  }
                  value={method}
                />
              ))}
            </div>

            <div className="mt-4 flex justify-end gap-2 border-t border-slate-100 pt-4">
              <button
                className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                onClick={saveLocal}
                type="button"
              >
                只保存到本機
              </button>
              <button
                className="rounded-2xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white"
                aria-busy={syncingConfig}
                disabled={syncingConfig}
                onClick={syncConfig}
                type="button"
              >
                {syncingConfig ? "同步中…" : "保存並同步後台"}
              </button>
            </div>
          </section>
        ) : null}

        {ledgerImportOpen && ledgerImportPreview ? (
          <ResponsiveModal
            actions={
              <>
                <button
                  className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                  disabled={ledgerImportApplying}
                  onClick={() => {
                    setLedgerImportOpen(false);
                    setLedgerMenuPending(null);
                    setLedgerImportPreview(null);
                    setLedgerImportRemoveLocal(false);
                    setLedgerImportError(null);
                  }}
                  type="button"
                >
                  取消
                </button>
                <button
                  className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  aria-busy={ledgerImportApplying}
                  disabled={ledgerImportApplying}
                  onClick={() => void applyLedgerMenuImport()}
                  type="button"
                >
                  {ledgerImportApplying ? "匯入中…" : "確認匯入"}
                </button>
              </>
            }
            description={
              ledgerImportRemoveLocal
                ? "將以 Ledger 線上菜單為主：本地自建分類／菜品會被刪除。匯入後請再按「保存菜單」。"
                : "合併 Ledger 線上菜品至本機草稿，本地自建菜品會保留。匯入後請再按「保存菜單」。"
            }
            onClose={() => {
              if (ledgerImportApplying) return;
              setLedgerImportOpen(false);
              setLedgerMenuPending(null);
              setLedgerImportPreview(null);
              setLedgerImportRemoveLocal(false);
              setLedgerImportError(null);
            }}
            title="從 Ledger 參考匯入菜單"
            widthClassName="max-w-lg"
          >
            <div className="grid gap-3 text-sm text-slate-700">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                Ledger 線上：{ledgerImportPreview.ledgerCategoryCount} 個分類、
                {ledgerImportPreview.ledgerProductCount} 個菜品
                {ledgerImportPreview.openNow ? " · 現正營業" : " · 非營業時段"}
              </div>
              <div
                className={`rounded-xl border px-3 py-2 ${
                  ledgerImportPreview.specOptionsWithPrice > 0
                    ? "border-emerald-200 bg-emerald-50/60 text-emerald-900"
                    : "border-amber-200 bg-amber-50/60 text-amber-900"
                }`}
              >
                <div className="text-xs font-semibold">
                  規格加價：{ledgerImportPreview.specOptionsWithPrice} 個選項有加價
                </div>
                {ledgerImportPreview.specPriceSample ? (
                  <div className="mt-1 text-xs">範例：{ledgerImportPreview.specPriceSample}</div>
                ) : (
                  <div className="mt-1 text-xs">
                    解析結果為 0 個加價選項；若 Ledger 後台有加價，請確認已部署最新版 POS 後再匯入。
                  </div>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 px-3 py-2">
                  <div className="text-xs text-slate-500">新增菜品</div>
                  <div className="text-xl font-semibold text-slate-900">{ledgerImportPreview.itemsAdded}</div>
                </div>
                <div className="rounded-xl border border-blue-100 bg-blue-50/60 px-3 py-2">
                  <div className="text-xs text-slate-500">更新菜品</div>
                  <div className="text-xl font-semibold text-slate-900">{ledgerImportPreview.itemsUpdated}</div>
                </div>
                <div className="rounded-xl border border-amber-100 bg-amber-50/60 px-3 py-2">
                  <div className="text-xs text-slate-500">Ledger 售罄</div>
                  <div className="text-xl font-semibold text-slate-900">{ledgerImportPreview.soldOutCount}</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                  <div className="text-xs text-slate-500">分類新增／更新</div>
                  <div className="text-xl font-semibold text-slate-900">
                    {ledgerImportPreview.categoriesAdded} / {ledgerImportPreview.categoriesUpdated}
                  </div>
                </div>
              </div>

              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-white px-3 py-3">
                <input
                  checked={ledgerImportRemoveLocal}
                  className="mt-1 h-4 w-4 rounded border-slate-300 text-orange-500 focus:ring-orange-500"
                  onChange={(event) => {
                    const removeLocalMenu = event.target.checked;
                    setLedgerImportRemoveLocal(removeLocalMenu);
                    if (ledgerMenuPending) {
                      setLedgerImportPreview(
                        previewLedgerMenuImport(menuDraft, ledgerMenuPending, { removeLocalMenu }),
                      );
                    }
                  }}
                  type="checkbox"
                />
                <span className="min-w-0">
                  <span className="block font-semibold text-slate-900">刪除本地自建菜單</span>
                  <span className="mt-1 block text-xs text-slate-500">
                    勾選後會移除目前 {ledgerImportPreview.localCategoryCount} 個本地分類、
                    {ledgerImportPreview.localItemCount} 個本地菜品（不含先前已匯入的{" "}
                    <code className="rounded bg-slate-100 px-1">ledger-</code> 菜品），改以 Ledger 為準。
                  </span>
                </span>
              </label>

              {ledgerImportRemoveLocal ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                  將刪除本地 {ledgerImportPreview.localCategoriesRemoved} 分類、
                  {ledgerImportPreview.localItemsRemoved} 菜品；此操作在確認匯入後生效，且需再保存菜單才會寫入後台。
                </div>
              ) : null}

              <p className="text-xs text-slate-500">
                匯入的 Ledger 菜品 ID 會帶 <code className="rounded bg-slate-100 px-1">ledger-</code> 前綴，方便與線上訂單對照；打印分區沿用既有設定（新菜默認 kitchen）。
              </p>
              {ledgerImportError ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-red-800">{ledgerImportError}</div>
              ) : null}
            </div>
          </ResponsiveModal>
        ) : null}

        {specEditor.open ? (
          <ResponsiveModal
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                  onClick={() =>
                    setSpecEditor((current) => ({
                      ...current,
                      draft: [
                        ...current.draft,
                        {
                          id: crypto.randomUUID(),
                          name: "新規格",
                          selectionMode: "single",
                          required: true,
                          options: [{ id: crypto.randomUUID(), label: "新選項", priceDelta: 0 }],
                        },
                      ],
                    }))
                  }
                  type="button"
                >
                  新增規格組
                </button>

                {specEditor.mode === "template" ? (
                  <>
                    {specEditor.templateId ? (
                      <button
                        className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                        onClick={() => {
                          const next = {
                            ...localSettings,
                            specTemplates: localSettings.specTemplates.filter((template) => template.id !== specEditor.templateId),
                          };
                          setLocalSettings(next);
                          if (selectedTemplateId === specEditor.templateId) {
                            setSelectedTemplateId(next.specTemplates[0]?.id ?? "");
                          }
                          savePosLocalSettings(next);
                          closeSpecEditor();
                          setStatus("已刪除規格模板。");
                        }}
                        type="button"
                      >
                        刪除模板
                      </button>
                    ) : null}
                    <button
                      className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                      onClick={() => {
                        const templateId = specEditor.templateId ?? crypto.randomUUID();
                        const templateName = specEditor.templateName.trim() || "未命名模板";
                        const nextTemplate = {
                          id: templateId,
                          name: templateName,
                          specGroups: cloneSpecGroups(specEditor.draft),
                        };
                        const next = {
                          ...localSettings,
                          specTemplates: localSettings.specTemplates.some((template) => template.id === templateId)
                            ? localSettings.specTemplates.map((template) => (template.id === templateId ? nextTemplate : template))
                            : [...localSettings.specTemplates, nextTemplate],
                        };
                        setLocalSettings(next);
                        setSelectedTemplateId(templateId);
                        savePosLocalSettings(next);
                        closeSpecEditor();
                        setStatus(`已保存規格模板「${templateName}」。`);
                      }}
                      type="button"
                    >
                      保存模板
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                      onClick={() => {
                        const templateName = `模板 ${localSettings.specTemplates.length + 1}`;
                        const next = {
                          ...localSettings,
                          specTemplates: [
                            ...localSettings.specTemplates,
                            {
                              id: crypto.randomUUID(),
                              name: templateName,
                              specGroups: cloneSpecGroups(specEditor.draft),
                            },
                          ],
                        };
                        setLocalSettings(next);
                        savePosLocalSettings(next);
                        setStatus(`已另存為規格模板「${templateName}」。`);
                      }}
                      type="button"
                    >
                      另存為模板
                    </button>
                    <button
                      className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                      onClick={() => {
                        if (!specEditor.itemId) return;
                        const nextSpec = specEditor.draft.length ? cloneSpecGroups(specEditor.draft) : undefined;
                        setMenuDraft((current) => ({
                          ...current,
                          menuItems: current.menuItems.map((item) =>
                            item.id === specEditor.itemId ? { ...item, specGroups: nextSpec } : item,
                          ),
                        }));
                        closeSpecEditor();
                        setStatus("已更新菜品規格，請保存菜單。");
                      }}
                      type="button"
                    >
                      保存到當前菜品
                    </button>
                    <button
                      className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                      onClick={() => {
                        const nextSpec = specEditor.draft.length ? cloneSpecGroups(specEditor.draft) : undefined;
                        setMenuDraft((current) => ({
                          ...current,
                          menuItems: current.menuItems.map((item) =>
                            menuPageItems.some((row) => row.id === item.id) ? { ...item, specGroups: nextSpec } : item,
                          ),
                        }));
                        closeSpecEditor();
                        setStatus("已批量套用規格到本頁菜品，請保存菜單。");
                      }}
                      type="button"
                    >
                      套用到本頁
                    </button>
                  </>
                )}
              </div>
            }
            bodyClassName="grid gap-4"
            description="超出畫面時可滾動查看全部內容，支持保存為模板。"
            onClose={closeSpecEditor}
            title={specEditor.mode === "template" ? "編輯規格模板" : "編輯規格"}
            widthClassName="max-w-4xl"
          >
              {specEditor.mode === "template" ? (
                <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <label className="grid gap-1 text-sm font-semibold text-slate-700">
                    <span className="text-xs text-slate-500">模板名稱</span>
                    <input
                      className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                      onChange={(event) =>
                        setSpecEditor((current) => ({
                          ...current,
                          templateName: event.target.value,
                        }))
                      }
                      placeholder="例如：飲品通用規格"
                      value={specEditor.templateName}
                    />
                  </label>
                </div>
              ) : (
                <div className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <select
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    onChange={(event) => setSelectedTemplateId(event.target.value)}
                    value={selectedTemplateId}
                  >
                    <option value="">從模板載入</option>
                    {localSettings.specTemplates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="rounded-2xl bg-white px-3 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 disabled:opacity-50"
                    disabled={!selectedSpecTemplate}
                    onClick={() =>
                      selectedSpecTemplate
                        ? setSpecEditor((current) => ({
                            ...current,
                            draft: cloneSpecGroups(selectedSpecTemplate.specGroups),
                          }))
                        : null
                    }
                    type="button"
                  >
                    載入模板
                  </button>
                  <button
                    className="rounded-2xl bg-white px-3 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                    onClick={() => openSpecEditorForTemplate()}
                    type="button"
                  >
                    新建模板
                  </button>
                </div>
              )}

              <div className="grid gap-3">
                  {specEditor.draft.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                      尚未有規格組。你可以按下方「新增規格組」開始。
                    </div>
                  ) : (
                    specEditor.draft.map((group) => (
                      <div key={group.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              className="w-[180px] rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900"
                              onChange={(event) =>
                                setSpecEditor((current) => ({
                                  ...current,
                                  draft: current.draft.map((row) =>
                                    row.id === group.id ? { ...row, name: event.target.value } : row,
                                  ),
                                }))
                              }
                              placeholder="規格名（例如：甜度）"
                              value={group.name}
                            />
                            <select
                              className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                              onChange={(event) =>
                                setSpecEditor((current) => ({
                                  ...current,
                                  draft: current.draft.map((row) =>
                                    row.id === group.id
                                      ? { ...row, selectionMode: event.target.value as MenuSpecGroup["selectionMode"] }
                                      : row,
                                  ),
                                }))
                              }
                              value={group.selectionMode}
                            >
                              <option value="single">單選</option>
                              <option value="multi">多選</option>
                            </select>
                            <label className="flex items-center gap-2 text-sm text-slate-700">
                              <input
                                checked={group.required}
                                onChange={(event) =>
                                  setSpecEditor((current) => ({
                                    ...current,
                                    draft: current.draft.map((row) =>
                                      row.id === group.id ? { ...row, required: event.target.checked } : row,
                                    ),
                                  }))
                                }
                                type="checkbox"
                              />
                              必選
                            </label>
                          </div>
                          <button
                            className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                            onClick={() =>
                              setSpecEditor((current) => ({
                                ...current,
                                draft: current.draft.filter((row) => row.id !== group.id),
                              }))
                            }
                            type="button"
                          >
                            刪除規格組
                          </button>
                        </div>

                        <div className="mt-3 grid gap-2">
                          {group.options.map((opt) => (
                            <div key={opt.id} className="grid gap-2 md:grid-cols-[minmax(0,1fr)_120px_80px]">
                              <input
                                className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                onChange={(event) =>
                                  setSpecEditor((current) => ({
                                    ...current,
                                    draft: current.draft.map((row) =>
                                      row.id !== group.id
                                        ? row
                                        : {
                                            ...row,
                                            options: row.options.map((o) =>
                                              o.id === opt.id ? { ...o, label: event.target.value } : o,
                                            ),
                                          },
                                    ),
                                  }))
                                }
                                placeholder="選項（例如：少冰）"
                                value={opt.label}
                              />
                              <input
                                className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                onChange={(event) =>
                                  setSpecEditor((current) => ({
                                    ...current,
                                    draft: current.draft.map((row) =>
                                      row.id !== group.id
                                        ? row
                                        : {
                                            ...row,
                                            options: row.options.map((o) =>
                                              o.id === opt.id ? { ...o, priceDelta: Number(event.target.value) || 0 } : o,
                                            ),
                                          },
                                    ),
                                  }))
                                }
                                placeholder="加價"
                                type="number"
                                value={String(opt.priceDelta)}
                              />
                              <button
                                className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                                onClick={() =>
                                  setSpecEditor((current) => ({
                                    ...current,
                                    draft: current.draft.map((row) =>
                                      row.id !== group.id
                                        ? row
                                        : { ...row, options: row.options.filter((o) => o.id !== opt.id) },
                                    ),
                                  }))
                                }
                                type="button"
                              >
                                刪除
                              </button>
                            </div>
                          ))}
                        </div>

                        <button
                          className="mt-3 rounded-2xl bg-orange-500 px-3 py-2 text-xs font-semibold text-white"
                          onClick={() =>
                            setSpecEditor((current) => ({
                              ...current,
                              draft: current.draft.map((row) =>
                                row.id !== group.id
                                  ? row
                                  : {
                                      ...row,
                                      options: [...row.options, { id: crypto.randomUUID(), label: "新選項", priceDelta: 0 }],
                                    },
                              ),
                            }))
                          }
                          type="button"
                        >
                          新增選項
                        </button>
                      </div>
                    ))
                  )}
              </div>
          </ResponsiveModal>
        ) : null}
        </div>
      </div>
    </div>
  );
}
