import {
  AccountPermissionGroup,
  AccountStore,
  AccountUser,
  DeviceConfig,
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

function writeJson<T>(key: string, value: T) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore storage write failures on restricted browsers / kiosk devices
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

function writeStoreJson<T>(suffix: StoreSuffix, value: T, merchantId?: string | null) {
  writeJson(storeScopedStorageKey(suffix, merchantId), value);
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

export function normalizeDeviceConfig(config: DeviceConfig | null | undefined): DeviceConfig | null {
  if (!config) return null;
  return {
    ...config,
    printBridgeUrl: config.printBridgeUrl?.trim() ?? "",
    printers: Array.isArray(config.printers)
      ? config.printers.map((printer, index) => ({
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
          connectionType: "lan",
          name: printer.name ?? `打印機 ${index + 1}`,
          model: printer.model ?? "",
          paperSize: printer.paperSize ?? "",
          ipAddress: printer.ipAddress ?? "",
          lanPort: Number(printer.lanPort ?? 9100) || 9100,
          enabled: Boolean(printer.enabled),
        }))
      : [],
  };
}

export function normalizePosLocalSettings(settings: Partial<PosLocalSettings> | null | undefined): PosLocalSettings {
  const receiptDefaultOrder = defaultPosLocalSettings.printTemplates.receipt.sectionOrder;
  const labelDefaultOrder = defaultPosLocalSettings.printTemplates.label.sectionOrder;
  const receiptDefaultLayouts = defaultPosLocalSettings.printTemplates.receipt.sectionLayouts;
  const labelDefaultLayouts = defaultPosLocalSettings.printTemplates.label.sectionLayouts;
  const receiptDefaultStyles = defaultPosLocalSettings.printTemplates.receipt.sectionStyles;
  const labelDefaultStyles = defaultPosLocalSettings.printTemplates.label.sectionStyles;
  const receiptStoredOrder = Array.isArray(settings?.printTemplates?.receipt?.sectionOrder)
    ? settings?.printTemplates?.receipt?.sectionOrder
    : [];
  const labelStoredOrder = Array.isArray(settings?.printTemplates?.label?.sectionOrder)
    ? settings?.printTemplates?.label?.sectionOrder
    : [];
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
        ...defaultPosLocalSettings.printTemplates.receipt,
        ...(settings?.printTemplates?.receipt ?? {}),
        showRuler:
          settings?.printTemplates?.receipt?.showRuler ?? defaultPosLocalSettings.printTemplates.receipt.showRuler,
        snapToGrid:
          settings?.printTemplates?.receipt?.snapToGrid ?? defaultPosLocalSettings.printTemplates.receipt.snapToGrid,
        canvas: {
          ...defaultPosLocalSettings.printTemplates.receipt.canvas,
          ...(settings?.printTemplates?.receipt?.canvas ?? {}),
        },
        sectionStyles: {
          ...receiptDefaultStyles,
          ...(settings?.printTemplates?.receipt?.sectionStyles ?? {}),
        },
        sectionLayouts: {
          ...receiptDefaultLayouts,
          ...(settings?.printTemplates?.receipt?.sectionLayouts ?? {}),
        },
        sectionOrder: Array.from(new Set([...receiptStoredOrder, ...receiptDefaultOrder])).filter((item) =>
          receiptDefaultOrder.includes(item as (typeof receiptDefaultOrder)[number]),
        ) as typeof receiptDefaultOrder,
      },
      label: {
        ...defaultPosLocalSettings.printTemplates.label,
        ...(settings?.printTemplates?.label ?? {}),
        showRuler: settings?.printTemplates?.label?.showRuler ?? defaultPosLocalSettings.printTemplates.label.showRuler,
        snapToGrid:
          settings?.printTemplates?.label?.snapToGrid ?? defaultPosLocalSettings.printTemplates.label.snapToGrid,
        canvas: {
          ...defaultPosLocalSettings.printTemplates.label.canvas,
          ...(settings?.printTemplates?.label?.canvas ?? {}),
        },
        sectionStyles: {
          ...labelDefaultStyles,
          ...(settings?.printTemplates?.label?.sectionStyles ?? {}),
        },
        sectionLayouts: {
          ...labelDefaultLayouts,
          ...(settings?.printTemplates?.label?.sectionLayouts ?? {}),
        },
        sectionOrder: Array.from(new Set([...labelStoredOrder, ...labelDefaultOrder])).filter((item) =>
          labelDefaultOrder.includes(item as (typeof labelDefaultOrder)[number]),
        ) as typeof labelDefaultOrder,
      },
    },
    notePresets: Array.isArray(settings?.notePresets) ? settings.notePresets : defaultPosLocalSettings.notePresets,
    cancelNotePresets: Array.isArray(settings?.cancelNotePresets)
      ? settings?.cancelNotePresets
      : defaultPosLocalSettings.cancelNotePresets,
    fullVoidBehavior: settings?.fullVoidBehavior ?? defaultPosLocalSettings.fullVoidBehavior,
    dineInQuickActionOrder: Array.isArray(settings?.dineInQuickActionOrder)
      ? settings?.dineInQuickActionOrder
      : defaultPosLocalSettings.dineInQuickActionOrder,
    onlineOrderSettings: {
      autoAccept: Boolean(
        settings?.onlineOrderSettings?.autoAccept ?? defaultPosLocalSettings.onlineOrderSettings.autoAccept,
      ),
    },
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
    const role = account.role ?? (account.account === "60000000" ? "admin" : account.account === "63936541" ? "manager" : "cashier");
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

export function loadPosLocalSettings() {
  return normalizePosLocalSettings(readStoreJson(STORE_SUFFIX.localSettings, defaultPosLocalSettings));
}

export function savePosLocalSettings(settings: PosLocalSettings) {
  writeStoreJson(STORE_SUFFIX.localSettings, settings);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pos-local-settings-changed", { detail: { localSettings: settings } }));
  }
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
};

function normalizeAuthSession(session: Partial<AuthSession> | null | undefined): AuthSession | null {
  if (!session?.account) return null;
  const role =
    session.role ?? (session.account === "60000000" ? "admin" : session.account === "63936541" ? "manager" : "cashier");
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
