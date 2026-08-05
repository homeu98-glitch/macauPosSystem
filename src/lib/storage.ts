import { DeviceConfig, MemberProfile, PosBootstrap, PosLocalSettings, PosOrder, PrintJob, QueueEvent } from "@/lib/types";
import { defaultMembers, defaultPosLocalSettings } from "@/lib/mock-data";

const KEYS = {
  bootstrap: "macau-pos/bootstrap",
  deviceConfig: "macau-pos/device-config",
  queue: "macau-pos/sync-queue",
  orders: "macau-pos/orders",
  printJobs: "macau-pos/print-jobs",
  localSettings: "macau-pos/local-settings",
  members: "macau-pos/members",
  offlineMode: "macau-pos/offline-mode",
  authSession: "macau-pos/auth-session",
  soldOut: "macau-pos/sold-out",
  shift: "macau-pos/shift",
};

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") {
    return fallback;
  }

  const raw = window.localStorage.getItem(key);
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

  window.localStorage.setItem(key, JSON.stringify(value));
}

function normalizeLocalSettings(settings: Partial<PosLocalSettings> | null | undefined): PosLocalSettings {
  return {
    floors: Array.isArray(settings?.floors) ? settings.floors : defaultPosLocalSettings.floors,
    paymentMethods: Array.isArray(settings?.paymentMethods)
      ? settings.paymentMethods
      : defaultPosLocalSettings.paymentMethods,
    menuPrinterOverrides:
      settings?.menuPrinterOverrides && typeof settings.menuPrinterOverrides === "object"
        ? settings.menuPrinterOverrides
        : defaultPosLocalSettings.menuPrinterOverrides,
    onlineOrderSettings: {
      autoAccept: Boolean(
        settings?.onlineOrderSettings?.autoAccept ?? defaultPosLocalSettings.onlineOrderSettings.autoAccept,
      ),
    },
  };
}

function normalizeMembers(members: MemberProfile[] | null | undefined): MemberProfile[] {
  if (!Array.isArray(members)) return defaultMembers;

  return members.map((member) => ({
    ...member,
    coupons: Array.isArray(member.coupons) ? member.coupons : [],
  }));
}

export function loadBootstrapCache() {
  return readJson<PosBootstrap | null>(KEYS.bootstrap, null);
}

export function saveBootstrapCache(data: PosBootstrap) {
  writeJson(KEYS.bootstrap, data);
}

export function loadDeviceConfig() {
  return readJson<DeviceConfig | null>(KEYS.deviceConfig, null);
}

export function saveDeviceConfig(data: DeviceConfig) {
  writeJson(KEYS.deviceConfig, data);
}

export function loadQueue() {
  return readJson<QueueEvent[]>(KEYS.queue, []);
}

export function saveQueue(events: QueueEvent[]) {
  writeJson(KEYS.queue, events);
}

export function loadOrders() {
  return readJson<PosOrder[]>(KEYS.orders, []);
}

export function saveOrders(orders: PosOrder[]) {
  writeJson(KEYS.orders, orders);
}

export function loadPrintJobs() {
  return readJson<PrintJob[]>(KEYS.printJobs, []);
}

export function savePrintJobs(printJobs: PrintJob[]) {
  writeJson(KEYS.printJobs, printJobs);
}

export function loadPosLocalSettings() {
  return normalizeLocalSettings(readJson<PosLocalSettings>(KEYS.localSettings, defaultPosLocalSettings));
}

export function savePosLocalSettings(settings: PosLocalSettings) {
  writeJson(KEYS.localSettings, settings);
}

export function loadMembers() {
  return normalizeMembers(readJson<MemberProfile[]>(KEYS.members, defaultMembers));
}

export function saveMembers(members: MemberProfile[]) {
  writeJson(KEYS.members, members);
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
  loggedInAt: string;
};

export function loadAuthSession(): AuthSession | null {
  return readJson<AuthSession | null>(KEYS.authSession, null);
}

export function saveAuthSession(session: AuthSession) {
  writeJson(KEYS.authSession, session);
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
  return readJson<SoldOutState>(KEYS.soldOut, {});
}

export function saveSoldOutState(state: SoldOutState) {
  writeJson(KEYS.soldOut, state);
}

export type ShiftState = {
  openedAt?: string;
  closedAt?: string;
  openingNote?: string;
  closingNote?: string;
};

export function loadShiftState(): ShiftState {
  return readJson<ShiftState>(KEYS.shift, {});
}

export function saveShiftState(state: ShiftState) {
  writeJson(KEYS.shift, state);
}
