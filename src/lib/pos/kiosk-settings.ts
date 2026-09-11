/**
 * 自助點餐設定（按店）· client / server 共用。
 *
 * 真源：DB `pos_kiosk_settings`（0015 migration，`scan_mode` 為 0031 migration），
 * 經 `/api/pos/kiosk-settings` 讀寫。
 *
 * ⚠️ 唔好改用 `pos_device_configs`：嗰張表嘅讀取係 `.order("updated_at", desc).limit(1)`
 * **冇 store filter** = 「全店最新一條（任何 terminal）」，用嚟存 per-store 設定一定錯亂
 * （同 `onlineOrderSettings.autoAccept` 嗰個 bug 同一個坑，見 docs/52）。
 *
 * 點解要落 DB 而唔係讀 localStorage：舊嘅 `kioskKitchenMode` 就係由 Kiosk 自己嘅
 * localStorage 讀，而 Kiosk 從來冇設定 UI → 永遠係預設值 → 開關係死 code。
 * 開關擺喺收銀台「訂單」頁，一定要收銀端寫、Kiosk 讀，所以必須經 DB。
 * 見 docs/87 §4.3 / §9 P0 #4。
 *
 * `scanMode`（2026-09-10 新增，見 docs/115）：掃碼點餐嘅**店級互斥**模式 ——
 * 堂食（逐枱一個碼）同快餐（全店一個碼）**唔可以同時開啟**。
 *
 * `printers`（2026-09-11 新增，見 docs/87 §6.2）：自助點餐機**專屬打印機**清單。
 * 自助機要另外一台打印機出顧客小票畀客人；存喺呢張表（per-store）而唔係本機
 * localStorage，令「改一次全店即時生效」同「換機唔使重設」成立。
 * 平板會寫入本機快取（`macau-pos/stores/{storeId}/kiosk-printers`）做離線 fallback。
 */

import type { DevicePrinterConfig } from "@/lib/types";

/**
 * 掃碼點餐模式（店級互斥，見 docs/115）。
 *
 * - `"dine_in"`（**預設**）：每張枱一個專屬 QR（`/menu?tableId=<枱>&store=<店>`），
 *   落單綁枱號；同一枱再加單 = 更新同一張單。
 * - `"quick"`：全店只有一個 QR（`/quick?store=<店>`），無枱
 *   （`tableId = "counter"`）；**每張單獨立新增**，單號沿用 kiosk 嘅 `pickup` 序號（如「自取01」）。
 */
export type ScanMode = "dine_in" | "quick";

export const DEFAULT_SCAN_MODE: ScanMode = "dine_in";

/**
 * 自助點餐機專屬打印機嘅合法 role / 連線方式白名單。
 *
 * ⚠️ 一定要白名單驗證（同 `normalizeDeviceConfig` 唔同 —— 嗰邊係讀自己寫嘅本機設定，
 * 呢邊係商家人手輸入 + 跨裝置讀寫，垃圾值會直接令 `resolveJobPrinter` 揀錯機）。
 */
const KIOSK_PRINTER_ROLES = new Set(["receipt", "label", "zone"]);
const KIOSK_PRINTER_CONNECTIONS = new Set(["lan", "usb", "bluetooth"]);

/**
 * 正常化自助點餐機打印機清單（client / server 共用，server 寫入前同 client 讀取後都行一次）。
 *
 * 規則：只接受「有 id + 有 name + role / connectionType 合法」嘅項目；
 * 其餘（`undefined` / 非 array / 缺欄位 / role 打錯）一律剔走。
 * 缺少 `enabled` → 當 `true`（同 `resolveJobPrinter` 只認 enabled 一致）。
 *
 * 點解唔似 `normalizeDeviceConfig` 咁「補預設值」：呢度係**遠端輸入**，
 * 補一個假 IP / 假 role 落去會令 kiosk 靜靜地印去一部唔存在嘅機，
 * 比直接剔走更難 debug。剔走 = kiosk 唔出小票（另有一層 fallback 去 deviceConfig）。
 */
export function normalizeKioskPrinters(value: unknown): DevicePrinterConfig[] {
  if (!Array.isArray(value)) return [];
  const out: DevicePrinterConfig[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const printer = raw as Partial<DevicePrinterConfig>;
    const id = typeof printer.id === "string" ? printer.id.trim() : "";
    const name = typeof printer.name === "string" ? printer.name.trim() : "";
    const role = typeof printer.role === "string" ? printer.role : "";
    const connectionType = typeof printer.connectionType === "string" ? printer.connectionType : "";
    if (!id || !name) continue;
    if (!KIOSK_PRINTER_ROLES.has(role)) continue;
    if (!KIOSK_PRINTER_CONNECTIONS.has(connectionType)) continue;
    out.push({
      ...printer,
      id,
      name,
      role: role as DevicePrinterConfig["role"],
      connectionType: connectionType as DevicePrinterConfig["connectionType"],
      enabled: printer.enabled !== false,
    });
  }
  return out;
}

/** 正常化讀取：DB 可能冇值（migration 未跑）或回未知值 → 一律當 `"dine_in"`（向後兼容）。 */
export function normalizeScanMode(value: unknown): ScanMode {
  return value === "quick" ? "quick" : DEFAULT_SCAN_MODE;
}

export interface KioskSettings {
  storeId: string;
  /**
   * 「自動接自助單」開關。
   * - `true`（**預設**，規格 5）：免確認，客人落單後直接出廚房單
   * - `false`：自助點餐單排入「待確認」，等收銀台撳「確認」先用代客下單流程出單
   */
  selfOrderAutoAccept: boolean;
  /** 掃碼點餐模式（店級互斥）。 */
  scanMode: ScanMode;
  /**
   * 自助點餐機**專屬**打印機清單（per-store，已過 `normalizeKioskPrinters()`）。
   * 空陣列 = 未設定 → `resolveJobPrinter` 行為同以往完全一樣（只有 deviceConfig 嘅機）。
   */
  printers: DevicePrinterConfig[];
  /**
   * 呢份設定係咪**真係由 server 攞到**（唔係 fallback / 離線預設）。
   *
   * ⚠️ 用途：`printers` 為空有兩個完全唔同嘅意思 ——
   *   ① server 真係話「冇設定」→ 應該清走本機快取；
   *   ② 離線 / 攞唔到 → **絕對唔可以**清快取（會令斷網時反而印唔到）。
   * 冇呢個旗標就分唔清，就會出現「網絡抖一下，kiosk 打印機設定全部消失」。
   */
  fromServer: boolean;
  updatedAt?: string | null;
}

/** 讀取失敗 / 離線時用呢個值：免確認（同 DB default 同 `PosLocalSettings.autoAcceptSelfOrder` default 一致）+ 堂食模式。 */
export const DEFAULT_KIOSK_SETTINGS_FALLBACK: Omit<KioskSettings, "storeId"> = {
  selfOrderAutoAccept: true,
  scanMode: DEFAULT_SCAN_MODE,
  printers: [],
  fromServer: false,
  updatedAt: null,
};

/** POST 可以只帶想改嘅欄位（server 會 read-then-merge，唔會洗走另一個）。 */
export type KioskSettingsPatch = Partial<
  Pick<KioskSettings, "selfOrderAutoAccept" | "scanMode" | "printers">
>;

interface KioskSettingsPayload {
  ok?: boolean;
  error?: string;
  fallback?: boolean;
  settings?: {
    storeId?: string;
    selfOrderAutoAccept?: boolean;
    scanMode?: string;
    printers?: unknown;
    updatedAt?: string | null;
  };
}

function readSettings(
  payload: KioskSettingsPayload | null,
  storeId: string,
  fallback: KioskSettings,
): KioskSettings {
  const s = payload?.settings;
  if (!s) return fallback;
  return {
    storeId: s.storeId ?? storeId,
    selfOrderAutoAccept:
      typeof s.selfOrderAutoAccept === "boolean"
        ? s.selfOrderAutoAccept
        : DEFAULT_KIOSK_SETTINGS_FALLBACK.selfOrderAutoAccept,
    scanMode:
      s.scanMode === undefined ? DEFAULT_SCAN_MODE : normalizeScanMode(s.scanMode),
    // ⚠️ `s.printers === undefined` = server 未有呢個欄位（0032 migration 未跑）
    // → 保留 fallback（即本機快取），唔可以當「空清單」而清走快取。
    printers:
      s.printers === undefined
        ? fallback.printers
        : normalizeKioskPrinters(s.printers),
    fromServer: true,
    updatedAt: s.updatedAt ?? null,
  };
}

/**
 * 讀取自助點餐設定（按店）。
 *
 * 設計上**只喺落單時 call 一次**，唔做 polling（全專案禁 polling，見 docs/52）。
 * 離線 / 失敗一律 fallback 去 `DEFAULT_KIOSK_SETTINGS_FALLBACK`，
 * 確保客端唔會因為拎唔到設定而落唔到單（離線優先）。
 *
 * @param opts.fallbackPrinters 本機快取嘅 kiosk 打印機清單（由 caller 讀 localStorage 傳入，
 *   因為本 module 係 client / server 共用，唔可以 import localStorage 層）。
 *   離線時照樣用得返，唔會一斷網就冇紙。
 */
export async function fetchKioskSettings(
  storeId: string,
  opts?: { fallbackPrinters?: DevicePrinterConfig[] },
): Promise<KioskSettings> {
  const fallback: KioskSettings = {
    storeId,
    ...DEFAULT_KIOSK_SETTINGS_FALLBACK,
    printers: opts?.fallbackPrinters ?? [],
  };
  if (!storeId) return fallback;

  try {
    const res = await fetch(`/api/pos/kiosk-settings?storeId=${encodeURIComponent(storeId)}`, {
      method: "GET",
      cache: "no-store",
    });
    if (!res.ok) return fallback;
    const payload = (await res.json()) as KioskSettingsPayload;
    if (!payload?.ok || !payload.settings) return fallback;
    return readSettings(payload, storeId, fallback);
  } catch {
    // 離線 / 網絡錯誤：用預設繼續落單
    return fallback;
  }
}

/**
 * 保存自助點餐設定（收銀端「訂單」頁「自動接自助單」掣 / 設定頁「掃碼點餐」模式選擇器 call）。
 *
 * 只傳想改嘅欄位；server 會 read-then-merge 之後再 upsert，
 * 所以改一個欄位**唔會**洗走另一個（舊版無腦寫死兩個值，加欄位就會出事）。
 *
 * ## ⚠️ 一定要帶 POS 終端憑證（2026-09-10 修）
 *
 * `/api/pos/kiosk-settings` POST 由 P3-5 起要鑑權（`storeId` 必須同憑證一致），
 * 但呢個 function 舊版**完全冇帶 `Authorization`** → 任何正式店鋪一撳就 401
 * 「未經授權：需要 POS 終端憑證。」（GET 係開放嘅，所以「讀得到但存唔到」呢個
 * 組合最令人誤判成權限問題）。
 *
 * 所以 `headers` 係 **caller 嘅責任**，而且要用 `posDeviceAuthHeadersFresh()`
 * 先續期再取 header（token TTL 12h，過夜必爆）：
 *
 * ```ts
 * await saveKioskSettings(storeId, { scanMode: next }, await posDeviceAuthHeadersFresh());
 * ```
 *
 * 點解唔喺呢個 module 直接 import `pos-sync-auth`：`kiosk-settings.ts` 係
 * client / server **共用**（`/api/pos/kiosk-settings/route.ts` 會 import 佢嘅
 * `normalizeScanMode`），而 `pos-sync-auth` 依賴 `window` / `localStorage`。
 * 拉埋入 server bundle 係無必要嘅風險。
 *
 * 失敗會 throw，等 UI 可以提示用家（同 `/api/pos/device-config` 嗰邊唔同 ——
 * 呢個係開關，靜默失敗會令用家以為改咗其實冇改）。
 */
export async function saveKioskSettings(
  storeId: string,
  patch: KioskSettingsPatch,
  headers: Record<string, string> = {},
): Promise<KioskSettings> {
  const res = await fetch("/api/pos/kiosk-settings", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ storeId, ...patch }),
  });
  const payload = (await res.json().catch(() => null)) as KioskSettingsPayload | null;
  if (!res.ok || !payload?.ok) {
    throw new Error(payload?.error ?? "保存自助點餐設定失敗。");
  }
  const fallback: KioskSettings = {
    storeId,
    selfOrderAutoAccept:
      patch.selfOrderAutoAccept ?? DEFAULT_KIOSK_SETTINGS_FALLBACK.selfOrderAutoAccept,
    scanMode: patch.scanMode ?? DEFAULT_SCAN_MODE,
    printers: patch.printers ?? [],
    fromServer: true,
    updatedAt: null,
  };
  return readSettings(payload, storeId, fallback);
}
