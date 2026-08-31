import {
  AccountPermissionGroup,
  AccountStore,
  AccountUser,
  DeviceConfig,
  EscPosBlockStyle,
  PosBootstrap,
  PosLocalSettings,
  PosOrder,
  PrintJob,
  QueueEvent,
  UserPermissions,
  UserRole,
} from "@/lib/types";
import {
  defaultAccountStores,
  defaultAccountUsers,
  defaultPermissionGroups,
  defaultPosLocalSettings,
} from "@/lib/mock-data";
import {
  DEFAULT_KIOSK_TEMPLATE,
  DEFAULT_KITCHEN_TEMPLATE,
  DEFAULT_LABEL_TEMPLATE,
  DEFAULT_RECEIPT_TEMPLATE,
} from "@/lib/escpos-template";

const KEYS = {
  offlineMode: "macau-pos/offline-mode",
  authSession: "macau-pos/auth-session",
  accountUsers: "macau-pos/account-users",
  accountStores: "macau-pos/account-stores",
  permissionGroups: "macau-pos/permission-groups",
} as const;

/** 每店獨立的 localStorage 後綴（實際 key：`macau-pos/stores/{merchantId}/{suffix}`） */
const STORE_SUFFIX = {
  bootstrap: "bootstrap",
  deviceConfig: "device-config",
  queue: "sync-queue",
  orders: "orders",
  printJobs: "print-jobs",
  localSettings: "local-settings",
  soldOut: "sold-out",
  shift: "shift",
  shiftHistory: "shift-history",
  operatingMode: "operating-mode",
  quickAutoAccept: "quick-auto-accept",
  quickCompletedMinutes: "quick-completed-minutes",
  // tombstone：本機已主動清除 / 刪除嘅記錄 id，backfill 唔可以將伺服器行復活佢哋（見 docs/52）
  clearedPrintJobIds: "cleared-print-jobs",
  deletedOrderIds: "deleted-orders",
  // 本地每日序號（offline / sequence API 失敗嗰陣做 fallback，取代隨機時戳）：
  // 按 日期+kind 各自遞增，保證 fallback 單號單調、不重複、易讀（見 docs/56）。
  localDailySeq: "local-daily-seq",
} as const;

type StoreSuffix = (typeof STORE_SUFFIX)[keyof typeof STORE_SUFFIX];

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") {
    return fallback;
  }

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return fallback;
  }
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    // 唔再靜默 ignore：回報失敗畀上層（docs/71 P1-A）。常見原因：私隱模式 / quota 滿 / kiosk WebView 限制。
    console.error("[writeJson FAIL]", key, e instanceof Error ? e.message : e);
    return false;
  }
}

function legacyGlobalKey(suffix: StoreSuffix): string {
  return `macau-pos/${suffix}`;
}

function storeScopedStorageKey(suffix: StoreSuffix, merchantId?: string | null): string {
  const scope = merchantId ?? getActiveMerchantId();
  if (!scope) return legacyGlobalKey(suffix);
  return `macau-pos/stores/${scope}/${suffix}`;
}

function readStoreJson<T>(suffix: StoreSuffix, fallback: T, merchantId?: string | null): T {
  return readJson(storeScopedStorageKey(suffix, merchantId), fallback);
}

function writeStoreJson<T>(suffix: StoreSuffix, value: T, merchantId?: string | null): boolean {
  return writeJson(storeScopedStorageKey(suffix, merchantId), value);
}

function readLegacyBootstrapStoreId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(legacyGlobalKey("bootstrap"));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { storeId?: string };
    return parsed.storeId ?? null;
  } catch {
    return null;
  }
}

function legacyDataBelongsToMerchant(merchantId: string): boolean {
  const legacyStoreId = readLegacyBootstrapStoreId();
  if (!legacyStoreId) return true;
  return legacyStoreId === merchantId;
}

/** 登入後將舊版全局 cache 遷移至當前 merchant（僅當 legacy bootstrap 屬於該店）。 */
export function prepareStoreStorage(merchantId: string) {
  if (typeof window === "undefined" || !merchantId) return;
  if (!legacyDataBelongsToMerchant(merchantId)) return;

  for (const suffix of Object.values(STORE_SUFFIX)) {
    const scopedKey = storeScopedStorageKey(suffix, merchantId);
    if (window.localStorage.getItem(scopedKey)) continue;

    const legacyRaw = window.localStorage.getItem(legacyGlobalKey(suffix));
    if (!legacyRaw) continue;

    window.localStorage.setItem(scopedKey, legacyRaw);
  }

  for (const suffix of Object.values(STORE_SUFFIX)) {
    const legacyKey = legacyGlobalKey(suffix);
    const scopedKey = storeScopedStorageKey(suffix, merchantId);
    if (window.localStorage.getItem(legacyKey) && window.localStorage.getItem(scopedKey)) {
      window.localStorage.removeItem(legacyKey);
    }
  }
}

export function getActiveStoreId(): string | null {
  return getActiveMerchantId();
}

function getActiveMerchantId(): string | null {
  const raw = readJson<Partial<{ merchantId?: string }> | null>(KEYS.authSession, null);
  return raw?.merchantId ?? null;
}

/**
 * 模板設定嘅穩定 store scope（docs/71 P1-B）：
 * 優先登入店（authSession.merchantId）；無 session（kiosk / 未登入）時用 bootstrap 記錄嘅 storeId，
 * 確保「設計介面 save」同「打印 load」永遠讀寫同一個 key，唔會因 authSession 當下值變動而 scope 翻轉。
 */
function resolveSettingsStoreScope(): string | null {
  const mid = getActiveMerchantId();
  if (mid) return mid;
  const boot = loadBootstrapCache();
  return boot?.storeId ?? null;
}

/** 畀 UI read-back 驗證用：返回當前模板設定實際寫入嘅 localStorage key。 */
export function getLocalSettingsKey(): string {
  return storeScopedStorageKey(STORE_SUFFIX.localSettings, resolveSettingsStoreScope());
}

export function normalizeDeviceConfig(config: DeviceConfig | null | undefined): DeviceConfig | null {
  if (!config) return null;
  return {
    ...config,
    printers: Array.isArray(config.printers)
      ? config.printers.map((printer, index) => ({
          // 先 spread 原物件，保留 charset / connectionType / usbVendorId / usbProductId /
          // bluetoothName / bluetoothAddress / autoDetected 等字段，避免每次 load 被 normalize 掉。
          ...printer,
          id: printer.id ?? `printer-${index}`,
          role:
            printer.role ??
            ((printer as { group?: string }).group === "receipt"
              ? "receipt"
              : (printer as { group?: string }).group
                ? "zone"
                : "zone"),
          zoneId:
            printer.zoneId ??
            ((printer as { group?: string }).group && (printer as { group?: string }).group !== "receipt"
              ? (printer as { group?: string }).group
              : undefined),
          connectionType: printer.connectionType ?? "lan",
          name: printer.name ?? `打印機 ${index + 1}`,
          model: printer.model ?? "",
          paperSize: printer.paperSize ?? "",
          ipAddress: printer.ipAddress ?? "",
          lanPort: Number(printer.lanPort ?? 9100) || 9100,
          enabled: Boolean(printer.enabled),
          charset: printer.charset ?? undefined,
          usbVendorId: printer.usbVendorId ?? undefined,
          usbProductId: printer.usbProductId ?? undefined,
          bluetoothName: printer.bluetoothName ?? undefined,
          bluetoothAddress: printer.bluetoothAddress ?? undefined,
          autoDetected: printer.autoDetected ?? undefined,
        }))
      : [],
  };
}

/** 將商家儲存嘅 block 樣式 merge 落預設（逐 id 合併 visible/size/bold/align），保證新 section 唔會失蹤 */
function mergeTemplateBlocks<T extends string>(
  def: Record<T, EscPosBlockStyle>,
  stored?: Partial<Record<T, EscPosBlockStyle>>,
): Record<T, EscPosBlockStyle> {
  const out: Record<T, EscPosBlockStyle> = { ...def };
  if (stored) {
    for (const id of Object.keys(def) as T[]) {
      const s = stored[id];
      if (s) out[id] = { ...def[id], ...s };
    }
  }
  return out;
}

/** 順序：保留商家儲存嘅排序，過濾無效 id，並將預設入面新增大嘅 section 補落尾 */
function mergeTemplateOrder<T extends string>(def: T[], stored?: T[]): T[] {
  if (!Array.isArray(stored) || stored.length === 0) return [...def];
  const valid = stored.filter((id) => (def as T[]).includes(id));
  const missing = def.filter((id) => !valid.includes(id));
  return [...valid, ...missing];
}

export function normalizePosLocalSettings(settings: Partial<PosLocalSettings> | null | undefined): PosLocalSettings {
  return {
    floors: Array.isArray(settings?.floors) ? settings.floors : defaultPosLocalSettings.floors,
    paymentMethods: Array.isArray(settings?.paymentMethods)
      ? settings.paymentMethods
      : defaultPosLocalSettings.paymentMethods,
    menuPrinterOverrides:
      settings?.menuPrinterOverrides && typeof settings.menuPrinterOverrides === "object"
        ? settings.menuPrinterOverrides
        : defaultPosLocalSettings.menuPrinterOverrides,
    printZones: Array.isArray(settings?.printZones) ? settings.printZones : defaultPosLocalSettings.printZones,
    specTemplates: Array.isArray(settings?.specTemplates) ? settings.specTemplates : defaultPosLocalSettings.specTemplates,
    printTemplates: {
      receipt: {
        blocks: mergeTemplateBlocks(DEFAULT_RECEIPT_TEMPLATE.blocks, settings?.printTemplates?.receipt?.blocks),
        order: mergeTemplateOrder(DEFAULT_RECEIPT_TEMPLATE.order, settings?.printTemplates?.receipt?.order),
        footerText: settings?.printTemplates?.receipt?.footerText ?? DEFAULT_RECEIPT_TEMPLATE.footerText,
      },
      label: {
        blocks: mergeTemplateBlocks(DEFAULT_LABEL_TEMPLATE.blocks, settings?.printTemplates?.label?.blocks),
        order: mergeTemplateOrder(DEFAULT_LABEL_TEMPLATE.order, settings?.printTemplates?.label?.order),
        headerText: settings?.printTemplates?.label?.headerText ?? DEFAULT_LABEL_TEMPLATE.headerText,
        footerText: settings?.printTemplates?.label?.footerText ?? DEFAULT_LABEL_TEMPLATE.footerText,
      },
      kitchen: {
        blocks: mergeTemplateBlocks(DEFAULT_KITCHEN_TEMPLATE.blocks, settings?.printTemplates?.kitchen?.blocks),
        order: mergeTemplateOrder(DEFAULT_KITCHEN_TEMPLATE.order, settings?.printTemplates?.kitchen?.order),
        headerText: settings?.printTemplates?.kitchen?.headerText ?? DEFAULT_KITCHEN_TEMPLATE.headerText,
        footerText: settings?.printTemplates?.kitchen?.footerText ?? DEFAULT_KITCHEN_TEMPLATE.footerText,
      },
      // 自助點餐機模版（第四個槽位）。結構同 receipt，預設內容係 DEFAULT_KIOSK_TEMPLATE
      // （= 收據模版嘅深拷貝；規格 8：小票格式同現有小票完全一致，無需額外設計）。
      // 舊 localStorage 冇呢個 key → merge 函數會全套用 DEFAULT_KIOSK_TEMPLATE，安全向後兼容。
      kiosk: {
        blocks: mergeTemplateBlocks(DEFAULT_KIOSK_TEMPLATE.blocks, settings?.printTemplates?.kiosk?.blocks),
        order: mergeTemplateOrder(DEFAULT_KIOSK_TEMPLATE.order, settings?.printTemplates?.kiosk?.order),
        footerText: settings?.printTemplates?.kiosk?.footerText ?? DEFAULT_KIOSK_TEMPLATE.footerText,
      },
    },
    notePresets: Array.isArray(settings?.notePresets) ? settings.notePresets : defaultPosLocalSettings.notePresets,
    cancelNotePresets: Array.isArray(settings?.cancelNotePresets)
      ? settings?.cancelNotePresets
      : defaultPosLocalSettings.cancelNotePresets,
    reopenReasons: Array.isArray(settings?.reopenReasons)
      ? settings.reopenReasons
      : defaultPosLocalSettings.reopenReasons,
    fullVoidBehavior: settings?.fullVoidBehavior ?? defaultPosLocalSettings.fullVoidBehavior,
    dineInQuickActionOrder: Array.isArray(settings?.dineInQuickActionOrder)
      ? settings?.dineInQuickActionOrder
      : defaultPosLocalSettings.dineInQuickActionOrder,
    onlineOrderSettings: {
      autoAccept: Boolean(
        settings?.onlineOrderSettings?.autoAccept ?? defaultPosLocalSettings.onlineOrderSettings.autoAccept,
      ),
    },
    // 「自動接自助單」開關（取代舊嘅 kioskKitchenMode，見 docs/87 §4.1）。
    // 舊值 migration："dine_in_confirm"（要確認）→ false；"auto"（免確認）→ true。
    // 舊 key 唔存在 → 用 defaultPosLocalSettings（true = 免確認，規格 5 嘅預設）。
    autoAcceptSelfOrder: (() => {
      const legacy = (settings as { kioskKitchenMode?: unknown } | undefined)?.kioskKitchenMode;
      if (legacy === "dine_in_confirm") return false;
      if (legacy === "auto") return true;
      return typeof settings?.autoAcceptSelfOrder === "boolean"
        ? settings.autoAcceptSelfOrder
        : defaultPosLocalSettings.autoAcceptSelfOrder;
    })(),
  };
}

function defaultPermissionsForRole(role: UserRole): UserPermissions {
  if (role === "admin") {
    return { refundOrder: true, voidItem: true, manageAccounts: true };
  }
  if (role === "manager") {
    return { refundOrder: true, voidItem: true, manageAccounts: false };
  }
  return { refundOrder: false, voidItem: false, manageAccounts: false };
}

function normalizeAccountStores(stores: AccountStore[] | null | undefined): AccountStore[] {
  const base = Array.isArray(stores) && stores.length > 0 ? stores : defaultAccountStores;
  return base.map((store, index) => ({
    id: store.id ?? `store-${index + 1}`,
    name: store.name ?? `門店 ${index + 1}`,
    active: store.active ?? true,
    code: store.code ?? `STORE-${index + 1}`,
    city: store.city ?? "澳門",
    sourceStoreId: store.sourceStoreId ?? store.id ?? `source-store-${index + 1}`,
    sourceActive: store.sourceActive ?? store.active ?? true,
    manualDeactivated: store.manualDeactivated ?? false,
    effectiveActive: store.effectiveActive ?? (store.active ?? true),
    syncStatus: store.syncStatus ?? "ok",
    lastSyncedAt: store.lastSyncedAt ?? store.updatedAt ?? store.createdAt ?? new Date().toISOString(),
    lastHeartbeatAt: store.lastHeartbeatAt ?? store.updatedAt ?? store.createdAt ?? new Date().toISOString(),
    createdAt: store.createdAt ?? new Date().toISOString(),
    updatedAt: store.updatedAt ?? store.createdAt ?? new Date().toISOString(),
    note: store.note ?? "",
  }));
}

function normalizePermissionGroups(groups: AccountPermissionGroup[] | null | undefined): AccountPermissionGroup[] {
  const base = Array.isArray(groups) && groups.length > 0 ? groups : defaultPermissionGroups;
  return base.map((group, index) => {
    const role = group.role ?? (group.code?.includes("admin") ? "admin" : group.code?.includes("manager") ? "manager" : "cashier");
    return {
      id: group.id ?? `perm-${index + 1}`,
      code: group.code ?? `group-${index + 1}`,
      name: group.name ?? `權限組 ${index + 1}`,
      role,
      permissions: {
        ...defaultPermissionsForRole(role),
        ...(group.permissions ?? {}),
      },
      createdAt: group.createdAt ?? new Date().toISOString(),
      updatedAt: group.updatedAt ?? group.createdAt ?? new Date().toISOString(),
      note: group.note ?? "",
    };
  });
}

function normalizeAccountUsers(accounts: AccountUser[] | null | undefined): AccountUser[] {
  const base = Array.isArray(accounts) && accounts.length > 0 ? accounts : defaultAccountUsers;
  const permissionGroups = normalizePermissionGroups(readJson<AccountPermissionGroup[]>(KEYS.permissionGroups, defaultPermissionGroups));
  return base.map((account, index) => {
    // 2026-08-31 資安修復（docs/89 §2）：移除硬編碼帳號→角色後門。
    const role = account.role ?? "cashier";
    const permissionGroup = permissionGroups.find((group) => group.id === account.permissionGroupId);
    return {
      id: account.id ?? `acct-${index + 1}`,
      account: String(account.account ?? "").replace(/\D/g, "").slice(0, 8),
      pin: String(account.pin ?? "").replace(/\D/g, "").slice(0, 4),
      name: account.name ?? (role === "admin" ? "系統管理員" : role === "manager" ? "店長" : "收銀員"),
      role,
      active: account.active ?? true,
      sourceAccountId: account.sourceAccountId ?? account.id ?? `source-account-${index + 1}`,
      sourceActive: account.sourceActive ?? account.active ?? true,
      manualDeactivated: account.manualDeactivated ?? false,
      effectiveActive: account.effectiveActive ?? (account.active ?? true),
      lastSyncedAt: account.lastSyncedAt ?? account.updatedAt ?? account.createdAt ?? new Date().toISOString(),
      storeIds: Array.isArray(account.storeIds) ? account.storeIds : ["macau-store-a"],
      permissionGroupId: account.permissionGroupId ?? permissionGroup?.id,
      permissions: {
        ...defaultPermissionsForRole(role),
        ...(permissionGroup?.permissions ?? {}),
        ...(account.permissions ?? {}),
      },
      createdAt: account.createdAt ?? new Date().toISOString(),
      updatedAt: account.updatedAt ?? account.createdAt ?? new Date().toISOString(),
      lastLoginAt: account.lastLoginAt,
      note: account.note ?? "",
    };
  });
}

export function loadBootstrapCache() {
  return readStoreJson(STORE_SUFFIX.bootstrap, null as PosBootstrap | null);
}

export function saveBootstrapCache(data: PosBootstrap) {
  writeStoreJson(STORE_SUFFIX.bootstrap, data);
}

export function loadDeviceConfig() {
  return normalizeDeviceConfig(readStoreJson(STORE_SUFFIX.deviceConfig, null as DeviceConfig | null));
}

export function saveDeviceConfig(data: DeviceConfig) {
  writeStoreJson(STORE_SUFFIX.deviceConfig, data);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pos-device-config-changed", { detail: { deviceConfig: data } }));
  }
}

export function loadQueue() {
  return readStoreJson(STORE_SUFFIX.queue, [] as QueueEvent[]);
}

export function saveQueue(events: QueueEvent[]) {
  writeStoreJson(STORE_SUFFIX.queue, events);
}

export function loadOrders() {
  return readStoreJson(STORE_SUFFIX.orders, [] as PosOrder[]);
}

export function saveOrders(orders: PosOrder[]) {
  writeStoreJson(STORE_SUFFIX.orders, orders);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pos-orders-changed"));
  }
}

export function loadPrintJobs() {
  return readStoreJson(STORE_SUFFIX.printJobs, [] as PrintJob[]);
}

export function savePrintJobs(printJobs: PrintJob[]) {
  writeStoreJson(STORE_SUFFIX.printJobs, printJobs);
}

/**
 * 本機已主動清除嘅打印 job id（tombstone）。backfill 合併時跳過呢啲 id，
 * 唔會將伺服器仲未刪嘅 `pos_print_jobs` 行復活（見 docs/52）。
 */
export function loadClearedPrintJobIds(): string[] {
  return readStoreJson(STORE_SUFFIX.clearedPrintJobIds, [] as string[]);
}

export function saveClearedPrintJobIds(ids: string[]) {
  writeStoreJson(STORE_SUFFIX.clearedPrintJobIds, ids);
}

export function addClearedPrintJobIds(ids: string[]) {
  if (ids.length === 0) return;
  const next = Array.from(new Set([...loadClearedPrintJobIds(), ...ids]));
  saveClearedPrintJobIds(next);
}

/**
 * 本機已主動真刪除嘅訂單 id（tombstone）。backfill / realtime upsert 合併時跳過呢啲 id，
 * 唔會將伺服器仲未刪嘅 `pos_orders` 行復活（見 docs/52）。
 */
export function loadDeletedOrderIds(): string[] {
  return readStoreJson(STORE_SUFFIX.deletedOrderIds, [] as string[]);
}

export function saveDeletedOrderIds(ids: string[]) {
  writeStoreJson(STORE_SUFFIX.deletedOrderIds, ids);
}

export function addDeletedOrderIds(ids: string[]) {
  if (ids.length === 0) return;
  const next = Array.from(new Set([...loadDeletedOrderIds(), ...ids]));
  saveDeletedOrderIds(next);
}

export function loadPosLocalSettings() {
  return normalizePosLocalSettings(readStoreJson(STORE_SUFFIX.localSettings, defaultPosLocalSettings, resolveSettingsStoreScope()));
}

export function savePosLocalSettings(settings: PosLocalSettings): boolean {
  const ok = writeStoreJson(STORE_SUFFIX.localSettings, settings, resolveSettingsStoreScope());
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pos-local-settings-changed", { detail: { localSettings: settings } }));
  }
  return ok;
}

/** 清除 Phase 3 前遗留的 mock 會員 localStorage（PII 不應持久化）。 */
export function clearLegacyMembersCache() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem("macau-pos/members");
  } catch {
    // ignore storage failures on restricted browsers
  }
}

export function loadOfflineMode() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(KEYS.offlineMode) === "1";
  } catch {
    return false;
  }
}

export function saveOfflineMode(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEYS.offlineMode, enabled ? "1" : "0");
  } catch {
    // ignore
  }
}

export type AuthSession = {
  account: string;
  name: string;
  role: UserRole;
  storeIds?: string[];
  merchantId?: string;
  /** topUp SSO 8 位店舖編號（通常為店主電話，可能與 account 不同） */
  topUpShopId?: string;
  permissionGroupId?: string;
  permissions: UserPermissions;
  loggedInAt: string;
  ledgerAccessToken?: string;
  ledgerRefreshToken?: string;
  /**
   * 管理員操作短效 token（HMAC-signed，12h TTL）。
   * 2026-08-31 資安加固：/api/admin/accounts 四個 method 全部改驗 token，
   * 唔再零授權。由 /api/admin/session 簽發，login 成功後存入 localStorage。
   * 見 docs/89 §2。
   */
  adminSessionToken?: string;
};

function normalizeAuthSession(session: Partial<AuthSession> | null | undefined): AuthSession | null {
  if (!session?.account) return null;
  // 2026-08-31 資安修復（docs/89 §2）：移除硬編碼帳號→角色後門。
  // 舊 code 用 60000000/63936541 做 magic number，任何人改 localStorage 嘅 account 值
  // 就可以升級做 admin/manager。角色必須由 server 驗證後寫入，唔可以再喺 client 推定。
  const role = session.role ?? "cashier";
  return {
    account: session.account,
    name: session.name ?? (role === "admin" ? "系統管理員" : role === "manager" ? "店長" : "收銀員"),
    role,
    storeIds: Array.isArray(session.storeIds)
      ? session.storeIds
      : session.merchantId
        ? [session.merchantId]
        : ["macau-store-a"],
    merchantId: session.merchantId,
    topUpShopId: session.topUpShopId,
    permissionGroupId: session.permissionGroupId,
    permissions: {
      ...defaultPermissionsForRole(role),
      ...(session.permissions ?? {}),
    },
    loggedInAt: session.loggedInAt ?? new Date().toISOString(),
    ledgerAccessToken: session.ledgerAccessToken,
    ledgerRefreshToken: session.ledgerRefreshToken,
    adminSessionToken: session.adminSessionToken,
  };
}

export function loadAccountUsers() {
  return normalizeAccountUsers(readJson<AccountUser[]>(KEYS.accountUsers, defaultAccountUsers));
}

export function saveAccountUsers(users: AccountUser[]) {
  writeJson(KEYS.accountUsers, normalizeAccountUsers(users));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pos-account-users-changed"));
  }
}

export function loadAccountStores() {
  return normalizeAccountStores(readJson<AccountStore[]>(KEYS.accountStores, defaultAccountStores));
}

export function saveAccountStores(stores: AccountStore[]) {
  writeJson(KEYS.accountStores, normalizeAccountStores(stores));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pos-account-stores-changed"));
  }
}

export function loadPermissionGroups() {
  return normalizePermissionGroups(readJson<AccountPermissionGroup[]>(KEYS.permissionGroups, defaultPermissionGroups));
}

export function savePermissionGroups(groups: AccountPermissionGroup[]) {
  writeJson(KEYS.permissionGroups, normalizePermissionGroups(groups));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pos-permission-groups-changed"));
  }
}

export function authenticateAccount(account: string, pin: string) {
  const users = loadAccountUsers();
  const matched = users.find((user) => user.account === account && user.pin === pin);
  if (!matched) {
    return { ok: false as const, error: "帳號或密碼不正確。" };
  }
  if (!matched.active) {
    return { ok: false as const, error: "此帳戶已停用，請聯絡管理員。" };
  }
  const now = new Date().toISOString();
  saveAccountUsers(
    users.map((user) => (user.id === matched.id ? { ...user, lastLoginAt: now, updatedAt: now } : user)),
  );
  return {
    ok: true as const,
    session: normalizeAuthSession({
      account: matched.account,
      name: matched.name,
      role: matched.role,
      storeIds: matched.storeIds,
      permissionGroupId: matched.permissionGroupId,
      permissions: matched.permissions,
      loggedInAt: now,
    })!,
  };
}

export function loadAuthSession(): AuthSession | null {
  return normalizeAuthSession(readJson<Partial<AuthSession> | null>(KEYS.authSession, null));
}

export function saveAuthSession(session: AuthSession) {
  writeJson(KEYS.authSession, session);
  if (session.merchantId) {
    prepareStoreStorage(session.merchantId);
  }
}

export function clearAuthSession() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEYS.authSession);
  } catch {
    // ignore
  }
}

export type SoldOutState = Record<
  string,
  {
    initialQty: number;
    remainingQty: number;
    updatedAt: string;
  }
>;

export function loadSoldOutState(): SoldOutState {
  return readStoreJson(STORE_SUFFIX.soldOut, {} as SoldOutState);
}

export function saveSoldOutState(state: SoldOutState) {
  writeStoreJson(STORE_SUFFIX.soldOut, state);
}

export type ShiftState = {
  openedAt?: string;
  closedAt?: string;
  openingNote?: string;
  closingNote?: string;
  actualCash?: number;
  cashDifference?: number;
};

export type ShiftHistoryRecord = {
  id: string;
  employeeAccount?: string;
  employeeName?: string;
  openedAt?: string;
  closedAt: string;
  openingNote?: string;
  closingNote?: string;
  actualCash?: number;
  cashDifference?: number;
  settledCount: number;
  revenue: number;
  prepaid: number;
  refundCount: number;
  refundAmount: number;
  expectedCash: number;
  paymentBreakdown: Record<string, number>;
  pendingEvents: number;
  pendingPrints: number;
};

export function loadShiftState(): ShiftState {
  return readStoreJson(STORE_SUFFIX.shift, {} as ShiftState);
}

export function saveShiftState(state: ShiftState) {
  writeStoreJson(STORE_SUFFIX.shift, state);
}

export function loadShiftHistory() {
  return readStoreJson(STORE_SUFFIX.shiftHistory, [] as ShiftHistoryRecord[]);
}

export function saveShiftHistory(history: ShiftHistoryRecord[]) {
  writeStoreJson(STORE_SUFFIX.shiftHistory, history);
}

export type OperatingMode = "dinein" | "quick";

export function loadOperatingMode(): OperatingMode {
  const value = readStoreJson(STORE_SUFFIX.operatingMode, null as string | null);
  return value === "quick" ? "quick" : "dinein";
}

export function saveOperatingMode(mode: OperatingMode) {
  writeStoreJson(STORE_SUFFIX.operatingMode, mode);
}

export function loadQuickAutoAccept() {
  const value = readStoreJson(STORE_SUFFIX.quickAutoAccept, null as boolean | null);
  return value === true;
}

export function saveQuickAutoAccept(enabled: boolean) {
  writeStoreJson(STORE_SUFFIX.quickAutoAccept, enabled);
}

export function loadQuickCompletedMinutes() {
  const value = readStoreJson(STORE_SUFFIX.quickCompletedMinutes, null as number | null);
  if (!value) return 10;
  if (value < 1) return 1;
  if (value > 180) return 180;
  return Math.floor(value);
}

export function saveQuickCompletedMinutes(minutes: number) {
  writeStoreJson(STORE_SUFFIX.quickCompletedMinutes, Math.floor(minutes));
}

// ──────────────────────────────────────────────────────────────────────────
// 本地每日序號（docs/56 · B1）
//
// offline / /api/pos/sequence 失敗嗰陣做 fallback 單號，取代原本 `訂單${時戳末兩位}`
// 嘅隨機數（會出「訂單84」呢類非順序、易撞嘅號）。按 日期+kind 各自遞增，
// 保證 fallback 都係單調、不重複、易讀，連網後同 server 同日序號對齊語意一致。
// ──────────────────────────────────────────────────────────────────────────

type LocalDailySeqState = Record<string, number>; // key = `${bizDate}:${kind}` → 已用到嘅最大序號

function pad2Seq(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * 取下一個本地每日序號並寫回 localStorage。
 * @param kind  同 /api/pos/sequence 嘅 kind（pos / pickup / delivery / counter）
 * @param prefix 單號抬頭（訂單 / 自取 / 外賣 / 堂食），由 caller 按 quick mode 決定
 * @returns 完整單號，例如 `訂單08` / `自取12`
 */
export function nextLocalDailyOrderNo(kind: string, prefix: string): string {
  const bizDate = new Date().toISOString().slice(0, 10);
  const stateKey = `${bizDate}:${kind}`;
  const state = readStoreJson<LocalDailySeqState>(STORE_SUFFIX.localDailySeq, {});
  const next = (state[stateKey] ?? 0) + 1;
  state[stateKey] = next;
  writeStoreJson(STORE_SUFFIX.localDailySeq, state);
  return `${prefix}${pad2Seq(next)}`;
}
