"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { KioskModePanel } from "@/components/kiosk-mode-panel";
import { ScanModePanel } from "@/components/scan-mode-panel";
import { ResponsiveModal } from "@/components/responsive-modal";
import { RelayPairingPanel } from "@/components/relay-pairing-panel";
import { defaultDeviceConfig, defaultPosLocalSettings, mockBootstrap } from "@/lib/mock-data";
import {
  loadAuthSession,
  loadBootstrapCache,
  loadDeviceConfig,
  loadOrders,
  loadPosLocalSettings,
  loadQueue,
  loadNotePresetSyncMeta,
  loadSoldOutState,
  normalizeDeviceConfig,
  saveBootstrapCache,
  saveDeviceConfig,
  saveNotePresetSyncMeta,
  savePosLocalSettings,
  saveQueue,
  saveSoldOutState,
} from "@/lib/storage";
import { DeviceConfig, DevicePrinterConfig, DiscountPreset, MenuItem, MenuSpecGroup, PosBootstrap, PosLocalSettings, PrintContentToggles, PrintJob, PrintKind, QueueEvent } from "@/lib/types";
import { enqueueEvents, isOutboxV2Enabled } from "@/lib/pos/queue-outbox";
import { withStoreScope } from "@/lib/pos/sync-flush";
import { newDiscountId } from "@/lib/pos/discount";
import { normalizeBootstrapPayload } from "@/lib/bootstrap-normalizer";
import { filterReopenTempTables, isReopenTempTable, stripReopenTempTables } from "@/lib/pos/table-scope";
import { fetchLedgerOrderMenu, LedgerOrderMenu } from "@/lib/ledger/menu";
import {
  LedgerMenuImportPreview,
  mergeLedgerMenuReference,
  previewLedgerMenuImport,
} from "@/lib/ledger/menu-import";
import { formatSpecGroupsSummary } from "@/lib/ledger/menu-spec";
import { restoreLedgerSession } from "@/lib/ledger/session";
import { PrinterCardV2, PrinterEmptyState } from "@/components/printer-card-v2";
import { PrinterWizardModal } from "@/components/printer-wizard-modal";
import { CompanionStatusCard } from "@/components/printer-companion-panel";
import { AutoAcceptPill } from "@/components/auto-accept-pill";
import {
  isCompanionConfigured,
  sendJobToCompanion,
  shouldKeepCompanionAlive,
  tryAutoPairCompanion,
} from "@/lib/print-bridge/companion";
import { dispatchJobToNative, isNativeBridgeAvailable } from "@/lib/print-bridge/native";
import { getRelayTransport, isRelayConfigured } from "@/lib/print-bridge/relay-config";
import { posDeviceAuthHeadersFresh } from "@/lib/pos/pos-sync-auth";

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function cloneSpecGroups(specGroups?: MenuSpecGroup[]) {
  return specGroups ? (JSON.parse(JSON.stringify(specGroups)) as MenuSpecGroup[]) : [];
}

export function DeviceSettings() {
  const cachedConfig = loadDeviceConfig();
  const cachedLocalSettings = loadPosLocalSettings();
  const cachedBootstrap = loadBootstrapCache() ?? mockBootstrap;
  const [config, setConfig] = useState<DeviceConfig>(cachedConfig ?? defaultDeviceConfig);
  const [localSettings, setLocalSettings] = useState<PosLocalSettings>(cachedLocalSettings ?? defaultPosLocalSettings);
  const [status, setStatus] = useState(cachedConfig ? "已載入本機設定。" : "尚未同步設定。");

  const [activeTab, setActiveTab] = useState<
    "device" | "menu-print" | "menu" | "tables" | "payments" | "online-orders" | "notes" | "discounts" | "kiosk"
  >("device");
  const [menuDraft, setMenuDraft] = useState(() => normalizeBootstrapPayload(cachedBootstrap));
  const [menuSaving, setMenuSaving] = useState(false);
  const [ledgerImportOpen, setLedgerImportOpen] = useState(false);
  const [ledgerImportLoading, setLedgerImportLoading] = useState(false);
  const [ledgerImportApplying, setLedgerImportApplying] = useState(false);
  const [ledgerImportPreview, setLedgerImportPreview] = useState<LedgerMenuImportPreview | null>(null);
  const [ledgerMenuPending, setLedgerMenuPending] = useState<LedgerOrderMenu | null>(null);
  const [ledgerImportRemoveLocal, setLedgerImportRemoveLocal] = useState(false);
  const [ledgerImportError, setLedgerImportError] = useState<string | null>(null);
  const [syncingConfig, setSyncingConfig] = useState(false);
  const [testingPrinterId, setTestingPrinterId] = useState<string | null>(null);

  const [menuSubTab, setMenuSubTab] = useState<"categories" | "specs" | "items">("items");
  const [specEditor, setSpecEditor] = useState<{
    open: boolean;
    mode: "item" | "template" | "group";
    itemId: string | null;
    templateId: string | null;
    templateName: string;
    draft: MenuSpecGroup[];
  }>({ open: false, mode: "item", itemId: null, templateId: null, templateName: "", draft: [] });
  // 新增菜品彈窗（2026-09-09）：之前「新增菜品」掣只係默默 append「新菜品」落 draft，
  // 分類過濾器開住時新筆 categoryId 用 categories[0]、同過濾器唔符 → 列表睇唔到，
  // 兼要再手動撳「保存菜單」先落 server → 對用戶嚟講等於「冇反應」。
  // 而家改為彈窗填全欄位（觸控大控件）＋驗證＋保存即寫 server＋列表即時跳去新筆。
  const [menuItemModal, setMenuItemModal] = useState<
    | ({

        name: string;
        categoryId: string;
        price: string;
        printerGroup: string;
        isMarketPrice: boolean;
        customerOrderable: boolean;
        discountRate: string;
        originalPrice: string;
        image: string;
        specGroups: MenuSpecGroup[];
      } & { open: boolean })
    | null
  >(null);
  const [menuItemSaving, setMenuItemSaving] = useState(false);
  const [menuItemError, setMenuItemError] = useState<string | null>(null);
  // 快捷新增規格（2026-09-09）：喺「新增菜品」彈窗內直接建立新規格組，唔使跳去「規格管理」。
  // 保存時自動存入 localSettings.standaloneSpecGroups（= 規格管理 › 獨立規格）並推 server，
  // 同時加入目前新增菜品嘅 specGroups —— 兩邊數據同步一致、日後其他菜品可復用。
  const [quickSpecDraft, setQuickSpecDraft] = useState<MenuSpecGroup | null>(null);
  const [quickSpecError, setQuickSpecError] = useState<string | null>(null);
  const [bulkSelectedMenuIds, setBulkSelectedMenuIds] = useState<string[]>([]);
  const [bulkPrinterGroup, setBulkPrinterGroup] = useState<string>(cachedLocalSettings?.printZones?.[0]?.id ?? "kitchen");
  const [menuPrintCategoryId, setMenuPrintCategoryId] = useState<string>("all");
  const [menuPrintPage, setMenuPrintPage] = useState(1);
  const menuPrintPageSize = 50;
  const [menuCategoryId, setMenuCategoryId] = useState<string>("all");
  // 菜品即時搜尋（2026-09-09）：輸入即篩，唔使撳掣；子字串比對
  const [menuSearch, setMenuSearch] = useState("");
  const [menuPage, setMenuPage] = useState(1);
  const menuPageSize = 50;
  const [newNotePreset, setNewNotePreset] = useState("");
  const [newPrintZoneName, setNewPrintZoneName] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(cachedLocalSettings?.specTemplates?.[0]?.id ?? "");
  const [devicePrinterTab, setDevicePrinterTab] = useState<"zones" | "printers">("zones");
  const [printerWizardOpen, setPrinterWizardOpen] = useState(false);
  // 桌台刪除 tombstone（2026-09-09）：session 級「已刪枱 id」清單。
  // saveTablesLocal 嘅 merge 會保留「bootstrap 獨有」枱——被刪嘅枱喺按「保存」推上
  // server（pos_bootstrap_config）＋更新本地 bootstrap cache 之前，仍然存在嗰兩處；
  // 冇 tombstone 嘅話 merge 會即場將佢復活，刪除永遠無效（「桌台刪唔走」根因之一）。
  const [deletedTableIds, setDeletedTableIds] = useState<Set<string>>(() => new Set());
  const [newCancelNotePreset, setNewCancelNotePreset] = useState("");
  const [newCompNotePreset, setNewCompNotePreset] = useState("");
  const [newReopenReason, setNewReopenReason] = useState("");
  const [newDiscountLabel, setNewDiscountLabel] = useState("");
  const [newDiscountRate, setNewDiscountRate] = useState("");

  const menuFilteredItems = useMemo(() => {
    const keyword = menuSearch.trim().toLocaleLowerCase();
    return menuDraft.menuItems.filter((item) => {
      // 分類過濾 + 關鍵字子字串比對（大小寫不敏感，空白關鍵字 = 不過濾）
      if (menuCategoryId !== "all" && item.categoryId !== menuCategoryId) return false;
      if (keyword && !item.name.toLocaleLowerCase().includes(keyword)) return false;
      return true;
    });
  }, [menuDraft.menuItems, menuCategoryId, menuSearch]);

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

  // 新 device 初始化（2026-09-08 修 localSettings；2026-09-09 修 deviceConfig/打印機）：
  // 本地未有設定時，先由 DB（該店最新 device config）讀返已保存嘅打印機／樓層桌台等
  // 設定；DB 空／離線／冇登入店 → 打印機列表留空（defaultDeviceConfig.printers 已改空），
  // 樓層桌台維持 fallback defaultPosLocalSettings。
  // 舊行為會即刻 saveDeviceConfig(defaultDeviceConfig)，令新 iPad 一開設定頁就出現
  // 4 台 mock 打印機——呢個 pre-seed 已刪除，打印機設定只可以由 DB 或用家手動添加。
  useEffect(() => {
    let cancelled = false;
    const needDeviceConfig = !cachedConfig;
    const needLocalSettings = !cachedLocalSettings;
    async function adoptSettingsFromDb() {
      const storeId = loadAuthSession()?.merchantId;
      let adoptedFromDb = false;
      if (storeId && (needDeviceConfig || needLocalSettings)) {
        try {
          const res = await fetch(`/api/pos/device-config?storeId=${encodeURIComponent(storeId)}`);
          const payload = (await res.json()) as {
            ok?: boolean;
            deviceConfig?: DeviceConfig | null;
            localSettings?: PosLocalSettings | null;
          };
          if (payload.ok && !cancelled) {
            // 打印機等設備設定：本地未有 → 採用雲端（route 已 normalize）
            if (needDeviceConfig && payload.deviceConfig) {
              const remote = normalizeDeviceConfig(payload.deviceConfig);
              if (remote) {
                saveDeviceConfig(remote);
                setConfig(remote);
                adoptedFromDb = true;
              }
            }
            // 樓層桌台：本地未有 → 採用雲端 local_settings
            if (needLocalSettings && payload.localSettings) {
              savePosLocalSettings(payload.localSettings);
              setLocalSettings(payload.localSettings);
              adoptedFromDb = true;
            }
          }
        } catch {
          // 離線 / fetch 失敗 → 落到底下 fallback
        }
      }
      if (cancelled) return;
      // localSettings 冇雲端數據先 fallback default（樓層桌台等，維持 2026-09-08 決定）；
      // deviceConfig 冇雲端數據就唔會 save 任何嘢——列表留空，唔好填充 mock。
      if (needLocalSettings && !loadPosLocalSettings()) {
        savePosLocalSettings(defaultPosLocalSettings);
        setLocalSettings(defaultPosLocalSettings);
      }
      if (adoptedFromDb) {
        setStatus("已從雲端載入本店已保存設定。");
      }
    }
    void adoptSettingsFromDb();
    return () => {
      cancelled = true;
    };
  }, [cachedConfig, cachedLocalSettings]);

  // 登入後自動取得 storeId 並寫入 config（取代以前手動輸入「門店 ID」）
  useEffect(() => {
    const auth = loadAuthSession();
    if (auth?.merchantId && config.storeId !== auth.merchantId) {
      const next = { ...config, storeId: auth.merchantId };
      setConfig(next);
      saveDeviceConfig(next);
    }
    // 自動填入設備 ID（如果本機仲係預設值）
    if (auth?.merchantId && (config.deviceId === "tablet-01" || !config.deviceId)) {
      const newDeviceId = `${auth.merchantId.slice(0, 8)}-${Date.now().toString(36)}`;
      const next = { ...config, deviceId: newDeviceId, storeId: auth.merchantId };
      setConfig(next);
      saveDeviceConfig(next);
    }
  }, []);

  useEffect(() => {
    void tryAutoPairCompanion();
  }, []);

  // ── 桌台刪除（2026-09-09）──
  // 之前完全冇刪除入口；就算手動刪，saveTablesLocal 嘅「bootstrap 獨有枱保留」merge
  // 都會令被刪嘅枱復活。所以刪除要做三件事：
  // ① 關聯資料防護：有進行中訂單嘅枱唔畀刪（否則訂單懸空——枱面總覽 map 唔返、
  //    結帳搵唔到枱）。已結帳／退款嘅歷史單唔阻刪除，訂單內 tableId 只係歷史快照。
  // ② 本地 localSettings.floors 即時移除（draft，按「保存」先真正落 localStorage）。
  // ③ 記入 tombstone，等 saveTablesLocal 嘅 merge 唔會由 bootstrap 復活。
  const ACTIVE_TABLE_ORDER_STATUSES = new Set<string>(["draft", "sent_to_kitchen", "paid", "reopened"]);

  function removeTable(floorId: string, tableId: string) {
    const floor = localSettings.floors.find((item) => item.id === floorId);
    const table = floor?.tables.find((item) => item.id === tableId);
    if (!table) return;
    const activeCount = loadOrders().filter(
      (order) => order.tableId === tableId && ACTIVE_TABLE_ORDER_STATUSES.has(order.status),
    ).length;
    if (activeCount > 0) {
      setStatus(`無法刪除「${table.name}」：這張桌有 ${activeCount} 張進行中訂單，請先結帳或取消訂單。`);
      return;
    }
    setLocalSettings((current) => ({
      ...current,
      floors: current.floors.map((item) =>
        item.id === floorId ? { ...item, tables: item.tables.filter((t) => t.id !== tableId) } : item,
      ),
    }));
    setDeletedTableIds((current) => new Set(current).add(tableId));
    setStatus(`已刪除桌子「${table.name}」。按「保存」後會同步刪走掃碼區與其他設備的共享桌台。`);
  }

  async function saveTablesLocal() {
    // 同步「樓層與桌台」嘅枱去 bootstrap.tables（掃碼區 QR / 手機 / kiosk 讀嘅共享真源），
    // 唔好只留喺 localSettings.floors。用 merge（本地枱優先、bootstrap 獨有枱保留），
    // 避免覆蓋式寫入誤刪 DB 已有嘅枱（例如舊 store 嘅枱只喺 bootstrap.tables）。
    //
    // ⚠️ 必須剝走返結 temp 枱（`isReopenTemp`）：temp 枱只喺「返結單編輯期間」存在
    // （`createReopenTempTable` 建立、`removeReopenTempTable` 喺結帳／取消後清除），
    // 一旦寫入 bootstrap.tables 就**永久升級做真實枱**——kiosk / 掃碼落單 / 其他 terminal
    // 全部會讀到一張會無端消失嘅枱。呢個係「返結後多咗張真實枱」嘅根因。
    //
    // `cached.tables` 都要 filter：修復前漏咗上 bootstrap 嘅 temp 枱要喺呢度 self-healing
    // 清走，否則下面 `cached.tables.filter((t) => !localIds.has(t.id))` 會由 bootstrap
    // 嗰邊**復活**返佢（localIds 已經唔包 temp 枱 id）。用戶撳一次保存即自動清舊污染。
    const localTables = filterReopenTempTables(localSettings.floors.flatMap((floor) => floor.tables));
    const localIds = new Set(localTables.map((t) => t.id));
    const cached = loadBootstrapCache();
    if (cached) {
      // tombstone（deletedTableIds）：被用戶刪除嘅枱喺 push 前仍在 bootstrap cache／
      // server，merge 時必須扣走，否則「bootstrap 獨有枱保留」會令刪除即場復活。
      const mergedTables = [
        ...localTables,
        ...filterReopenTempTables(cached.tables).filter(
          (t) => !localIds.has(t.id) && !deletedTableIds.has(t.id),
        ),
      ];
      const mergedBootstrap: PosBootstrap = { ...cached, tables: mergedTables };
      saveBootstrapCache(mergedBootstrap);
      setMenuDraft((current) => (current ? { ...current, tables: mergedTables } : current));
      // 推去 server bootstrap（pos_bootstrap_config）：確保每次啟動 fetch 到最新枱樓層，唔會永遠舊版；
      // kiosk / 掃碼落單讀 server bootstrap 亦見到正確樓層。離線就本地先存，下次有網再 push。
      try {
        // 2026-09-10 P3-5：上傳餐牌 / 桌台需要 POS 終端憑證。
        // ⚠️ 用 Fresh 版先續期：token TTL 12h，過夜之後舊 token 會被 server 判 401
        // （POST /api/pos/bootstrap 係「未經授權：需要 POS 終端憑證。」）。
        const authHeaders = await posDeviceAuthHeadersFresh();
        await fetch("/api/pos/bootstrap", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            storeId: mergedBootstrap.storeId,
            storeName: mergedBootstrap.storeName,
            currency: mergedBootstrap.currency,
            categories: mergedBootstrap.categories,
            menuItems: mergedBootstrap.menuItems,
            tables: mergedTables,
            rules: mergedBootstrap.rules,
            printerGroups: mergedBootstrap.printerGroups,
          }),
        });
      } catch {
        // 離線：本地已存，bootstrapApp 嘅 merge 會保留本地編輯直到下次成功 push
      }
    }
    savePosLocalSettings(localSettings);
    setStatus("已保存樓層與桌台，並同步至掃碼區與後台（啟動時自動載入最新版本）。");
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
      // 匯入後自動保存菜單到後台，唔使再手動撳「保存菜單」
      const saved = await saveMenuToBackend(normalizedBootstrap);
      const removedNote =
        stats.localItemsRemoved > 0 || stats.localCategoriesRemoved > 0
          ? `；已刪除本地 ${stats.localCategoriesRemoved} 分類、${stats.localItemsRemoved} 菜品`
          : "";
      setStatus(
        `已從 Ledger 參考匯入：${stats.ledgerCategoryCount} 分類、${stats.ledgerProductCount} 菜品（新增 ${stats.itemsAdded}、更新 ${stats.itemsUpdated}）；同步售罄 ${stats.soldOutCount} 項${removedNote}${saved ? "，已自動保存菜單到後台。" : "，但菜單保存失敗，請手動撳「保存菜單」。"}`,
      );
    } catch (err) {
      setLedgerImportError(err instanceof Error ? err.message : "匯入失敗。");
    } finally {
      setLedgerImportApplying(false);
    }
  }

  async function saveMenuToBackend(draft: ReturnType<typeof normalizeBootstrapPayload>) {
    if (!draft) return false;
    setMenuSaving(true);
    setStatus("正在保存菜單到後台…");
    try {
      const authHeaders = await posDeviceAuthHeadersFresh();
      await fetch("/api/pos/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          storeId: draft.storeId,
          storeName: draft.storeName,
          currency: draft.currency,
          categories: draft.categories,
          menuItems: draft.menuItems,
          tables: draft.tables,
          rules: draft.rules,
          printerGroups: draft.printerGroups,
        }),
      });
      saveBootstrapCache(draft);
      setStatus("菜單已保存到後台。");
      return true;
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "菜單保存失敗，請稍後再試。");
      return false;
    } finally {
      setMenuSaving(false);
    }
  }

  // ⚠️ 2026-08-31 移除（docs/92 §1.2）：原本呢度有一段 mount GET `/api/online-order-settings`
  // 去「同步」自動接單設定，但**每個分支都 `return current`** —— server 返嚟嘅值從來冇被採用過，
  // 係死 code。更慘嘅係佢畀咗人錯覺「有做同步」，結果 Ledger 改咗 POS 完全唔會顯示。
  //
  // 而家統一由 `useOnlineOrderSettings()`（src/lib/pos/use-online-order-settings.ts）負責：
  // server 係真源、全店共用、Realtime 即時推送。呢度唔好再自己讀，
  // 否則又會出現兩個真源互相打架。

  useEffect(() => {
    async function loadRemoteConfig() {
      try {
        // 2026-09-09 修：以前 fetch 冇帶 storeId，route 對無 storeId 一律返 null
        // （防跨店洩露），變成新 terminal 永遠拉唔到本店已保存嘅打印機配置——同步通道係死嘅。
        const storeId = loadAuthSession()?.merchantId;
        if (!storeId) return; // 未登入：留空，登入後再同步
        const response = await fetch(`/api/pos/device-config?storeId=${encodeURIComponent(storeId)}`);
        const payload = (await response.json()) as {
          deviceConfig?: DeviceConfig | null;
        };
        if (payload.deviceConfig) {
          const remote = normalizeDeviceConfig(payload.deviceConfig);
          if (remote) {
            // 唔盲目覆蓋本機設定：遠端（GET 經 normalizeDeviceConfig，或佢 terminal 舊 app）可能缺
            // charset / connectionType / usb / bt 等打印機綁定欄位。用家啱啱 save 嘅設定唔可以被
            // 呢條「全店最新」config 清走。故 remote 缺嘅綁定欄位，保留本機 localStorage 嘅值。
            const local = loadDeviceConfig();
            const localPrinters = new Map((local?.printers ?? []).map((p) => [p.id, p]));
            const mergedPrinters = remote.printers.map((rp) => {
              const lp = localPrinters.get(rp.id);
              return lp
                ? {
                    ...rp,
                    charset: rp.charset ?? lp.charset,
                    connectionType: rp.connectionType ?? lp.connectionType,
                    usbVendorId: rp.usbVendorId ?? lp.usbVendorId,
                    usbProductId: rp.usbProductId ?? lp.usbProductId,
                    bluetoothName: rp.bluetoothName ?? lp.bluetoothName,
                    bluetoothAddress: rp.bluetoothAddress ?? lp.bluetoothAddress,
                    autoDetected: rp.autoDetected ?? lp.autoDetected,
                  }
                : rp;
            });
            const merged = { ...remote, printers: mergedPrinters };
            setConfig(merged);
            saveDeviceConfig(merged);
          }
        }
        // 注意：唔可以喺呢度用遠端 local_settings 覆蓋本機 localSettings（樓層與桌台）。
        // pos_device_configs 係按 updated_at desc limit 1 拎「全店最新一條」(任何 terminal)，
        // 用佢覆蓋本機會將其他 terminal 嘅枱 / 支付方式蓋咗過嚟，令用家剛 save 嘅枱消失。
        // 樓層與桌台係 per-terminal 本地 config，只信本機 localStorage。
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

  function removePrinter(printerId: string) {
    setConfig((current) => ({
      ...current,
      updatedAt: new Date().toISOString(),
      printers: current.printers.filter((printer) => printer.id !== printerId),
    }));
  }

  // ── 交班單打印機指定（2026-09-08）──
  // 走同 updatePrinter 一樣嘅「草稿 + 保存」模式：淨係改 config state，
  // 由頁面「保存」掣統一 saveDeviceConfig（本地 + 同步後台）。
  function updateShiftPrinterSetting(printerId: string) {
    setConfig((current) => ({
      ...current,
      updatedAt: new Date().toISOString(),
      shiftPrinterId: printerId || undefined,
    }));
    setStatus(printerId ? "交班單打印機已更改，請按「保存」生效。" : "交班單打印機已還原為跟隨收據打印機，請按「保存」生效。");
  }

  // ── saveAll：合併保存（本機 + 同步後台）──
  // 原本分「只保存到本機」同「保存並同步後台」兩個掣，而家合併做一個「保存」。
  // 行為 = saveLocal（即時寫 localStorage）+ syncConfig（推 server）。
  // 唔再畀用家揀「淨係本機」——登入後 server 係真源，本地淨係離線快取。
  function saveLocal() {
    saveDeviceConfig(config);
    savePosLocalSettings(localSettings);
  }

  async function saveAll(label = "保存") {
    if (syncingConfig) return;
    setSyncingConfig(true);
    saveLocal(); // 先寫本機，確保離線都有
    const updatedConfig = { ...config, updatedAt: new Date().toISOString() };
    saveDeviceConfig(updatedConfig);
    setConfig(updatedConfig);

    // 推上 server 嘅副本剝走 temp 枱、autoAcceptSelfOrder，同備註 preset（同原 syncConfig
    // 邏輯一致；備註 preset 已抽離做店級真源 pos_note_presets，唔再寫入 device_configs，
    // 避免殘留舊值同新真源打架）。
    const {
      autoAcceptSelfOrder: _,
      notePresets: _notePresets,
      cancelNotePresets: _cancelNotePresets,
      compNotePresets: _compNotePresets,
      ...localRest
    } = localSettings;
    const serverSettings = { ...localRest, floors: stripReopenTempTables(localSettings.floors) };

    const event: QueueEvent = {
      id: uid("evt"),
      type: "DEVICE_CONFIG_UPDATED",
      entityId: updatedConfig.deviceId,
      payload: {
        device: updatedConfig,
        tables: serverSettings.floors,
        paymentMethods: localSettings.paymentMethods,
        menuPrinterOverrides: localSettings.menuPrinterOverrides,
        printZones: localSettings.printZones,
        specTemplates: localSettings.specTemplates,
        standaloneSpecGroups: localSettings.standaloneSpecGroups,
        printTemplates: localSettings.printTemplates,
        onlineOrderSettings: localSettings.onlineOrderSettings,
      },
      status: "pending",
      createdAt: updatedConfig.updatedAt,
    };

    // docs/111：補 stamp storeId（以前完全冇 stamp → 呢啲事件永遠過唔到跨店閘口，
    // 一世留喺 pending 計落「未同步」），同埋用 enqueueEvents 合併（淨留最新一條設定）。
    const nextQueue = enqueueEvents(loadQueue(), withStoreScope([event]));
    saveQueue(nextQueue);

    try {
      const configRes = await fetch("/api/pos/device-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...updatedConfig,
          localSettings: serverSettings,
        }),
      });
      const onlineRes = await fetch("/api/online-order-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...localSettings.onlineOrderSettings,
          storeId: loadAuthSession()?.merchantId ?? null,
        }),
      });
      // ⚠️ 一定要 check res.ok：以前唔 check 就照標 synced，後台拒收嗰陣
      // 事件其實未上雲，但又唔會再重試。
      if (!configRes.ok || !onlineRes.ok) {
        setStatus(`${label}時後台拒收（HTTP ${configRes.status}/${onlineRes.status}），已保留在本機待補傳。`);
        return;
      }
      // 備註預設（0028 pos_note_presets，店級真源）：淨係喺「備註」tab 先推，避免每次
      // 其他 tab 保存都多一次 POST。成功後記低 server updated_at 做 LWW 基準。
      if (activeTab === "notes") {
        const storeId = loadAuthSession()?.merchantId;
        if (storeId) {
          try {
            const noteRes = await fetch("/api/pos/note-presets", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                storeId,
                presets: {
                  notePresets: localSettings.notePresets,
                  cancelNotePresets: localSettings.cancelNotePresets,
                  compNotePresets: localSettings.compNotePresets,
                },
              }),
            });
            const notePayload = (await noteRes.json().catch(() => null)) as {
              ok?: boolean;
              updatedAt?: string;
            } | null;
            if (noteRes.ok && notePayload?.ok && notePayload.updatedAt) {
              saveNotePresetSyncMeta({ updatedAt: notePayload.updatedAt });
            }
          } catch {
            // note-presets POST 失敗：備註仍保留本機，唔阻塞整次保存（device-config 已成功）
          }
        }
      }
      if (isOutboxV2Enabled()) {
        saveQueue(loadQueue().filter((item) => item.id !== event.id));
      } else {
        saveQueue(nextQueue.map((item) => (item.id === event.id ? { ...item, status: "synced" } : item)));
      }
      setStatus(`已${label}（本機 + 後台同步完成）。`);
    } catch {
      setStatus(`${label}失敗，已保留在本機待補傳。`);
    } finally {
      setSyncingConfig(false);
    }
  }

  // ── 備註預設拉取（0028 pos_note_presets，店級真源）────────────────────
  // 進入備註 tab 即拉店級真源，做 LWW：server 較新（比本機已知版本新）→ 採納 server
  // 備註，覆蓋 localSettings 三個 preset 欄；否則保留本機（離線 / server 無記錄時）。
  useEffect(() => {
    if (activeTab !== "notes") return;
    let cancelled = false;
    const storeId = loadAuthSession()?.merchantId;
    if (!storeId) return;
    (async () => {
      try {
        const res = await fetch(`/api/pos/note-presets?storeId=${encodeURIComponent(storeId)}`);
        const payload = (await res.json()) as {
          ok?: boolean;
          found?: boolean;
          presets?: { notePresets?: string[]; cancelNotePresets?: string[]; compNotePresets?: string[] } | null;
          updatedAt?: string | null;
        };
        if (cancelled || !payload.ok || !payload.found || !payload.presets) return;
        const serverTs = payload.updatedAt ? Date.parse(payload.updatedAt) || 0 : 0;
        const localMeta = loadNotePresetSyncMeta();
        const localTs = localMeta?.updatedAt ? Date.parse(localMeta.updatedAt) || 0 : 0;
        // server 較新先採納（LWW）：避免本機啱啱推完 / server 較舊時被回水。
        if (serverTs > 0 && serverTs > localTs) {
          setLocalSettings((current) => ({
            ...current,
            notePresets: payload.presets?.notePresets ?? current.notePresets,
            cancelNotePresets: payload.presets?.cancelNotePresets ?? current.cancelNotePresets,
            compNotePresets: payload.presets?.compNotePresets ?? current.compNotePresets,
          }));
          saveNotePresetSyncMeta({ updatedAt: payload.updatedAt ?? null });
          setStatus("已從雲端載入本店備註。");
        }
      } catch {
        // 離線 / fetch 失敗 → 保留本機備註
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

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

  // ── 新增菜品彈窗（2026-09-09）──
  function openMenuItemModal() {
    // 分類預設跟現時過濾器：過濾器揀住某分類 → 新筆即刻喺列表可見（唔會「新增咗但搵唔到」）
    const fallbackCategoryId =
      menuCategoryId !== "all"
        ? menuCategoryId
        : menuDraft.categories[0]?.id ?? "cat";
    setMenuItemModal({
      open: true,
      name: "",
      categoryId: fallbackCategoryId,
      price: "",
      printerGroup: localSettings.printZones[0]?.id ?? "kitchen",
      isMarketPrice: false,
      customerOrderable: true,
      discountRate: "",
      originalPrice: "",
      image: "",
      specGroups: [],
    });
    setMenuItemError(null);
  }

  function toggleMenuItemModalStandaloneSpec(groupId: string) {
    setMenuItemModal((current) => {
      if (!current) return current;
      const has = current.specGroups.some((group) => group.id === groupId);
      if (has) {
        return { ...current, specGroups: current.specGroups.filter((group) => group.id !== groupId) };
      }
      const group = localSettings.standaloneSpecGroups.find((row) => row.id === groupId);
      if (!group) return current;
      return { ...current, specGroups: [...current.specGroups, cloneSpecGroups([group])[0]] };
    });
  }

  // ── 快捷新增規格（2026-09-09）──
  function openQuickSpecDraft() {
    setQuickSpecDraft({
      id: crypto.randomUUID(),
      name: "",
      selectionMode: "single",
      required: true,
      options: [{ id: crypto.randomUUID(), label: "", priceDelta: 0 }],
    });
    setQuickSpecError(null);
  }

  function closeQuickSpecDraft() {
    setQuickSpecDraft(null);
    setQuickSpecError(null);
  }

  function updateQuickSpecDraft(updater: (group: MenuSpecGroup) => MenuSpecGroup) {
    setQuickSpecDraft((current) => (current ? updater(current) : current));
  }

  /**
   * 保存快捷新增規格：
   * 1. 驗證後 upsert 入 localSettings.standaloneSpecGroups（規格管理 › 獨立規格）＋ savePosLocalSettings；
   * 2. 同步加入目前「新增菜品」嘅 specGroups（快照拷貝，同「編輯規格」剔選行為一致）；
   * 3. 即時推 server（/api/pos/device-config，同「保存」掣同一通道），失敗就入 outbox 遲啲補傳，
   *    確保其他設備／規格管理頁見到同一份獨立規格。
   */
  async function saveQuickSpecDraft() {
    if (!quickSpecDraft) return;
    const name = quickSpecDraft.name.trim();
    if (!name) {
      setQuickSpecError("請填寫規格名稱。");
      return;
    }
    const options = quickSpecDraft.options
      .map((opt) => ({ ...opt, label: opt.label.trim() }))
      .filter((opt) => opt.label);
    if (options.length === 0) {
      setQuickSpecError("請至少填寫一個選項名稱。");
      return;
    }
    const group: MenuSpecGroup = { ...quickSpecDraft, name, options };

    // 1. 自動存入「規格管理 › 獨立規格」（本機 + 規格管理列表即時可見）
    const next = {
      ...localSettings,
      standaloneSpecGroups: localSettings.standaloneSpecGroups.some((row) => row.id === group.id)
        ? localSettings.standaloneSpecGroups.map((row) => (row.id === group.id ? group : row))
        : [...localSettings.standaloneSpecGroups, group],
    };
    setLocalSettings(next);
    savePosLocalSettings(next);

    // 2. 加入目前新增菜品嘅規格（快照拷貝）
    setMenuItemModal((current) =>
      current
        ? {
            ...current,
            specGroups: [...current.specGroups.filter((row) => row.id !== group.id), cloneSpecGroups([group])[0]],
          }
        : current,
    );
    closeQuickSpecDraft();

    // 3. 即時推 server（同 saveAll「保存」一致嘅 serverSettings 副本 + DEVICE_CONFIG_UPDATED 事件；
    //    離線時本地已存，事件入 outbox 網絡恢復自動補傳）
    const updatedConfig = { ...config, updatedAt: new Date().toISOString() };
    setConfig(updatedConfig);
    const {
      autoAcceptSelfOrder: _autoAccept,
      notePresets: _notePresets,
      cancelNotePresets: _cancelNotePresets,
      compNotePresets: _compNotePresets,
      ...localRest
    } = next;
    const serverSettings = { ...localRest, floors: stripReopenTempTables(next.floors) };
    const event: QueueEvent = {
      id: uid("evt"),
      type: "DEVICE_CONFIG_UPDATED",
      entityId: updatedConfig.deviceId,
      payload: {
        device: updatedConfig,
        tables: serverSettings.floors,
        paymentMethods: next.paymentMethods,
        menuPrinterOverrides: next.menuPrinterOverrides,
        printZones: next.printZones,
        specTemplates: next.specTemplates,
        standaloneSpecGroups: next.standaloneSpecGroups,
        printTemplates: next.printTemplates,
        onlineOrderSettings: next.onlineOrderSettings,
      },
      status: "pending",
      createdAt: updatedConfig.updatedAt,
    };
    saveQueue(enqueueEvents(loadQueue(), withStoreScope([event])));
    try {
      const res = await fetch("/api/pos/device-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...updatedConfig, localSettings: serverSettings }),
      });
      const ok = res.ok;
      setStatus(
        ok
          ? `已新增規格「${name}」：已加入菜品，並自動存入「規格管理 › 獨立規格」供日後復用。`
          : `已新增規格「${name}」並加入菜品；同步 server 失敗，稍後會自動補傳。`,
      );
    } catch {
      setStatus(`已新增規格「${name}」並加入菜品；目前離線，規格已存本機、稍後自動補傳。`);
    }
  }

  async function saveMenuItemModal() {
    if (!menuItemModal || menuItemSaving) return;
    const name = menuItemModal.name.trim();
    if (!name) {
      setMenuItemError("請填寫菜品名稱。");
      return;
    }
    if (!menuItemModal.categoryId) {
      setMenuItemError("請揀選分類（可先喺「菜品分類」新增）。");
      return;
    }
    const trimmedPrice = menuItemModal.price.trim();
    let price = 0;
    if (!menuItemModal.isMarketPrice) {
      if (!trimmedPrice) {
        setMenuItemError("請填寫價格（時價菜可留空價格）。");
        return;
      }
      price = Number(trimmedPrice);
      if (!Number.isFinite(price) || price < 0) {
        setMenuItemError("價格格式唔正確，請填 0 或以上嘅數字。");
        return;
      }
    }
    const rateRaw = menuItemModal.discountRate.trim();
    let discountRate: number | undefined;
    if (rateRaw) {
      const rate = Number(rateRaw);
      if (!Number.isFinite(rate) || rate <= 0 || rate >= 100) {
        setMenuItemError("折扣要係 1-99 之間嘅數字（例如 80 = 8折），或留空表示冇折扣。");
        return;
      }
      discountRate = rate;
    }
    const originalRaw = menuItemModal.originalPrice.trim();
    let originalPrice: number | undefined;
    if (originalRaw) {
      const original = Number(originalRaw);
      if (!Number.isFinite(original) || original < 0) {
        setMenuItemError("原價格式唔正確，請填 0 或以上嘅數字。");
        return;
      }
      originalPrice = original;
    }
    const image = menuItemModal.image.trim();
    const newItem: MenuItem = {
      id: crypto.randomUUID(),
      categoryId: menuItemModal.categoryId,
      name,
      price,
      printerGroup: menuItemModal.printerGroup || localSettings.printZones[0]?.id || "kitchen",
      ...(menuItemModal.specGroups.length ? { specGroups: cloneSpecGroups(menuItemModal.specGroups) } : {}),
      ...(menuItemModal.isMarketPrice ? { isMarketPrice: true } : {}),
      ...(menuItemModal.customerOrderable ? {} : { customerOrderable: false }),
      ...(discountRate !== undefined ? { discountRate } : {}),
      ...(originalPrice !== undefined ? { originalPrice } : {}),
      ...(image ? { image } : {}),
    };
    const nextDraft = { ...menuDraft, menuItems: [...menuDraft.menuItems, newItem] };
    setMenuDraft(nextDraft);
    setMenuItemSaving(true);
    const ok = await saveMenuToBackend(nextDraft);
    setMenuItemSaving(false);
    // 列表即時更新：清搜尋 → 跳去新菜品分類 → 跳到包含佢嗰頁
    setMenuSearch("");
    setMenuCategoryId(newItem.categoryId);
    const inCategory = nextDraft.menuItems.filter((row) => row.categoryId === newItem.categoryId);
    const index = inCategory.findIndex((row) => row.id === newItem.id);
    setMenuPage(Math.floor(index / menuPageSize) + 1);
    setMenuItemModal(null);
    setMenuItemError(null);
    setStatus(
      ok
        ? `已新增菜品「${name}」並保存到後台。`
        : `已新增菜品「${name}」（本機）；保存到 server 失敗，請稍後按「保存菜單」補傳。`,
    );
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

  /** 獨立規格組（非模板）：templateId 暫存 group id；draft 恆為單一 group。 */
  function openSpecEditorForGroup(groupId?: string) {
    const group = groupId
      ? localSettings.standaloneSpecGroups.find((item) => item.id === groupId) ?? null
      : null;
    setSpecEditor({
      open: true,
      mode: "group",
      itemId: null,
      templateId: group?.id ?? null,
      templateName: "",
      draft: group
        ? [cloneSpecGroups([group])[0]]
        : [
            {
              id: crypto.randomUUID(),
              name: "新規格",
              selectionMode: "single",
              required: true,
              options: [{ id: crypto.randomUUID(), label: "新選項", priceDelta: 0 }],
            },
          ],
    });
  }

  function closeSpecEditor() {
    setSpecEditor({ open: false, mode: "item", itemId: null, templateId: null, templateName: "", draft: [] });
  }

  async function testPrint(printer: DevicePrinterConfig) {
    if (testingPrinterId) return;
    setTestingPrinterId(printer.id);

    const copies = Math.max(1, Math.floor(printer.copies ?? 1));

    const testJob: PrintJob = {
      id: uid("print"),
      orderId: "",
      orderNo: "TEST",
      tableName: "",
      ticketType: "normal",
      printerGroup:
        printer.role === "receipt"
          ? "receipt"
          : printer.role === "label"
            ? "label"
            : printer.zoneId ?? "zone:test",
      printerId: printer.id,
      printerName: printer.name,
      items: [{ name: "Macau POS 測試打印", quantity: 1, specs: [], note: "Printer Test OK" }],
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    try {
      const storeName = loadBootstrapCache()?.storeName;
      const kind: PrintKind = "test";

      // 1) Native Print Agent（Android APK WebView）優先：經 PosNative 觸發 APK renderTestPage
      if (isNativeBridgeAvailable()) {
        let lastErr = "";
        for (let i = 0; i < copies; i++) {
          const res = await dispatchJobToNative(testJob, { printer, kind, storeName });
          if (!res.ok) {
            lastErr = res.error || `未能送出 ${printer.name} 測試打印。`;
            break;
          }
        }
        setStatus(
          lastErr
            ? lastErr
            : `已透過 Native Print Agent 送出 ${printer.name} 測試打印（${copies} 份）。`,
        );
        return;
      }

      // 2) 桌面 Companion 代理（loopback http://127.0.0.1:9311）——
      //    必須同時係「Companion 環境」（原生殼 / `?companion=` URL 參數）。
      //    純 website / PWA 即便 localStorage 有 stale `macau-pos-companion-url` 都要 skip——
      //    否則會無謂打 5s 連唔到嘅 loopback（companion-transport.ts 嘅 5s AbortController
      //    超時先返），同 `dispatchOneJob` 嘅 companion 分支語義完全對齊。
      if (shouldKeepCompanionAlive() && isCompanionConfigured()) {
        let lastErr = "";
        for (let i = 0; i < copies; i++) {
          const r = await sendJobToCompanion(testJob, printer);
          if (!r.ok) {
            lastErr = r.error ?? "";
            break;
          }
        }
        setStatus(
          lastErr
            ? `Companion 測試打印失敗：${lastErr}`
            : `已透過 Companion 送出 ${printer.name} 測試打印（${copies} 份）。`,
        );
        return;
      }

      // 3) Cloud Print Relay（雲端中繼，互聯網備援）——
      //    網頁 / PWA 嘅預設打印通道（companion 環境 gate 過唔到就落到呢度）。
      //    走 `getRelayTransport().send()`，同 `dispatchOneJob` relay 分支一致：
      //    relay 內部會 `flushPosSyncQueue` 確保 PRINT_JOB_CREATED 已上雲，
      //    中繼 APK 隨後經 Realtime 訂閱 + claim RPC 拎走出紙。
      if (isRelayConfigured()) {
        const relay = getRelayTransport();
        if (relay) {
          let lastErr = "";
          for (let i = 0; i < copies; i++) {
            const res = await relay.send(testJob, printer, { kind, storeName });
            if (!res.ok) {
              lastErr = res.error || "relay 打印失敗";
              break;
            }
          }
          setStatus(
            lastErr
              ? `Print Relay 測試打印失敗：${lastErr}`
              : `已透過 Print Relay 送出 ${printer.name} 測試單到雲端中繼（${copies} 份，店內中繼機會自動出紙）。`,
          );
          return;
        }
      }

      // 4) 真係乜都冇 —— 唔再誤導「桌面 Companion 已啟動」（喺 web/PWA 開 desktop agent 根本無解）
      setStatus(
        "未配置任何打印通道：請到「打印中繼」分頁配對雲端備援（relay），或於桌面裝置啟動 Companion 代理後再測試。",
      );
    } catch {
      setStatus(`未能送出 ${printer.name} 測試打印。`);
    } finally {
      setTestingPrinterId(null);
    }
  }


  // ─────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────
  // 打印機經 Companion 代理管理（零配置自動配對）
  // ─────────────────────────────────────────────────────────────

  function handleAddCompanionPrinter(printer: DevicePrinterConfig) {
    const nextPrinters = [...config.printers, printer];
    setConfig((c) => ({ ...c, printers: nextPrinters }));
    saveDeviceConfig({ ...config, printers: nextPrinters });
    setStatus(`已加入打印機「${printer.name}」（自動偵測：${printer.connectionType}）。`);
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
            ["discounts", "折扣"],
            ["kiosk", "掃碼點餐"],
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

  {activeTab === "kiosk" ? (
    <div className="grid gap-3">
      <KioskModePanel />
      {/* 掃碼點餐：模式選擇（堂食 / 快餐互斥）+ 對應嘅 QR 面板（docs/115） */}
      <ScanModePanel />
    </div>
  ) : null}

        {activeTab === "device" ? (
          <>
          <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 max-h-[calc(100dvh-150px)] flex flex-col">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-base font-semibold text-slate-900">打印機綁定</div>
                  <div className="mt-1 text-sm text-slate-500">
                    支援自定義分區、唯一收據打印機，以及綁定分區的標籤機。
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                    {config.printers.length} printers
                  </span>
                  <button
                    className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    aria-busy={syncingConfig}
                    disabled={syncingConfig}
                    onClick={() => void saveAll()}
                    type="button"
                  >
                    {syncingConfig ? "同步中…" : "保存"}
                  </button>
                </div>
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
                {config.printers.length === 0 ? (
                  <PrinterEmptyState onAdd={() => setPrinterWizardOpen(true)} />
                ) : (
                  <div className="grid gap-3">
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                      <div className="text-sm font-semibold text-slate-900">交班單打印機</div>
                      <div className="mt-1 text-xs text-slate-500">
                        指定結數交班明細由邊台打印機出紙；唔揀 = 跟隨收據打印機。已停用嘅打印機唔會出紙。
                      </div>
                      <select
                        className="mt-2 w-full max-w-xs rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                        onChange={(event) => updateShiftPrinterSetting(event.target.value)}
                        value={config.shiftPrinterId ?? ""}
                      >
                        <option value="">跟隨收據打印機（預設）</option>
                        {config.printers.map((printer) => (
                          <option key={printer.id} value={printer.id} disabled={!printer.enabled}>
                            {printer.name}
                            {!printer.enabled ? "（已停用）" : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                    {config.printers.map((printer) => (
                      <PrinterCardV2
                        key={printer.id}
                        printer={printer}
                        printZones={localSettings.printZones}
                        testing={testingPrinterId === printer.id}
                        onToggle={(id, enabled) => updatePrinter(id, { enabled })}
                        onRemove={removePrinter}
                        onTestPrint={testPrint}
                        onUpdate={updatePrinter}
                      />
                    ))}
                    <div className="flex justify-end">
                      <button
                        className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                        onClick={() => setPrinterWizardOpen(true)}
                        type="button"
                      >
                        + 添加打印機
                      </button>
                    </div>
                  </div>
                )}
              </div>
              ) : null}

              </div>
            </section>

          <PrintContentTogglesSection
            toggles={localSettings.printContentToggles}
            onChange={(next) => {
              // 即時寫 localSettings（每粒掣一撳即刻生效，唔等「保存」）。
              // 真源：本機 `PosLocalSettings.printContentToggles`（per-terminal 設定，
              // 唔跨店，見 types.ts JSDoc）。syncConfig 會照樣上 server（per-terminal
              // 細節都會帶過去），pos-app.tsx loadRuntimeState 嘅 merge 已經將
              // `printContentToggles` 加入 local-priority 清單，跨設備唔會互蓋。
              const updated = { ...localSettings, printContentToggles: next };
              setLocalSettings(updated);
              savePosLocalSettings(updated);
            }}
          />

          <CompanionStatusCard />

          <RelayPairingPanel />
          </>
        ) : null}

        <PrinterWizardModal
          open={printerWizardOpen}
          onClose={() => setPrinterWizardOpen(false)}
          onAdd={handleAddCompanionPrinter}
          printZones={localSettings.printZones}
        />

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
              <div className="text-base font-semibold text-slate-900">免單備註</div>
              <div className="mt-1 text-sm text-slate-500">結帳頁按「免單」時要選擇的原因（必填）。</div>

              <div className="mt-4 flex-1 overflow-auto pr-1">
                <div className="grid gap-2">
                  {localSettings.compNotePresets.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                      暫時沒有免單備註
                    </div>
                  ) : (
                    localSettings.compNotePresets.map((note) => (
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
                              compNotePresets: localSettings.compNotePresets.filter((item) => item !== note),
                            };
                            setLocalSettings(next);
                            setStatus("已更新免單備註草稿，請先保存。");
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
                    onChange={(event) => setNewCompNotePreset(event.target.value)}
                    placeholder="新增免單備註..."
                    value={newCompNotePreset}
                  />
                  <button
                    className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                    onClick={() => {
                      const text = newCompNotePreset.trim();
                      if (!text) return;
                      const next = {
                        ...localSettings,
                        compNotePresets: Array.from(new Set([...localSettings.compNotePresets, text])),
                      };
                      setLocalSettings(next);
                      setNewCompNotePreset("");
                      setStatus("已新增免單備註草稿，請先保存。");
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

            <section className="rounded-2xl border border-slate-200 bg-white p-4 max-h-[calc(100dvh-150px)] flex flex-col overflow-hidden lg:col-span-2">
              <div className="text-base font-semibold text-slate-900">返結原因</div>
              <div className="mt-1 text-sm text-slate-500">用於返結（反結賬）時選擇退回可編輯狀態的原因，強制填寫以便對帳。</div>

              <div className="mt-4 flex-1 overflow-auto pr-1">
                <div className="grid gap-2">
                  {localSettings.reopenReasons.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                      暫時沒有返結原因
                    </div>
                  ) : (
                    localSettings.reopenReasons.map((note) => (
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
                              reopenReasons: localSettings.reopenReasons.filter((item) => item !== note),
                            };
                            setLocalSettings(next);
                            setStatus("已更新返結原因草稿，請先保存。");
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
                    onChange={(event) => setNewReopenReason(event.target.value)}
                    placeholder="新增返結原因..."
                    value={newReopenReason}
                  />
                  <button
                    className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                    onClick={() => {
                      const text = newReopenReason.trim();
                      if (!text) return;
                      const next = {
                        ...localSettings,
                        reopenReasons: Array.from(new Set([...localSettings.reopenReasons, text])),
                      };
                      setLocalSettings(next);
                      setNewReopenReason("");
                      setStatus("已新增返結原因草稿，請先保存。");
                    }}
                    type="button"
                  >
                    加入
                  </button>
                </div>
              </div>
            </section>

            <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4 lg:col-span-2">
              <button
                className="rounded-2xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                aria-busy={syncingConfig}
                disabled={syncingConfig}
                onClick={() => void saveAll("保存備註")}
                type="button"
              >
                {syncingConfig ? "同步中…" : "保存備註"}
              </button>
            </div>
          </div>
        ) : null}

        {activeTab === "discounts" ? (
          <div className="grid gap-3 lg:grid-cols-2">
            <section className="rounded-2xl border border-slate-200 bg-white p-4 max-h-[calc(100dvh-150px)] flex flex-col overflow-hidden">
              <div className="text-base font-semibold text-slate-900">折扣項目</div>
              <div className="mt-1 text-sm text-slate-500">
                用於結帳頁「全單折扣」下拉及單品折扣彈窗。每個折扣填名稱與百分比（例如「8折」+「80」），介面唔顯示「%」號。
              </div>

              <div className="mt-4 flex-1 overflow-auto pr-1">
                <div className="grid gap-2">
                  {localSettings.discounts.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                      暫時沒有折扣項目
                    </div>
                  ) : (
                    localSettings.discounts.map((disc) => (
                      <div
                        key={disc.id}
                        className="flex items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-900">{disc.label}</div>
                          <div className="text-xs text-slate-500">{disc.rate}%（即收 {disc.rate} 元 / 原價 100）</div>
                        </div>
                        <button
                          className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                          onClick={() => {
                            const next = {
                              ...localSettings,
                              discounts: localSettings.discounts.filter((item) => item.id !== disc.id),
                            };
                            setLocalSettings(next);
                            setStatus("已刪除折扣草稿，請先保存。");
                          }}
                          type="button"
                        >
                          刪除
                        </button>
                      </div>
                    ))
                  )}
                </div>

                <div className="mt-3 grid gap-2">
                  <input
                    className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    onChange={(event) => setNewDiscountLabel(event.target.value)}
                    placeholder="折扣名稱，例如「8折」"
                    value={newDiscountLabel}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      className="w-40 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                      inputMode="decimal"
                      onChange={(event) => setNewDiscountRate(event.target.value)}
                      placeholder="百分比，例如 80"
                      value={newDiscountRate}
                    />
                    <button
                      className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                      onClick={() => {
                        const label = newDiscountLabel.trim();
                        const rate = Number(newDiscountRate);
                        if (!label) {
                          setStatus("請填寫折扣名稱。");
                          return;
                        }
                        if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
                          setStatus("百分比必須是 0–100 之間嘅數字。");
                          return;
                        }
                        const next: PosLocalSettings = {
                          ...localSettings,
                          discounts: [
                            ...localSettings.discounts,
                            { id: newDiscountId(), label, rate } as DiscountPreset,
                          ],
                        };
                        setLocalSettings(next);
                        setNewDiscountLabel("");
                        setNewDiscountRate("");
                        setStatus("已新增折扣草稿，請先保存。");
                      }}
                      type="button"
                    >
                      加入
                    </button>
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-4 max-h-[calc(100dvh-150px)] flex flex-col overflow-hidden">
              <div className="text-base font-semibold text-slate-900">說明</div>
              <div className="mt-3 grid gap-2 text-sm text-slate-600">
                <div>· 百分比 = 實收比例。80 = 8 折（收 80 元）；50 = 5 折；100 = 冇折扣。</div>
                <div>· 單品折扣只影響該菜品，會喺結帳頁該菜品旁顯示原價（刪除線）＋折後價。</div>
                <div>· 全單折扣套用整張單，折扣金額會喺結帳摘要「折扣」一欄顯示。</div>
                <div>· 修改後請撳右下方「保存折扣」同步到本機同伺服器。</div>
              </div>
            </section>

            <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4 lg:col-span-2">
              <button
                className="rounded-2xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                aria-busy={syncingConfig}
                disabled={syncingConfig}
                onClick={() => void saveAll("保存折扣")}
                type="button"
              >
                {syncingConfig ? "同步中…" : "保存折扣"}
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
                onClick={() => void saveAll("保存菜品打印設置")}
                type="button"
              >
                {syncingConfig ? "同步中…" : "保存菜品打印設置"}
              </button>
            </div>
          </section>
        ) : null}

        {activeTab === "menu" ? (
          <section
            className={`rounded-2xl border border-slate-200 bg-white p-4 flex flex-col ${
              // 菜品設置子分頁：列表區需要大高度（≥10 個菜品一次呈現），
              // 解除視口鉗制改由頁面層捲動；其餘子分頁維持原內捲動行為。
              menuSubTab === "items" ? "" : "max-h-[calc(100dvh-150px)] overflow-hidden"
            }`}
          >
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
                  disabled={ledgerImportLoading || menuSaving}
                  onClick={() => void beginLedgerMenuImport()}
                  type="button"
                >
                  {ledgerImportLoading ? "讀取 Ledger…" : "從 Ledger 參考匯入"}
                </button>
                <button
                  className="rounded-2xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  aria-busy={menuSaving}
                  disabled={menuSaving}
                  onClick={async () => {
                    await saveMenuToBackend(menuDraft);
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
                    {menuDraft.categories.map((category) => {
                      const usedCount = menuDraft.menuItems.filter((row) => row.categoryId === category.id).length;
                      return (
                        <div className="flex items-center gap-2" key={category.id}>
                          <input
                            className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900"
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
                          <button
                            className="shrink-0 rounded-xl bg-red-50 px-3 py-2.5 text-xs font-semibold text-red-600 ring-1 ring-red-100 transition hover:bg-red-100 active:scale-95"
                            onClick={() => {
                              const name = category.name.trim() || "未命名分類";
                              const remaining = menuDraft.categories.filter((row) => row.id !== category.id);
                              const fallbackName = remaining[0]?.name ?? "";
                              const message =
                                usedCount > 0 && fallbackName
                                  ? `確定刪除分類「${name}」？入面 ${usedCount} 道菜會移去「${fallbackName}」。按「保存菜單」後先正式生效。`
                                  : `確定刪除分類「${name}」？按「保存菜單」後先正式生效。`;
                              if (!window.confirm(message)) return;
                              const fallbackId = remaining[0]?.id ?? "";
                              setMenuDraft((current) => ({
                                ...current,
                                categories: current.categories.filter((row) => row.id !== category.id),
                                menuItems: fallbackId
                                  ? current.menuItems.map((row) =>
                                      row.categoryId === category.id ? { ...row, categoryId: fallbackId } : row,
                                    )
                                  : current.menuItems,
                              }));
                              if (menuCategoryId === category.id) setMenuCategoryId("all");
                              if (menuPrintCategoryId === category.id) setMenuPrintCategoryId("all");
                              setStatus(`已刪除分類「${name}」，請保存菜單。`);
                            }}
                            title={usedCount > 0 ? `有 ${usedCount} 道菜喺呢個分類` : "冇菜品使用"}
                            type="button"
                          >
                            刪除
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : null}

            {menuSubTab === "specs" ? (
              <div className="mt-4 flex flex-1 min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">規格模板</div>
                    <div className="mt-1 text-xs text-slate-500">規格組統一喺呢度定義同管理：模板（成套套用）或獨立規格（單一規格組、菜品自由剔選）；再到「菜品設置 › 編輯規格」組合套用。</div>
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
                              <div className="flex justify-end gap-2">
                                <button
                                  className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                                  onClick={() => openSpecEditorForTemplate(template.id)}
                                  type="button"
                                >
                                  編輯
                                </button>
                                <button
                                  className="rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-600 ring-1 ring-red-100 transition hover:bg-red-100 active:scale-95"
                                  onClick={() => {
                                    if (!window.confirm(`確定刪除規格模板「${template.name}」？已套用此模板嘅菜品規格唔會受影響。`)) return;
                                    const next = {
                                      ...localSettings,
                                      specTemplates: localSettings.specTemplates.filter((row) => row.id !== template.id),
                                    };
                                    setLocalSettings(next);
                                    if (selectedTemplateId === template.id) {
                                      setSelectedTemplateId(next.specTemplates[0]?.id ?? "");
                                    }
                                    savePosLocalSettings(next);
                                    setStatus(`已刪除規格模板「${template.name}」。`);
                                  }}
                                  type="button"
                                >
                                  刪除
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                {/* 獨立規格（非模板）：單一規格組，菜品「編輯規格」可自由剔選加入 */}
                <div className="mt-4 shrink-0">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">獨立規格</div>
                      <div className="mt-1 text-xs text-slate-500">
                        唔使開模板，直接建立單一規格組（例如「辣度」「走蔥」）；菜品「編輯規格」可自由剔選加入／移除。
                      </div>
                    </div>
                    <button
                      className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white"
                      onClick={() => openSpecEditorForGroup(undefined)}
                      type="button"
                    >
                      新增規格
                    </button>
                  </div>
                  <div className="mt-3 max-h-[240px] overflow-auto rounded-2xl border border-slate-200">
                    <table className="w-full border-collapse text-sm">
                      <thead className="bg-white">
                        <tr className="text-left text-xs font-semibold text-slate-500">
                          <th className="border-b border-slate-200 px-3 py-2">規格</th>
                          <th className="border-b border-slate-200 px-3 py-2">模式</th>
                          <th className="border-b border-slate-200 px-3 py-2">選項數</th>
                          <th className="border-b border-slate-200 px-3 py-2 text-right">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {localSettings.standaloneSpecGroups.length === 0 ? (
                          <tr>
                            <td className="px-3 py-6 text-slate-500" colSpan={4}>
                              尚未有獨立規格
                            </td>
                          </tr>
                        ) : (
                          localSettings.standaloneSpecGroups.map((group) => (
                            <tr key={group.id}>
                              <td className="border-b border-slate-100 px-3 py-2 font-semibold text-slate-900">
                                {group.name}
                              </td>
                              <td className="border-b border-slate-100 px-3 py-2 text-slate-600">
                                {group.selectionMode === "single" ? "單選" : "多選"}
                                {group.required ? " · 必選" : ""}
                              </td>
                              <td className="border-b border-slate-100 px-3 py-2 text-slate-600">
                                {group.options?.length ?? 0}
                              </td>
                              <td className="border-b border-slate-100 px-3 py-2 text-right">
                                <div className="flex justify-end gap-2">
                                  <button
                                    className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                                    onClick={() => openSpecEditorForGroup(group.id)}
                                    type="button"
                                  >
                                    編輯
                                  </button>
                                  <button
                                    className="rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-600 ring-1 ring-red-100 transition hover:bg-red-100 active:scale-95"
                                    onClick={() => {
                                      if (!window.confirm(`確定刪除獨立規格「${group.name}」？已加入菜品嘅規格係快照拷貝，唔會受影響。`)) return;
                                      const next = {
                                        ...localSettings,
                                        standaloneSpecGroups: localSettings.standaloneSpecGroups.filter(
                                          (row) => row.id !== group.id,
                                        ),
                                      };
                                      setLocalSettings(next);
                                      savePosLocalSettings(next);
                                      setStatus(`已刪除獨立規格「${group.name}」。`);
                                    }}
                                    type="button"
                                  >
                                    刪除
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ) : null}

            {menuSubTab === "items" ? (
              <div className="mt-4 flex flex-col rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">菜品</div>
                    <div className="mt-1 text-xs text-slate-500">規格統一由模板套用：按「編輯規格」揀模板後「保存」即時寫入 server；想自訂規格組請去「規格管理」建立模板。</div>
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
                      className="rounded-2xl bg-orange-500 px-6 py-3 text-base font-semibold text-white transition active:scale-95"
                      onClick={openMenuItemModal}
                      type="button"
                    >
                      新增菜品
                    </button>
                  </div>
                </div>

                {/* 即時搜尋：每打一個字即篩（子字串比對，唔使撳掣／撳 Enter） */}
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <div className="relative min-w-0 flex-1 basis-56">
                    <input
                      className="w-full rounded-2xl border border-slate-200 bg-white py-2 pl-3 pr-9 text-sm outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                      onChange={(event) => {
                        setMenuSearch(event.target.value);
                        setMenuPage(1);
                      }}
                      placeholder="搜尋菜品名稱，例如「雞」…"
                      value={menuSearch}
                    />
                    {menuSearch ? (
                      <button
                        aria-label="清除搜尋"
                        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-slate-400 transition hover:text-slate-700"
                        onClick={() => {
                          setMenuSearch("");
                          setMenuPage(1);
                        }}
                        type="button"
                      >
                        ✕
                      </button>
                    ) : (
                      <span className="pointer-events-none absolute inset-y-0 right-0 flex w-9 items-center justify-center text-slate-400">
                        🔍
                      </span>
                    )}
                  </div>
                  {menuSearch.trim() ? (
                    <span className="text-xs text-orange-600">
                      正在搜尋「{menuSearch.trim()}」…
                    </span>
                  ) : null}
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
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

                {menuPageItems.length === 0 ? (
                  /* 空白狀態：冇符合結果時畀明確提示（代替空白表格） */
                  <div className="mt-2 flex flex-1 min-h-0 items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50/60">
                    <div className="px-6 py-10 text-center text-sm text-slate-400">
                      {menuSearch.trim() ? (
                        <>
                          沒有符合「<span className="font-semibold text-slate-600">{menuSearch.trim()}</span>」
                          嘅菜品
                          {menuCategoryId !== "all" ? "（喺目前分類內）" : ""}，請試其他關鍵字。
                        </>
                      ) : (
                        <>呢個分類暫時冇菜品，可以撳「新增菜品」加入。</>
                      )}
                    </div>
                  </div>
                ) : (
                <div className="mt-2 min-h-[700px] rounded-2xl border border-slate-200 bg-slate-50/60 p-2 sm:p-3">
                  {/* 大高度列表（2026-09-09）：min-h 700px ≈ 原本 3 倍，緊湊卡片一屏完整
                      顯示 ≥10 個菜品；區域隨內容增長，超出部分由頁面層捲動。
                      xl 以上單行卡片（~52px/個）；窄屏自動換行成多行，保持可用。 */}
                  <div className="grid gap-1.5 sm:gap-2">
                    {menuPageItems.map((item) => (
                      <div key={item.id} className="rounded-2xl border border-slate-200 bg-white p-2">
                        {/* 兩行版面（2026-09-09）：菜名 textarea 可換行完整顯示；
                            右側欄位區兩層 flex-wrap，任何闊度都唔會溢出右邊界。 */}
                        <div className="flex flex-wrap items-start gap-2 lg:flex-nowrap">
                          <textarea
                            aria-label="菜品名稱"
                            className="min-w-[180px] flex-[2] basis-48 resize-none rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold leading-snug text-slate-900"
                            onChange={(event) =>
                              setMenuDraft((current) => ({
                                ...current,
                                menuItems: current.menuItems.map((row) =>
                                  row.id === item.id ? { ...row, name: event.target.value } : row,
                                ),
                              }))
                            }
                            rows={2}
                            value={item.name}
                          />
                          <div className="flex min-w-[280px] flex-[3] flex-col gap-1.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <select
                                aria-label="分類"
                                className="w-auto max-w-[220px] shrink-0 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-sm"
                                onChange={(event) =>
                                  setMenuDraft((current) => ({
                                    ...current,
                                    menuItems: current.menuItems.map((row) =>
                                      row.id === item.id ? { ...row, categoryId: event.target.value } : row,
                                    ),
                                  }))
                                }
                                title={`分類：${categoryNameMap[item.categoryId] ?? item.categoryId}`}
                                value={item.categoryId}
                              >
                                {menuDraft.categories.map((category) => (
                                  <option key={category.id} value={category.id}>
                                    {category.name}
                                  </option>
                                ))}
                              </select>
                              <select
                                aria-label="打印分區"
                                className="w-auto max-w-[220px] shrink-0 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-sm"
                                onChange={(event) =>
                                  setMenuDraft((current) => ({
                                    ...current,
                                    menuItems: current.menuItems.map((row) =>
                                      row.id === item.id ? { ...row, printerGroup: event.target.value } : row,
                                    ),
                                  }))
                                }
                                title="打印分區"
                                value={item.printerGroup}
                              >
                                {localSettings.printZones.map((zone) => (
                                  <option key={zone.id} value={zone.id}>
                                    {zone.name}
                                  </option>
                                ))}
                              </select>
                              <input
                                aria-label="價格（MOP）"
                                className="w-20 shrink-0 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-sm"
                                inputMode="decimal"
                                onChange={(event) =>
                                  setMenuDraft((current) => ({
                                    ...current,
                                    menuItems: current.menuItems.map((row) =>
                                      row.id === item.id ? { ...row, price: Number(event.target.value) || 0 } : row,
                                    ),
                                  }))
                                }
                                title="價格（MOP）"
                                value={String(item.price)}
                              />
                              <div className="flex shrink-0 flex-col gap-0.5 text-xs leading-tight text-slate-500">
                                <label className="flex items-center gap-1.5" title="時價菜（落單時改價）">
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
                                  時價菜
                                </label>
                                <label className="flex items-center gap-1.5" title="客人可點（掃碼點餐可見）">
                                  <input
                                    checked={item.customerOrderable !== false}
                                    className="h-3.5 w-3.5 rounded border-slate-300"
                                    onChange={(event) =>
                                      setMenuDraft((current) => ({
                                        ...current,
                                        menuItems: current.menuItems.map((row) =>
                                          row.id === item.id
                                            ? { ...row, customerOrderable: event.target.checked }
                                            : row,
                                        ),
                                      }))
                                    }
                                    type="checkbox"
                                  />
                                  客人可點
                                </label>
                              </div>
                            </div>
                            <div
                              className="flex flex-wrap items-center gap-1.5"
                              title={formatSpecGroupsSummary(item.specGroups)}
                            >
                              <span className="shrink-0 text-[11px] font-medium text-slate-400">規格</span>
                              {(item.specGroups?.length ?? 0) > 0 ? (
                                <>
                                  {item.specGroups!.map((group) => (
                                    <span
                                      className="whitespace-nowrap rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600"
                                      key={group.id}
                                    >
                                      {group.name}·{group.options.length}項{group.required ? "·必選" : ""}
                                    </span>
                                  ))}
                                  <button
                                    className="px-1 text-[11px] font-medium text-red-400 underline-offset-2 hover:underline"
                                    onClick={() => {
                                      setMenuDraft((current) => ({
                                        ...current,
                                        menuItems: current.menuItems.map((row) =>
                                          row.id === item.id ? { ...row, specGroups: undefined } : row,
                                        ),
                                      }));
                                      setStatus("已清空菜品規格，請保存菜單。");
                                    }}
                                    type="button"
                                  >
                                    清空
                                  </button>
                                </>
                              ) : (
                                <span className="text-[11px] text-slate-400">無規格</span>
                              )}
                              <span className="min-w-2 flex-1" />
                              <button
                                className="shrink-0 rounded-xl bg-orange-50 px-3 py-1.5 text-xs font-semibold text-orange-600 ring-1 ring-orange-100 transition hover:bg-orange-100 active:scale-95"
                                onClick={() => openSpecEditorForItem(item.id, item.specGroups)}
                                type="button"
                              >
                                編輯規格
                              </button>
                              <select
                                aria-label="套用模板（可選）"
                                className="w-auto max-w-[180px] shrink-0 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs"
                                onChange={(event) => {
                                  const templateId = event.target.value;
                                  if (!templateId) return;
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
                                title="可選：由模板快速套用；模板喺「規格管理」維護"
                                value=""
                              >
                                <option value="">套用模板…</option>
                                {localSettings.specTemplates.map((template) => (
                                  <option key={template.id} value={template.id}>
                                    {template.name}
                                  </option>
                                ))}
                              </select>
                              <button
                                className="shrink-0 rounded-xl bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-600 ring-1 ring-red-100 transition hover:bg-red-100 active:scale-95"
                                onClick={() => {
                                  if (!window.confirm(`確定刪除「${item.name}」？按「保存菜單」後先正式生效。`)) return;
                                  setMenuDraft((current) => ({
                                    ...current,
                                    menuItems: current.menuItems.filter((row) => row.id !== item.id),
                                  }));
                                  setStatus(`已刪除菜品「${item.name}」，請保存菜單。`);
                                }}
                                type="button"
                              >
                                刪除
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                )}
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
                                    // 編號跟「可見枱」計：temp 枱唔顯示，計埋會令編號跳號
                                    {
                                      id: crypto.randomUUID(),
                                      name: `桌號${item.tables.filter((t) => !isReopenTempTable(t)).length + 1}`,
                                      area: item.name,
                                      floorId: item.id,
                                      capacity: 4,
                                    },
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
                    {/* ⚠️ 必須 filter 走返結 temp 枱：temp 枱只喺「返結單編輯期間」存在，
                        唔係真實枱。喺管理頁顯示會令 admin 以為係真實枱而改名 / 改座位數，
                        一撳保存就連 bootstrap 都寫埋 → 永久升級做真實枱（根因）。
                        見 pos/table-scope.ts。 */}
                    {floor.tables.filter((table) => !isReopenTempTable(table)).map((table) => (
                      <div key={table.id} className="flex flex-col gap-1">
                        <input
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
                        <input
                          type="number"
                          min={1}
                          className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900"
                          onChange={(event) =>
                            setLocalSettings((current) => ({
                              ...current,
                              floors: current.floors.map((item) =>
                                item.id === floor.id
                                  ? {
                                      ...item,
                                      tables: item.tables.map((currentTable) =>
                                        currentTable.id === table.id
                                          ? { ...currentTable, capacity: Number(event.target.value) || undefined }
                                          : currentTable,
                                      ),
                                    }
                                  : item,
                              ),
                            }))
                          }
                          placeholder="座位數"
                          value={table.capacity ?? ""}
                        />
                        <button
                          className="rounded-xl bg-white px-2 py-1.5 text-xs font-semibold text-red-600 ring-1 ring-red-200 hover:bg-red-50"
                          onClick={() => removeTable(floor.id, table.id)}
                          type="button"
                        >
                          刪除
                        </button>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null  }



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
                <div className="flex items-center gap-2" key={`${method}-${index}`}>
                  <input
                    className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-900"
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
                  <button
                    className="shrink-0 rounded-xl bg-red-50 px-3 py-2.5 text-xs font-semibold text-red-600 ring-1 ring-red-100 transition hover:bg-red-100 active:scale-95"
                    onClick={() => {
                      if (!window.confirm(`確定刪除支付方式「${method}」？按「保存」後先正式生效。`)) return;
                      setLocalSettings((current) => ({
                        ...current,
                        paymentMethods: current.paymentMethods.filter((_, itemIndex) => itemIndex !== index),
                      }));
                    }}
                    type="button"
                  >
                    刪除
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-4 flex justify-end gap-2 border-t border-slate-100 pt-4">
              <button
                className="rounded-2xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                aria-busy={syncingConfig}
                disabled={syncingConfig}
                onClick={() => void saveAll("保存支付方式")}
                type="button"
              >
                {syncingConfig ? "同步中…" : "保存"}
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
              specEditor.mode === "template" ? (
                <div className="flex flex-wrap items-center gap-2">
                  {specEditor.templateId ? (
                    <button
                      className="rounded-2xl bg-red-50 px-4 py-2 text-sm font-semibold text-red-600 ring-1 ring-red-100 transition hover:bg-red-100"
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
                  <button
                    className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                    onClick={closeSpecEditor}
                    type="button"
                  >
                    取消
                  </button>
                  <button
                    className="rounded-2xl bg-slate-900 px-5 py-2 text-sm font-semibold text-white"
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
                </div>
              ) : specEditor.mode === "group" ? (
                <div className="flex flex-wrap items-center gap-2">
                  {specEditor.templateId ? (
                    <button
                      className="rounded-2xl bg-red-50 px-4 py-2 text-sm font-semibold text-red-600 ring-1 ring-red-100 transition hover:bg-red-100"
                      onClick={() => {
                        if (!specEditor.templateId) return;
                        if (!window.confirm("確定刪除此獨立規格？已加入菜品嘅規格係快照拷貝，唔會受影響。")) return;
                        const next = {
                          ...localSettings,
                          standaloneSpecGroups: localSettings.standaloneSpecGroups.filter(
                            (row) => row.id !== specEditor.templateId,
                          ),
                        };
                        setLocalSettings(next);
                        savePosLocalSettings(next);
                        closeSpecEditor();
                        setStatus("已刪除獨立規格。");
                      }}
                      type="button"
                    >
                      刪除規格
                    </button>
                  ) : null}
                  <button
                    className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                    onClick={closeSpecEditor}
                    type="button"
                  >
                    取消
                  </button>
                  <button
                    className="rounded-2xl bg-slate-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    disabled={!specEditor.draft[0]?.name.trim()}
                    onClick={() => {
                      const group = specEditor.draft[0];
                      if (!group || !group.name.trim()) return;
                      const groupId = specEditor.templateId ?? group.id;
                      const next = {
                        ...localSettings,
                        standaloneSpecGroups: localSettings.standaloneSpecGroups.some((row) => row.id === groupId)
                          ? localSettings.standaloneSpecGroups.map((row) =>
                              row.id === groupId ? { ...group, id: groupId } : row,
                            )
                          : [...localSettings.standaloneSpecGroups, { ...group, id: groupId }],
                      };
                      setLocalSettings(next);
                      savePosLocalSettings(next);
                      closeSpecEditor();
                      setStatus(`已保存獨立規格「${group.name.trim()}」，可喺菜品「編輯規格」剔選加入。`);
                    }}
                    type="button"
                  >
                    保存規格
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                    onClick={closeSpecEditor}
                    type="button"
                  >
                    取消
                  </button>
                  <button
                    className="rounded-2xl bg-indigo-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    disabled={menuSaving}
                    onClick={async () => {
                      // 單一「保存」：套用所揀模板規格到該菜品，並即時寫入 server
                      //（沿用 saveMenuToBackend 全量保存通道；規格空 = 清空該菜品規格）。
                      if (!specEditor.itemId) return;
                      const nextSpec = specEditor.draft.length ? cloneSpecGroups(specEditor.draft) : undefined;
                      const nextDraft = {
                        ...menuDraft,
                        menuItems: menuDraft.menuItems.map((row) =>
                          row.id === specEditor.itemId ? { ...row, specGroups: nextSpec } : row,
                        ),
                      };
                      setMenuDraft(nextDraft);
                      const ok = await saveMenuToBackend(nextDraft);
                      closeSpecEditor();
                      setStatus(
                        ok
                          ? "已套用規格並保存到 server。"
                          : "已更新本機規格，但保存到 server 失敗；請稍後按「保存菜單」補傳。",
                      );
                    }}
                    type="button"
                  >
                    {menuSaving ? "保存中…" : "保存"}
                  </button>
                </div>
              )
            }
            bodyClassName="grid content-start gap-4"
            description={
              specEditor.mode === "template"
                ? "喺呢度定義規格組同選項；菜品只會喺「編輯規格」揀現成模板套用。"
                : specEditor.mode === "group"
                  ? "定義單一規格組（名稱／單選多選／必選／選項加價）；菜品「編輯規格」可自由剔選加入。"
                  : "揀模板做基底（可選），剔選加入獨立規格，按「保存」即時更新到 server。"
            }
            onClose={closeSpecEditor}
            panelClassName="h-[min(85dvh,760px)]"
            title={
              specEditor.mode === "template"
                ? specEditor.templateId
                  ? "編輯規格模板"
                  : "新增規格模板"
                : specEditor.mode === "group"
                  ? specEditor.templateId
                    ? "編輯獨立規格"
                    : "新增獨立規格"
                  : `編輯規格 · ${menuDraft.menuItems.find((row) => row.id === specEditor.itemId)?.name ?? ""}`
            }
            widthClassName="max-w-3xl"
          >
              {specEditor.mode !== "item" ? (
                <>
                  {specEditor.mode === "template" ? (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
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
                  ) : null}
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
                </>
              ) : (
                /* 菜品模式：揀模板做基底 + 剔選獨立規格 → 預覽 → 保存；唔喺呢度建立／修改規格組 */
                <>
                  <div className="grid gap-2">
                    <div className="text-xs font-medium text-slate-400">選擇規格模板（可選；揀選會作為基底取代目前組合）</div>
                    {localSettings.specTemplates.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                        尚未有規格模板。請先去「規格管理 › 新增模板」定義規格，再返嚟套用。
                      </div>
                    ) : (
                      localSettings.specTemplates.map((template) => {
                        const active = specEditor.templateId === template.id;
                        return (
                          <button
                            className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl border p-3 text-left transition ${
                              active
                                ? "border-orange-300 bg-orange-50/70 ring-2 ring-orange-200"
                                : "border-slate-200 bg-white hover:bg-slate-50"
                            }`}
                            key={template.id}
                            onClick={() =>
                              setSpecEditor((current) => ({
                                ...current,
                                templateId: template.id,
                                draft: cloneSpecGroups(template.specGroups),
                              }))
                            }
                            type="button"
                          >
                            <span className="shrink-0 text-sm font-semibold text-slate-900">{template.name}</span>
                            <span className="flex flex-wrap gap-1.5">
                              {(template.specGroups ?? []).map((group) => (
                                <span
                                  className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600"
                                  key={group.id}
                                >
                                  {group.name}·{group.options.length}項
                                </span>
                              ))}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>

                  <div className="grid gap-2">
                    <div className="text-xs font-medium text-slate-400">加入獨立規格（喺「規格管理 › 獨立規格」新增／維護；剔選即加入／移除）</div>
                    {localSettings.standaloneSpecGroups.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
                        尚未有獨立規格。唔想開模板嘅話，可以直接去「規格管理 › 獨立規格 › 新增規格」建立（例如「辣度」「走蔥」），再返嚟剔選加入。
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {localSettings.standaloneSpecGroups.map((group) => {
                          const inDraft = specEditor.draft.some((row) => row.id === group.id);
                          return (
                            <button
                              className={`flex items-center gap-1.5 rounded-2xl border px-3 py-2 text-sm transition ${
                                inDraft
                                  ? "border-orange-300 bg-orange-50/70 font-semibold text-orange-700 ring-2 ring-orange-200"
                                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                              }`}
                              key={group.id}
                              onClick={() =>
                                setSpecEditor((current) => ({
                                  ...current,
                                  draft: inDraft
                                    ? current.draft.filter((row) => row.id !== group.id)
                                    : [...current.draft, cloneSpecGroups([group])[0]],
                                }))
                              }
                              type="button"
                            >
                              <span>{inDraft ? "✓" : "＋"}</span>
                              <span>
                                {group.name}·{group.options.length}項
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                    <div className="mb-2 text-xs font-medium text-slate-400">
                      {specEditor.templateId === null
                        ? "目前規格（揀模板或剔選獨立規格後按「保存」）"
                        : "將套用嘅規格預覽"}
                    </div>
                    {specEditor.draft.length === 0 ? (
                      <div className="text-sm text-slate-400">揀選上方模板後，喺呢度預覽將會套用嘅規格內容。</div>
                    ) : (
                      <div className="grid gap-2">
                        {specEditor.draft.map((group) => (
                          <div className="text-sm text-slate-700" key={group.id}>
                            <span className="font-semibold text-slate-900">{group.name}</span>
                            {group.required ? <span className="ml-1 text-xs text-red-400">必選</span> : null}
                            <span className="ml-2 text-slate-500">
                              {group.options
                                .map((opt) => (opt.priceDelta > 0 ? `${opt.label}(+${opt.priceDelta})` : opt.label))
                                .join("、")}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
          </ResponsiveModal>
        ) : null}

        {menuItemModal ? (
          <ResponsiveModal
            actions={
              <div className="flex w-full flex-wrap items-center justify-end gap-3">
                {menuItemError ? (
                  <div className="mr-auto min-w-0 flex-1 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
                    {menuItemError}
                  </div>
                ) : null}
                <button
                  className="min-h-12 rounded-2xl bg-white px-6 py-3 text-base font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 transition active:scale-95 disabled:opacity-60"
                  disabled={menuItemSaving}
                  onClick={() => {
                    setMenuItemModal(null);
                    setMenuItemError(null);
                  }}
                  type="button"
                >
                  取消
                </button>
                <button
                  className="min-h-12 rounded-2xl bg-orange-500 px-8 py-3 text-base font-semibold text-white transition active:scale-95 disabled:opacity-60"
                  disabled={menuItemSaving}
                  onClick={() => void saveMenuItemModal()}
                  type="button"
                >
                  {menuItemSaving ? "保存中…" : "保存菜品"}
                </button>
              </div>
            }
            description="填寫菜品資料；保存後即時寫入後台並更新菜單列表。"
            onClose={() => {
              if (!menuItemSaving) {
                setMenuItemModal(null);
                setMenuItemError(null);
                closeQuickSpecDraft();
              }
            }}
            title="新增菜品"
            widthClassName="max-w-2xl"
          >
            <div className="grid content-start gap-4">
              {/* 菜品名稱 */}
              <label className="grid gap-1.5">
                <span className="text-sm font-semibold text-slate-700">
                  菜品名稱 <span className="text-red-500">*</span>
                </span>
                <input
                  autoFocus
                  className="min-h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-base outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                  onChange={(event) =>
                    setMenuItemModal((current) => (current ? { ...current, name: event.target.value } : current))
                  }
                  placeholder="例如：表嫂雞飯"
                  value={menuItemModal.name}
                />
              </label>

              {/* 分類 + 打印分區 */}
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5">
                  <span className="text-sm font-semibold text-slate-700">
                    分類 <span className="text-red-500">*</span>
                  </span>
                  <select
                    className="min-h-12 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-base"
                    onChange={(event) =>
                      setMenuItemModal((current) => (current ? { ...current, categoryId: event.target.value } : current))
                    }
                    value={menuItemModal.categoryId}
                  >
                    {menuDraft.categories.length === 0 ? <option value="">（未有分類）</option> : null}
                    {menuDraft.categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1.5">
                  <span className="text-sm font-semibold text-slate-700">打印位置（分區）</span>
                  <select
                    className="min-h-12 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-base"
                    onChange={(event) =>
                      setMenuItemModal((current) => (current ? { ...current, printerGroup: event.target.value } : current))
                    }
                    value={menuItemModal.printerGroup}
                  >
                    {localSettings.printZones.map((zone) => (
                      <option key={zone.id} value={zone.id}>
                        {zone.name}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-slate-400">廚房單會按分區派印；分區喺「打印設置」維護。</span>
                </label>
              </div>

              {/* 價格 + 原價 */}
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5">
                  <span className="text-sm font-semibold text-slate-700">
                    價格（MOP）
                    {menuItemModal.isMarketPrice ? <span className="ml-1 text-xs text-slate-400">（時價菜可留空）</span> : <span className="text-red-500">*</span>}
                  </span>
                  <input
                    className="min-h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-base outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                    inputMode="decimal"
                    onChange={(event) =>
                      setMenuItemModal((current) => (current ? { ...current, price: event.target.value } : current))
                    }
                    placeholder="0"
                    value={menuItemModal.price}
                  />
                </label>
                <label className="grid gap-1.5">
                  <span className="text-sm font-semibold text-slate-700">
                    原價（MOP）<span className="ml-1 text-xs font-normal text-slate-400">選填，配合折扣用</span>
                  </span>
                  <input
                    className="min-h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-base outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                    inputMode="decimal"
                    onChange={(event) =>
                      setMenuItemModal((current) => (current ? { ...current, originalPrice: event.target.value } : current))
                    }
                    placeholder="留空 = 價格即原價"
                    value={menuItemModal.originalPrice}
                  />
                </label>
              </div>

              {/* 折扣 + 圖片 */}
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5">
                  <span className="text-sm font-semibold text-slate-700">
                    折扣（%）<span className="ml-1 text-xs font-normal text-slate-400">選填</span>
                  </span>
                  <input
                    className="min-h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-base outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                    inputMode="numeric"
                    onChange={(event) =>
                      setMenuItemModal((current) => (current ? { ...current, discountRate: event.target.value } : current))
                    }
                    placeholder="80 = 8折"
                    value={menuItemModal.discountRate}
                  />
                </label>
                <label className="grid gap-1.5">
                  <span className="text-sm font-semibold text-slate-700">
                    圖片 URL<span className="ml-1 text-xs font-normal text-slate-400">選填</span>
                  </span>
                  <input
                    className="min-h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-base outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                    onChange={(event) =>
                      setMenuItemModal((current) => (current ? { ...current, image: event.target.value } : current))
                    }
                    placeholder="https://…"
                    value={menuItemModal.image}
                  />
                </label>
              </div>

              {/* 開關 */}
              <div className="flex flex-wrap gap-x-8 gap-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <label className="flex min-h-11 items-center gap-2.5 text-base text-slate-700" title="時價菜：落單時改價">
                  <input
                    checked={menuItemModal.isMarketPrice}
                    className="h-5 w-5 rounded border-slate-300"
                    onChange={(event) =>
                      setMenuItemModal((current) => (current ? { ...current, isMarketPrice: event.target.checked } : current))
                    }
                    type="checkbox"
                  />
                  時價菜（落單時輸入當次價錢）
                </label>
                <label className="flex min-h-11 items-center gap-2.5 text-base text-slate-700" title="掃碼點餐 / Kiosk 可見">
                  <input
                    checked={menuItemModal.customerOrderable}
                    className="h-5 w-5 rounded border-slate-300"
                    onChange={(event) =>
                      setMenuItemModal((current) =>
                        current ? { ...current, customerOrderable: event.target.checked } : current,
                      )
                    }
                    type="checkbox"
                  />
                  客人可點（掃碼點餐可見）
                </label>
              </div>

              {/* 規格 */}
              <div className="rounded-2xl border border-slate-200 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-700">
                    規格<span className="ml-1 text-xs font-normal text-slate-400">選填；可套用模板、剔選獨立規格，或快捷新增</span>
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    {menuItemModal.specGroups.length > 0 ? (
                      <button
                        className="rounded-xl px-3 py-1.5 text-xs font-semibold text-red-500 ring-1 ring-red-100 transition hover:bg-red-50 active:scale-95"
                        onClick={() => setMenuItemModal((current) => (current ? { ...current, specGroups: [] } : current))}
                        type="button"
                      >
                        清空規格
                      </button>
                    ) : null}
                    {!quickSpecDraft ? (
                      <button
                        className="rounded-xl bg-orange-50 px-3 py-1.5 text-xs font-semibold text-orange-600 ring-1 ring-orange-100 transition hover:bg-orange-100 active:scale-95"
                        onClick={openQuickSpecDraft}
                        type="button"
                        title="喺呢度直接建立新規格；會自動存入「規格管理 › 獨立規格」供日後復用"
                      >
                        ＋ 新增規格
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="mt-3 grid gap-3">
                  {menuItemModal.specGroups.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {menuItemModal.specGroups.map((group) => (
                        <span
                          className="whitespace-nowrap rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600"
                          key={group.id}
                        >
                          {group.name}·{group.options.length}項{group.required ? "·必選" : ""}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-xs text-slate-400">尚未加入規格。</span>
                  )}
                  {/* 快捷新增規格（2026-09-09）：喺彈窗內直接建立，唔使跳去「規格管理」；
                      保存後自動存入獨立規格（規格管理可見、其他菜品可復用）並推 server 同步 */}
                  {quickSpecDraft ? (
                    <div className="rounded-2xl border border-orange-200 bg-orange-50/70 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          autoFocus
                          className="w-[180px] rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900"
                          onChange={(event) => updateQuickSpecDraft((group) => ({ ...group, name: event.target.value }))}
                          placeholder="規格名（例如：甜度）"
                          value={quickSpecDraft.name}
                        />
                        <select
                          className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                          onChange={(event) =>
                            updateQuickSpecDraft((group) => ({
                              ...group,
                              selectionMode: event.target.value as MenuSpecGroup["selectionMode"],
                            }))
                          }
                          value={quickSpecDraft.selectionMode}
                        >
                          <option value="single">單選</option>
                          <option value="multi">多選</option>
                        </select>
                        <label className="flex items-center gap-2 text-sm text-slate-700">
                          <input
                            checked={quickSpecDraft.required}
                            className="h-4 w-4 rounded border-slate-300"
                            onChange={(event) => updateQuickSpecDraft((group) => ({ ...group, required: event.target.checked }))}
                            type="checkbox"
                          />
                          必選
                        </label>
                      </div>
                      <div className="mt-2 grid gap-2">
                        {quickSpecDraft.options.map((opt) => (
                          <div key={opt.id} className="grid gap-2 md:grid-cols-[minmax(0,1fr)_110px_70px]">
                            <input
                              className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                              onChange={(event) =>
                                updateQuickSpecDraft((group) => ({
                                  ...group,
                                  options: group.options.map((o) =>
                                    o.id === opt.id ? { ...o, label: event.target.value } : o,
                                  ),
                                }))
                              }
                              placeholder="選項（例如：少冰）"
                              value={opt.label}
                            />
                            <input
                              className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                              inputMode="decimal"
                              onChange={(event) =>
                                updateQuickSpecDraft((group) => ({
                                  ...group,
                                  options: group.options.map((o) =>
                                    o.id === opt.id ? { ...o, priceDelta: Number(event.target.value) || 0 } : o,
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
                                updateQuickSpecDraft((group) => ({
                                  ...group,
                                  options: group.options.filter((o) => o.id !== opt.id),
                                }))
                              }
                              type="button"
                            >
                              刪除
                            </button>
                          </div>
                        ))}
                        <button
                          className="justify-self-start rounded-2xl bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white"
                          onClick={() =>
                            updateQuickSpecDraft((group) => ({
                              ...group,
                              options: [...group.options, { id: crypto.randomUUID(), label: "", priceDelta: 0 }],
                            }))
                          }
                          type="button"
                        >
                          ＋ 新增選項
                        </button>
                      </div>
                      {quickSpecError ? (
                        <div className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700">
                          {quickSpecError}
                        </div>
                      ) : null}
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs text-slate-500">
                          保存後自動存入「規格管理 › 獨立規格」，其他菜品可剔選復用。
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                            onClick={closeQuickSpecDraft}
                            type="button"
                          >
                            取消
                          </button>
                          <button
                            className="rounded-2xl bg-orange-500 px-4 py-2 text-xs font-semibold text-white"
                            onClick={() => void saveQuickSpecDraft()}
                            type="button"
                          >
                            保存並加入
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                  {localSettings.specTemplates.length > 0 ? (
                    <select
                      className="min-h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm"
                      onChange={(event) => {
                        const templateId = event.target.value;
                        if (!templateId) return;
                        const template = localSettings.specTemplates.find((row) => row.id === templateId);
                        if (!template) return;
                        setMenuItemModal((current) =>
                          current ? { ...current, specGroups: cloneSpecGroups(template.specGroups) } : current,
                        );
                        event.target.value = "";
                      }}
                      value=""
                    >
                      <option value="">套用規格模板…（模板喺「規格管理」維護）</option>
                      {localSettings.specTemplates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name}（{template.specGroups.length} 個規格組）
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {localSettings.standaloneSpecGroups.length > 0 ? (
                    <div className="grid gap-1">
                      <span className="text-xs font-medium text-slate-500">獨立規格組（剔選加入）</span>
                      {localSettings.standaloneSpecGroups.map((group) => {
                        const checked = menuItemModal.specGroups.some((row) => row.id === group.id);
                        return (
                          <label
                            className="flex min-h-11 items-center gap-2.5 rounded-xl px-2 text-sm text-slate-700 transition hover:bg-slate-50"
                            key={group.id}
                          >
                            <input
                              checked={checked}
                              className="h-5 w-5 rounded border-slate-300"
                              onChange={() => toggleMenuItemModalStandaloneSpec(group.id)}
                              type="checkbox"
                            />
                            <span className="min-w-0 truncate">
                              {group.name}
                              <span className="ml-1.5 text-xs text-slate-400">
                                {group.selectionMode === "single" ? "單選" : "多選"}
                                {group.required ? "·必選" : ""}·{group.options.length}項
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  ) : null}
                  {localSettings.specTemplates.length === 0 && localSettings.standaloneSpecGroups.length === 0 ? (
                    <span className="text-xs text-slate-400">
                      未有規格模板／獨立規格組；可直接按上方「＋ 新增規格」快捷新增（自動存入規格管理），或套用模板／到「規格管理」建立。
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          </ResponsiveModal>
        ) : null}
        </div>
      </div>
    </div>
  );
}

// ── 打印開關設置（2026-09-08）────────────────────────────────────────
//
// 細粒度總開關：商家可逐項關閉「自動流程」嘅打印類型。手動掣（點餐介面「打印廚房單」/
//「打印收據」、訂單列「重打整單」、打印中心「重打整單」、交班頁「重打交班單」等）永遠
// 唔受呢啲開關影響，係用戶當下意圖，唔可以偷偷食掉。
//
// 範圍：
//   廚房單        — 收銀落單／加單 + 線上單接單（bridge → pos）+ 自助單補建
//   飲品標籤單    — 收銀落單／加單 + 線上單接單（label role 機）
//   結帳收據      — 收銀結帳 + 免單 + 線上單完成+已付 + 到店付款
//   退菜單        — 收銀退菜／退桌 + 線上單取消
//   返結單        — 已結單退回可編輯
//   自助機小票    — 自助點餐機（kiosk）落單即時印
//   交班單        — closeShift
//
// 真源：`PosLocalSettings.printContentToggles`，per-terminal，唔跨店（見 types.ts）。
// 立即寫 `setLocalSettings + savePosLocalSettings`（同常用備註一致），唔等設備頁
//「保存」掣。
type PrintContentToggleRow = {
  key: keyof PrintContentToggles;
  label: string;
  description: string;
};

const PRINT_CONTENT_TOGGLE_ROWS: ReadonlyArray<PrintContentToggleRow> = [
  {
    key: "kitchen",
    label: "廚房單",
    description: "收銀落單／加單、線上單接單、自助單補建。對應分區打印機（zone role）。",
  },
  {
    key: "label",
    label: "飲品標籤單",
    description: "收銀落單／加單、線上單接單。對應標籤打印機（label role，62mm 標籤卷）。",
  },
  {
    key: "receipt",
    label: "結帳收據",
    description: "收銀結帳、免單、線上單完成+已付、到店付款。對應收據打印機。",
  },
  {
    key: "void",
    label: "退菜／退桌單",
    description: "收銀退單項／全單退、退桌、線上單取消。影響分區 + 標籤打印機。",
  },
  {
    key: "reopen",
    label: "返結單",
    description: "已結帳單退回可編輯狀態時出嘅修正單（含原因 + 操作人）。",
  },
  {
    key: "kiosk",
    label: "自助機小票",
    description: "自助點餐機（kiosk）落單後即時印嘅顧客小票（本機排隊、唔上雲）。",
  },
  {
    key: "shift",
    label: "交班單",
    description: "收工時出嘅交班明細單（交班單打印機或收據打印機 fallback）。",
  },
] as const;

function PrintContentTogglesSection({
  toggles,
  onChange,
}: {
  toggles: PrintContentToggles;
  onChange: (next: PrintContentToggles) => void;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 max-h-[calc(100dvh-150px)] flex flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-base font-semibold text-slate-900">打印開關設置</div>
          <div className="mt-1 text-sm text-slate-500">
            關閉後對應類型嘅自動打印唔會出單（例如唔想出退菜單就熄「退菜／退桌單」）。
            手動掣（打印廚房單、打印收據、重打整單、重打交班單等）永遠不受呢啲開關影響。
          </div>
        </div>
      </div>

      <div className="mt-4 flex-1 overflow-auto pr-1">
        <div className="grid gap-2">
          {PRINT_CONTENT_TOGGLE_ROWS.map((row) => {
            // 嚴格只接受 boolean：normalizePosLocalSettings 已保證 default 填好；
            // 呢度用 `!== false` 係雙重保險，避免任何 undefined 導致 UI 顯示成「關」。
            const enabled = toggles[row.key] !== false;
            return (
              <div
                key={row.key}
                className="flex items-start justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-slate-900">{row.label}</div>
                  <div className="mt-0.5 text-xs leading-relaxed text-slate-500">
                    {row.description}
                  </div>
                </div>
                <div className="shrink-0 pt-0.5">
                  <AutoAcceptPill
                    ariaLabel={`${row.label}打印`}
                    enabled={enabled}
                    label={enabled ? "自動打印" : "已關閉"}
                    onChange={(next) => onChange({ ...toggles, [row.key]: next })}
                    size="sm"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

