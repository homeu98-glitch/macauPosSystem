import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { resolvePosTokenSecret } from "@/lib/pos/pos-device-token";
import type { BoundDeviceDto } from "@/lib/pos/device-binding-types";
import {
  bindingSecretMatches,
  decryptWithKey,
  deriveBindingKey,
  encryptWithKey,
  hashBindingSecret,
  newBindingSecret,
} from "@/lib/pos/device-binding-crypto";

/**
 * `pos_bound_devices`（migration 0073 + 0075）嘅 server 端讀寫 + 憑證加密。
 *
 * ## 為何要呢一層（2026-10-23，docs/160 §10、docs/161）
 *
 * 0072 之後店員簽到（L2）仍然要店舖登入（L1），而 L1 只有店主嘅 Ledger 帳密。
 * ⇒ 店員開機一定要店主到場。呢個模組令「店主授權一次」變成可撤銷嘅長期裝置授權。
 *
 * ## 🔴 憑證係咩（2026-10-23 改版，docs/161）
 *
 * **唔係** refresh token，係**店主 PIN 嘅 AES-256-GCM 密文**。
 *
 * 舊設計存 refresh token，結果：
 *   · 店主一登出（`signOut({scope:"local"})`）就撤銷咗嗰個 session ⇒ 憑證即死；
 *   · 瀏覽器端 `autoRefreshToken: true` 會喺背景輪換 token，唔經
 *     `resolveLedgerSession()` ⇒ DB 嗰份變舊票 ⇒ Supabase 判定 token 重用
 *     ⇒ 成條 family 撤銷。
 * 兩個成因同一個病根：**裝置憑證同店主 session 共用同一條 token**。
 *
 * 改存 PIN 之後，店員登入時即場 `signInWithPassword()` 換一個全新獨立 session，
 * 冇共用 family，登出／輪換／過期全部唔影響。
 *
 * ## 鐵律
 *
 * ① **只可以用 `getSupabaseAdminClient()`** —— 張表 RLS 係 service_role only。
 * ② **客戶端 secret 唔會入 DB**：只存 SHA-256。高熵（32 bytes）隨機值 ⇒ 唔需要 PBKDF2
 *    （PBKDF2 係防人類密碼被離線爆破；呢個係機器 secret）。
 * ③ **PIN 一定要加密**：AES-256-GCM，金鑰由 `resolvePosTokenSecret()` 派生
 *    （同 pv1/sv1 同一條 secret）。DB 洩漏但 env 冇洩漏 ⇒ 解唔到。
 *    ⚠️ 冇 secret = 唔簽發、唔加密 → fail closed（回 503，唔會靜靜存明文）。
 * ④ **PIN 永遠唔會經 HTTP 出街**：`verifyBoundDevice()` 只喺 server 內部用，
 *    route 只會用佢嚟換 session，唔會將 `device.pin` 放落 response。
 * ⑤ **表未建 = 可預期狀態**：`tableMissing: true`，route 回提示而唔爆 500。
 */

const TABLE = "pos_bound_devices";
export type { BoundDeviceDto };

export type DeviceBindingFailure = {
  ok: false;
  error: string;
  status: number;
  tableMissing?: boolean;
};

export type DeviceBindingSuccess = { ok: true };
export type DeviceBindingOk<T> = DeviceBindingSuccess & T;

function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return /42P01|PGRST205|does not exist|schema cache/i.test(
    `${error.code ?? ""} ${error.message ?? ""}`,
  );
}

function tableMissingFailure(): DeviceBindingFailure {
  return {
    ok: false,
    // 兩個成因都走呢條：① 0073 未跑（表都冇）② 0075 未跑（冇 owner_pin_enc 欄）
    // ⇒ 訊息一定要同時提兩個 migration，否則商家跑完 0073 會以為已經搞完。
    error:
      "裝置授權表未建立或未升級：請喺 POS Supabase SQL Editor 依序執行 0073_pos_bound_devices.sql 同 0075_pos_device_pin.sql。",
    status: 200,
    tableMissing: true,
  };
}

function dbMissingFailure(): DeviceBindingFailure {
  return {
    ok: false,
    error: "資料庫未配置（缺少 service-role key），裝置授權暫時不可用。",
    status: 503,
  };
}

// ── 憑證（實際計算喺 device-binding-crypto.ts，方便單元測試）──────────────

export { bindingSecretMatches, hashBindingSecret, newBindingSecret };

function bindingKey(): Buffer | null {
  const secret = resolvePosTokenSecret();
  return secret ? deriveBindingKey(secret) : null;
}

/** 加密一段要留在 DB 嘅機密（現時只有店主 PIN）。 */
export function encryptDeviceSecret(plain: string): string | null {
  const key = bindingKey();
  return key ? encryptWithKey(key, plain) : null;
}

export function decryptDeviceSecret(enc: string): string | null {
  const key = bindingKey();
  return key ? decryptWithKey(key, enc) : null;
}

// ── 列／撤銷 ────────────────────────────────────────────────────────────────

function toDto(row: Record<string, unknown>): BoundDeviceDto {
  return {
    deviceId: String(row.device_id ?? ""),
    storeId: String(row.store_id ?? ""),
    label: String(row.label ?? ""),
    boundBy: String(row.bound_by ?? ""),
    boundAt: String(row.bound_at ?? ""),
    lastSeenAt: typeof row.last_seen_at === "string" ? row.last_seen_at : null,
    revokedAt: typeof row.revoked_at === "string" ? row.revoked_at : null,
  };
}

export function boundDeviceId(storeId: string, deviceId: string): string {
  return `${storeId}:${deviceId}`;
}

export async function listBoundDevices(
  storeId: string,
): Promise<DeviceBindingOk<{ devices: BoundDeviceDto[]; tableMissing: boolean }> | DeviceBindingFailure> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return dbMissingFailure();

  const { data, error } = await supabase
    .from(TABLE)
    .select("device_id, store_id, label, bound_by, bound_at, last_seen_at, revoked_at")
    .eq("store_id", storeId)
    .order("bound_at", { ascending: false });

  if (error) {
    if (isMissingTable(error)) return tableMissingFailure();
    console.error("[device-binding] 讀取裝置授權失敗:", error.message);
    return { ok: false, error: "讀取裝置授權失敗，請稍後再試。", status: 503 };
  }

  return {
    ok: true,
    devices: (data ?? []).map((row) => toDto(row as Record<string, unknown>)),
    tableMissing: false,
  };
}

/**
 * 建立／更新呢部機嘅授權（店主登入成功時由 `/api/ledger/login` 直接呼叫）。
 *
 * ## 🔑 Secret 重用規則（重要）
 *
 * 只有**客戶端出示嘅 secret 對得中 DB 嗰個 hash** 才重用（回 `secret: null`）。
 * 其餘情況一律發新 secret。
 *
 * 為何唔每次都換：店主每次登入都會行到呢度。如果每次都換，而某次 response
 * 冇成功寫入 localStorage（私隱模式／中途斷線），部機就會即刻變「未初始化」
 * —— 明明店主啱啱先登入完，非常難查。
 *
 * 為何唔無條件重用：客戶端可能**冇咗**本機 secret（清 cache／401 之後被清走）。
 * 無條件重用就等於發一張永遠對唔中嘅票，部機會永久壞，只能人手撤銷。
 * ⇒ 出示得到就重用，出示唔到就換新。
 */
export async function upsertBoundDevice(input: {
  storeId: string;
  deviceId: string;
  label: string;
  boundBy: string;
  /** 店主 8 位帳號（normalize 後純數字） */
  account: string;
  /** 店主 4 位 Ledger PIN —— 只會以密文落地 */
  pin: string;
  /** 客戶端現有嘅 secret（冇就唔傳）—— 用嚟判斷可唔可以重用 */
  deviceSecret?: string;
}): Promise<DeviceBindingOk<{ secret: string | null; reused: boolean }> | DeviceBindingFailure> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return dbMissingFailure();

  const account = String(input.account ?? "").replace(/\D/g, "");
  const pin = String(input.pin ?? "").replace(/\D/g, "").slice(0, 4);
  if (!/^\d{8}$/.test(account) || !/^\d{4}$/.test(pin)) {
    return { ok: false, error: "帳號或 PIN 格式不正確。", status: 400 };
  }

  const enc = encryptDeviceSecret(pin);
  if (!enc) {
    return {
      ok: false,
      error: "系統未設定終端憑證密鑰，無法授權裝置（請檢查 POS_DEVICE_TOKEN_SECRET / ADMIN_SESSION_SECRET）。",
      status: 503,
    };
  }

  const id = boundDeviceId(input.storeId, input.deviceId);
  const now = new Date().toISOString();

  // 已經有有效授權，而客戶端又出示得到同一個 secret ⇒ 重用
  const { data: existing, error: readError } = await supabase
    .from(TABLE)
    .select("secret_hash, revoked_at")
    .eq("id", id)
    .limit(1);

  if (readError && isMissingTable(readError)) return tableMissingFailure();

  const existingRow = existing?.[0] as { secret_hash?: string; revoked_at?: string | null } | undefined;
  const reuse = Boolean(
    existingRow?.secret_hash &&
      !existingRow.revoked_at &&
      input.deviceSecret &&
      bindingSecretMatches(input.deviceSecret, existingRow.secret_hash),
  );
  const secret = reuse ? null : newBindingSecret();

  const { error } = await supabase.from(TABLE).upsert(
    {
      id,
      store_id: input.storeId,
      device_id: input.deviceId,
      label: input.label,
      bound_by: input.boundBy,
      // 重用時保留原本 bound_at（「幾時第一次授權」係有用嘅稽核資料）
      bound_at: reuse ? undefined : now,
      last_seen_at: null,
      revoked_at: null,
      secret_hash: reuse ? existingRow?.secret_hash : hashBindingSecret(secret as string),
      owner_account: account,
      owner_pin_enc: enc,
      // 舊欄位：0075 之後唔再用，明確清走避免有人以為仲有效
      refresh_token_enc: null,
      token_updated_at: now,
      updated_at: now,
    },
    { onConflict: "id" },
  );

  if (error) {
    if (isMissingTable(error)) return tableMissingFailure();
    // 0075 未跑 ⇒ 冇 owner_pin_enc 欄（42703）⇒ 講清楚
    if (/42703|column .* does not exist/i.test(`${error.code ?? ""} ${error.message ?? ""}`)) {
      return {
        ok: false,
        error: "裝置授權表未升級：請先執行 migration 0075_pos_device_pin.sql。",
        status: 200,
        tableMissing: true,
      };
    }
    console.error("[device-binding] 寫入裝置授權失敗:", error.message);
    return { ok: false, error: "授權裝置失敗，請稍後再試。", status: 503 };
  }

  return { ok: true, secret, reused: reuse };
}

export async function revokeBoundDevice(
  storeId: string,
  deviceId: string,
): Promise<DeviceBindingSuccess | DeviceBindingFailure> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return dbMissingFailure();

  const now = new Date().toISOString();
  const { error } = await supabase
    .from(TABLE)
    .update({
      revoked_at: now,
      updated_at: now,
      // 撤銷即刻清走 PIN 密文：唔好留低一張「已撤銷但仲解得開」嘅票
      owner_pin_enc: null,
      refresh_token_enc: null,
    })
    .eq("id", boundDeviceId(storeId, deviceId))
    .is("revoked_at", null);

  if (error) {
    if (isMissingTable(error)) return tableMissingFailure();
    console.error("[device-binding] 撤銷裝置授權失敗:", error.message);
    return { ok: false, error: "撤銷裝置授權失敗，請稍後再試。", status: 503 };
  }

  return { ok: true };
}

// ── 驗證（開機用）────────────────────────────────────────────────────────────

export type VerifiedBoundDevice = {
  storeId: string;
  deviceId: string;
  label: string;
  /** 店主 8 位帳號 */
  account: string;
  /** 店主 4 位 PIN（**只可以**喺 server 內部用嚟換 session） */
  pin: string;
};

type DeviceRow = {
  store_id?: string;
  device_id?: string;
  label?: string;
  secret_hash?: string;
  owner_account?: string;
  owner_pin_enc?: string;
  revoked_at?: string | null;
};

const DENY: DeviceBindingFailure = {
  ok: false,
  // 失敗原因刻意唔區分（唔可以俾人探測邊個 device 存在／邊個 secret 錯）
  error: "呢部機嘅授權已失效，請店主重新登入一次。",
  status: 401,
};

function toVerified(row: DeviceRow, fallbackStoreId: string, fallbackDeviceId: string) {
  const pin = decryptDeviceSecret(String(row.owner_pin_enc ?? ""));
  const account = String(row.owner_account ?? "").replace(/\D/g, "");
  if (!pin || !/^\d{8}$/.test(account)) {
    // 解密失敗 = 金鑰換過；冇 PIN = 升級前嘅舊 row（0073 存嘅係 refresh token）
    // 兩種情況都一定要店主重新登入，唔可以靜靜失敗
    console.warn(
      "[device-binding] 裝置憑證唔可用（舊版 row 或 secret 已更換）:",
      row.device_id,
    );
    return null;
  }
  return {
    storeId: String(row.store_id ?? fallbackStoreId),
    deviceId: String(row.device_id ?? fallbackDeviceId),
    label: String(row.label ?? ""),
    account,
    pin,
  } satisfies VerifiedBoundDevice;
}

export async function verifyBoundDevice(
  storeId: string,
  deviceId: string,
  secret: string,
): Promise<DeviceBindingOk<{ device: VerifiedBoundDevice }> | DeviceBindingFailure> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return dbMissingFailure();

  const { data, error } = await supabase
    .from(TABLE)
    .select("store_id, device_id, label, secret_hash, owner_account, owner_pin_enc, revoked_at")
    .eq("id", boundDeviceId(storeId, deviceId))
    .limit(1);

  if (error) {
    if (isMissingTable(error)) return tableMissingFailure();
    console.error("[device-binding] 讀取裝置授權失敗:", error.message);
    return { ok: false, error: "讀取裝置授權失敗，請稍後再試。", status: 503 };
  }

  const row = data?.[0] as DeviceRow | undefined;
  if (!row || row.revoked_at) return DENY;
  if (!bindingSecretMatches(secret, String(row.secret_hash ?? ""))) return DENY;

  const device = toVerified(row, storeId, deviceId);
  if (!device) return DENY;

  return { ok: true, device };
}

/**
 * 用 `device_id` 直接搵（**唔需要** storeId）—— 裝置模式用。
 *
 * 為何要呢個：已初始化嘅機唔應該再要店員打 8 位店舖帳號（佢根本唔知）。
 * `pos_bound_devices.id` 係 `${storeId}:${deviceId}`，冇 storeId 就查唔到，
 * 所以先用 `device_id` 索引反查 store_id，再驗 secret。
 *
 * 安全：deviceId 係 128-bit 隨機 UUID，而且**仍然要對中 secret** 才會過。
 */
export async function verifyBoundDeviceByDeviceId(
  deviceId: string,
  secret: string,
): Promise<DeviceBindingOk<{ device: VerifiedBoundDevice }> | DeviceBindingFailure> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return dbMissingFailure();

  const { data, error } = await supabase
    .from(TABLE)
    .select("store_id, device_id, label, secret_hash, owner_account, owner_pin_enc, revoked_at")
    .eq("device_id", deviceId)
    .is("revoked_at", null)
    .limit(5);

  if (error) {
    if (isMissingTable(error)) return tableMissingFailure();
    console.error("[device-binding] 讀取裝置授權失敗:", error.message);
    return { ok: false, error: "讀取裝置授權失敗，請稍後再試。", status: 503 };
  }

  for (const raw of data ?? []) {
    const row = raw as DeviceRow;
    if (!bindingSecretMatches(secret, String(row.secret_hash ?? ""))) continue;
    const device = toVerified(row, "", deviceId);
    if (!device) return DENY;
    return { ok: true, device };
  }

  return DENY;
}

/** 記錄「最後使用時間」。失敗靜默（純稽核，唔可以阻登入）。 */
export async function touchBoundDevice(storeId: string, deviceId: string): Promise<void> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return;
  const now = new Date().toISOString();
  const { error } = await supabase
    .from(TABLE)
    .update({ last_seen_at: now, updated_at: now })
    .eq("id", boundDeviceId(storeId, deviceId));
  if (error && !isMissingTable(error)) {
    console.warn("[device-binding] 更新最後使用時間失敗（可忽略）:", error.message);
  }
}
