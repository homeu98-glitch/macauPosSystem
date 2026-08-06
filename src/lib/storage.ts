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
  operatingMode: "macau-pos/operating-mode",
  quickAutoAccept: "macau-pos/quick-auto-accept",
  quickCompletedMinutes: "macau-pos/quick-completed-minutes",
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

export function normalizeDeviceConfig(config: DeviceConfig | null | undefined): DeviceConfig | null {
  if (!config) return null;
  return {
    ...config,
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
          connectionType: printer.connectionType ?? "lan",
          name: printer.name ?? `打印機 ${index + 1}`,
          model: printer.model ?? "",
          paperSize: printer.paperSize ?? "",
          ipAddress: printer.ipAddress ?? "",
          usbLabel: printer.usbLabel ?? "",
          enabled: Boolean(printer.enabled),
        }))
      : [],
  };
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
    notePresets: Array.isArray(settings?.notePresets) ? settings.notePresets : defaultPosLocalSettings.notePresets,
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
  return normalizeDeviceConfig(readJson<DeviceConfig | null>(KEYS.deviceConfig, null));
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
  return normalizePosLocalSettings(readJson<PosLocalSettings>(KEYS.localSettings, defaultPosLocalSettings));
}

export function savePosLocalSettings(settings: PosLocalSettings) {
  writeJson(KEYS.localSettings, settings);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pos-local-settings-changed", { detail: { localSettings: settings } }));
  }
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

export type OperatingMode = "dinein" | "quick";

export function loadOperatingMode(): OperatingMode {
  const value = readJson<string | null>(KEYS.operatingMode, null);
  return value === "quick" ? "quick" : "dinein";
}

export function saveOperatingMode(mode: OperatingMode) {
  writeJson(KEYS.operatingMode, mode);
}

export function loadQuickAutoAccept() {
  const value = readJson<boolean | null>(KEYS.quickAutoAccept, null);
  return value === true;
}

export function saveQuickAutoAccept(enabled: boolean) {
  writeJson(KEYS.quickAutoAccept, enabled);
}

export function loadQuickCompletedMinutes() {
  const value = readJson<number | null>(KEYS.quickCompletedMinutes, null);
  if (!value) return 10;
  if (value < 1) return 1;
  if (value > 180) return 180;
  return Math.floor(value);
}

export function saveQuickCompletedMinutes(minutes: number) {
  writeJson(KEYS.quickCompletedMinutes, Math.floor(minutes));
}
