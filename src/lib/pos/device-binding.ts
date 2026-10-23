"use client";

import { saveAuthSession, type AuthSession } from "@/lib/storage";
import { markTerminalUnlocked } from "@/lib/pos/terminal-lock";

/**
 * 裝置授權（免店主帳密開機）—— 客戶端半邊（2026-10-23，docs/160 §10、docs/161）。
 *
 * ## 解決咩問題
 *
 * L2（工號 + PIN）依附 L1（店舖登入），而 L1 唯一通道係**店主** Ledger 帳密。
 * ⇒ 新機／清 cache／登出之後，店員開機一定要店主到場。
 *
 * 店主喺呢部機登入一次 → server 自動寫入裝置憑證 → 之後開機只需要：
 *   localStorage 有 `{storeId, deviceId, secret}` → `POST /api/pos/device/session`
 *   → server 用裝置內嘅店主 PIN 即場簽一個全新 Ledger session → 直接跳 `/operator`。
 *
 * ## 🔴 2026-10-23 改版：憑證唔再係 refresh token
 *
 * 舊版存店主 session 嘅 refresh token，結果店主一登出（`signOut({scope:"local"})`
 * 撤銷該 session）憑證即死 —— 店員永遠登入唔到，而且報錯訊息完全誤導。
 * 而家存嘅係 PIN 密文，每次開機都係新 session，同任何登出／輪換無關。
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
 *    頁面一 reload 又即刻登入，睇落似 bug。登入頁會照樣列出身份卡，
 *    只係唔會「未經選擇就自動入」。
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
 * 店主登入成功後，記低 server 發返落嚟嘅裝置憑證。
 *
 * ## 為何唔再係「客戶端主動 POST 授權」
 *
 * 2026-10-23 改版（docs/161）：授權喺 `/api/ledger/login` 成功嗰一刻由 server
 * 直接完成 —— 嗰度係唯一同時知道「storeId + 已驗證嘅 PIN」嘅地方。
 * 客戶端只需要將回傳嘅 `{deviceId, secret}` 寫入 localStorage。
 *
 * 少一次 round-trip、少一次 PIN 傳輸、少一個失敗點。
 */
export function saveBindingFromLogin(input: {
  storeId: string;
  deviceId: string;
  secret: string;
  label?: string;
}): void {
  if (!input.storeId || !input.deviceId || !input.secret) return;
  saveDeviceBinding({
    storeId: input.storeId,
    deviceId: input.deviceId,
    secret: input.secret,
    label: input.label ?? defaultDeviceLabel(),
    boundAt: new Date().toISOString(),
  });
  clearDeviceSignedOut();
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
    // 裝置還原成功 = 呢個分頁已經認過（終端層面）。`/operator` 靠呢個標記
    // 唔會被 AuthGuard 踢返 `/login`（docs/162）。
    markTerminalUnlocked();
    return { ok: true };
  } catch {
    return { ok: false, error: "網絡錯誤，請稍後再試。" };
  }
}

/**
 * 2026-10-23（docs/161）：`syncDeviceBindingRefreshToken()` 已刪除。
 *
 * 舊版要將客戶端輪換後嘅 refresh token 同步返 DB，因為裝置憑證就係嗰張票。
 * 而家裝置存嘅係店主 PIN 密文，每次開機由 server 即場簽一個**全新** session
 * ⇒ DB 冇 token 要保鮮，呢個函數同 `/api/pos/device/session` 嘅 `PATCH` 一齊消失。
 */
