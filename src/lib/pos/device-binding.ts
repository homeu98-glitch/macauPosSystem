"use client";

import { loadAuthSession, saveAuthSession, type AuthSession } from "@/lib/storage";

/**
 * 裝置授權（免店主帳密開機）—— 客戶端半邊（2026-10-23，docs/160 §10）。
 *
 * ## 解決咩問題
 *
 * L2（工號 + PIN）依附 L1（店舖登入），而 L1 唯一通道係**店主** Ledger 帳密。
 * ⇒ 新機／清 cache／登出之後，店員開機一定要店主到場。
 *
 * 店主喺呢部機登入一次並「授權呢部機」→ 之後開機只需要：
 *   localStorage 有 `{storeId, deviceId, secret}` → `POST /api/pos/device/session`
 *   → server 用加密保存嘅 Ledger refresh token 換一個完整 session → 直接跳 `/operator`。
 *
 * ## 存喺邊
 *
 * | key | 內容 | 為何唔 store-scoped |
 * |---|---|---|
 * | `macau-pos/device-id` | 隨機 uuid（永久） | 開機時未知 storeId |
 * | `macau-pos/device-binding` | `{storeId, deviceId, secret, ...}` | 同上 |
 * | `macau-pos/device-signed-out` | 店主主動登出嘅時間戳 | 同上 |
 *
 * ⚠️ `device-signed-out` 存在時**唔會**自動開機 —— 否則店主按「登出」之後
 *    頁面一 reload 又即刻登入，睇落似 bug。店主下次登入（或店員喺登入頁撳
 *    「店員簽到」）就會清走呢個標記。
 */

const DEVICE_ID_KEY = "macau-pos/device-id";
const BINDING_KEY = "macau-pos/device-binding";
const SIGNED_OUT_KEY = "macau-pos/device-signed-out";

export type DeviceBinding = {
  storeId: string;
  deviceId: string;
  secret: string;
  label?: string;
  boundAt?: string;
};

function readRaw(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // ignore（私隱模式／quota）
  }
}

/** 呢部機嘅穩定識別碼（首次呼叫時生成）。 */
export function loadOrCreateDeviceId(): string {
  const existing = readRaw(DEVICE_ID_KEY)?.trim();
  if (existing && existing.length >= 8) return existing;

  const generated =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  writeRaw(DEVICE_ID_KEY, generated);
  return generated;
}

export function loadDeviceBinding(): DeviceBinding | null {
  const raw = readRaw(BINDING_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DeviceBinding> | null;
    if (!parsed?.storeId || !parsed?.deviceId || !parsed?.secret) return null;
    return {
      storeId: String(parsed.storeId),
      deviceId: String(parsed.deviceId),
      secret: String(parsed.secret),
      label: typeof parsed.label === "string" ? parsed.label : undefined,
      boundAt: typeof parsed.boundAt === "string" ? parsed.boundAt : undefined,
    };
  } catch {
    return null;
  }
}

export function saveDeviceBinding(binding: DeviceBinding): void {
  writeRaw(
    BINDING_KEY,
    JSON.stringify({
      storeId: binding.storeId,
      deviceId: binding.deviceId,
      secret: binding.secret,
      label: binding.label ?? "",
      boundAt: binding.boundAt ?? new Date().toISOString(),
    }),
  );
}

export function clearDeviceBinding(): void {
  writeRaw(BINDING_KEY, null);
}

/** 店主主動登出 → 暫時唔自動開機（避免「登出即刻又登入」）。 */
export function markDeviceSignedOut(): void {
  writeRaw(SIGNED_OUT_KEY, new Date().toISOString());
}

export function clearDeviceSignedOut(): void {
  writeRaw(SIGNED_OUT_KEY, null);
}

export function isDeviceSignedOut(): boolean {
  return Boolean(readRaw(SIGNED_OUT_KEY));
}

/** 裝置名（預設值）—— 只作顯示，唔參與鑑權。 */
export function defaultDeviceLabel(): string {
  if (typeof navigator === "undefined") return "POS 終端";
  const ua = navigator.userAgent;
  const platform = /iPad/i.test(ua)
    ? "iPad"
    : /iPhone/i.test(ua)
      ? "iPhone"
      : /Android/i.test(ua)
        ? "Android"
        : /Macintosh/i.test(ua)
          ? "Mac"
          : /Windows/i.test(ua)
            ? "Windows"
            : "POS 終端";
  const browser = /Edg\//i.test(ua)
    ? "Edge"
    : /Chrome\//i.test(ua)
      ? "Chrome"
      : /Safari\//i.test(ua)
        ? "Safari"
        : "";
  return `${platform}${browser ? ` · ${browser}` : ""}`.slice(0, 60);
}

export type BindResult =
  | { ok: true }
  | { ok: false; error: string; tableMissing?: boolean };

/**
 * 授權呢部機。
 *
 * ⚠️ 需要**店主 session**（Ledger access token 或 admin token），
 *    而且一定要有 `ledgerRefreshToken` —— 開機之後靠佢續 Ledger session。
 */
export async function bindThisDevice(input: {
  storeId: string;
  label?: string;
  ledgerAccessToken?: string | null;
  ledgerRefreshToken?: string | null;
  adminToken?: string | null;
}): Promise<BindResult> {
  const storeId = String(input.storeId ?? "").trim();
  if (!storeId) return { ok: false, error: "缺少店舖資料。" };

  const session = loadAuthSession();
  // 🔴 一定要用 **storage 最新** 嗰張 refresh token：props 係 mount 時影嘅快照，
  //    期間可能已經輪換過（`ensureLedgerSession()`）。存錯舊票 ⇒ 下次開機即失效。
  const refreshToken = session?.ledgerRefreshToken ?? input.ledgerRefreshToken ?? "";
  const accessToken = session?.ledgerAccessToken ?? input.ledgerAccessToken ?? "";
  if (!refreshToken) {
    return { ok: false, error: "搵唔到 Ledger 憑證，請重新登入店主帳號再試。" };
  }

  const deviceId = loadOrCreateDeviceId();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (input.adminToken) headers.Authorization = `Bearer ${input.adminToken}`;
  if (accessToken) headers["x-pos-ledger-token"] = accessToken;
  if (refreshToken) headers["x-pos-ledger-refresh"] = refreshToken;

  try {
    const response = await fetch("/api/pos/device/bind", {
      method: "POST",
      headers,
      body: JSON.stringify({
        storeId,
        deviceId,
        label: (input.label ?? defaultDeviceLabel()).slice(0, 60),
        refreshToken,
      }),
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      error?: string;
      secret?: string;
      tableReady?: boolean;
    };
    if (payload.tableReady === false) {
      return {
        ok: false,
        tableMissing: true,
        error: "裝置授權表未建立：請先執行 migration 0073_pos_bound_devices.sql。",
      };
    }
    if (!response.ok || !payload.ok || !payload.secret) {
      return { ok: false, error: payload.error ?? "授權裝置失敗。" };
    }

    saveDeviceBinding({
      storeId,
      deviceId,
      secret: payload.secret,
      label: input.label ?? defaultDeviceLabel(),
      boundAt: new Date().toISOString(),
    });
    clearDeviceSignedOut();
    return { ok: true };
  } catch {
    return { ok: false, error: "網絡錯誤，請稍後再試。" };
  }
}

export type RestoreResult =
  | { ok: true }
  | { ok: false; error: string; invalid?: boolean };

/**
 * 用本機裝置憑證換一個完整 session。
 * 成功會直接寫入 `AuthSession`（含真 Ledger token），呼叫端只需要跳頁。
 */
export async function restoreDeviceSession(): Promise<RestoreResult> {
  const binding = loadDeviceBinding();
  if (!binding) return { ok: false, error: "呢部機未授權。" };

  try {
    const response = await fetch("/api/pos/device/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storeId: binding.storeId,
        deviceId: binding.deviceId,
        secret: binding.secret,
      }),
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      error?: string;
      code?: string;
      session?: AuthSession;
      tableReady?: boolean;
    };

    if (!response.ok || !payload.ok || !payload.session) {
      // 授權已被撤銷／secret 已失效 → 清走本機記錄，唔好無限重試
      if (response.status === 401) clearDeviceBinding();
      return {
        ok: false,
        invalid: response.status === 401,
        error: payload.error ?? "自動開機失敗。",
      };
    }

    saveAuthSession(payload.session);
    clearDeviceSignedOut();
    return { ok: true };
  } catch {
    return { ok: false, error: "網絡錯誤，請稍後再試。" };
  }
}

/**
 * 客戶端輪換咗 refresh token → 同步返 server 副本。
 *
 * 🔴 冇呢一步，server 嗰張票會喺客戶端第一次 refresh 之後變成廢票，
 *    第二日開機就會「授權已失效」，而且查唔到原因。
 *
 * 失敗一律靜默（純保鮮，唔可以阻任何業務）；下次 refresh 會再試。
 */
let tokenSyncInFlight: Promise<void> | null = null;
let lastSyncedToken = "";

export function syncDeviceBindingRefreshToken(refreshToken: string): void {
  if (typeof window === "undefined") return;
  const token = String(refreshToken ?? "").trim();
  if (!token || token === lastSyncedToken) return;

  const binding = loadDeviceBinding();
  if (!binding) return;

  if (tokenSyncInFlight) return;
  lastSyncedToken = token;

  tokenSyncInFlight = (async () => {
    try {
      await fetch("/api/pos/device/session", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeId: binding.storeId,
          deviceId: binding.deviceId,
          secret: binding.secret,
          refreshToken: token,
        }),
      });
    } catch {
      // 靜默：下次 refresh 會再同步
      lastSyncedToken = "";
    } finally {
      tokenSyncInFlight = null;
    }
  })();
}
