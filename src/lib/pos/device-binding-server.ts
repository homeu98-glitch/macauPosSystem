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
 * `pos_bound_devices`（migration 0073）嘅 server 端讀寫 + 憑證加密。
 *
 * ## 為何要呢一層（2026-10-23，docs/160 §10）
 *
 * 0072 之後店員簽到（L2）仍然要店舖登入（L1），而 L1 只有店主嘅 Ledger 帳密。
 * ⇒ 店員開機一定要店主到場。呢個模組令「店主授權一次」變成可撤銷嘅長期裝置授權。
 *
 * ## 三條鐵律
 *
 * ① **只可以用 `getSupabaseAdminClient()`** —— 張表 RLS 係 service_role only。
 * ② **客戶端 secret 唔會入 DB**：只存 SHA-256。高熵（32 bytes）隨機值 ⇒ 唔需要 PBKDF2
 *    （PBKDF2 係防人類密碼被離線爆破；呢個係機器 secret）。
 * ③ **Ledger refresh token 一定要加密**：AES-256-GCM，金鑰由 `resolvePosTokenSecret()`
 *    派生（同 pv1/sv1 同一條 secret）。DB 洩漏但 env 冇洩漏 ⇒ 解唔到。
 *    ⚠️ 冇 secret = 唔簽發、唔加密 → fail closed（回 503，唔會靜靜存明文）。
 * ④ **表未建 = 可預期狀態**：`tableMissing: true`，route 回提示而唔爆 500。
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
    error: "裝置授權表未建立：請先執行 migration 0073_pos_bound_devices.sql。",
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

export function encryptRefreshToken(plain: string): string | null {
  const key = bindingKey();
  return key ? encryptWithKey(key, plain) : null;
}

export function decryptRefreshToken(enc: string): string | null {
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

export async function upsertBoundDevice(input: {
  storeId: string;
  deviceId: string;
  label: string;
  boundBy: string;
  refreshToken: string;
}): Promise<DeviceBindingOk<{ secret: string }> | DeviceBindingFailure> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return dbMissingFailure();

  const enc = encryptRefreshToken(input.refreshToken);
  if (!enc) {
    return {
      ok: false,
      error: "系統未設定終端憑證密鑰，無法授權裝置（請檢查 POS_DEVICE_TOKEN_SECRET / ADMIN_SESSION_SECRET）。",
      status: 503,
    };
  }

  const secret = newBindingSecret();
  const now = new Date().toISOString();

  const { error } = await supabase.from(TABLE).upsert(
    {
      id: boundDeviceId(input.storeId, input.deviceId),
      store_id: input.storeId,
      device_id: input.deviceId,
      label: input.label,
      bound_by: input.boundBy,
      bound_at: now,
      last_seen_at: null,
      revoked_at: null,
      secret_hash: hashBindingSecret(secret),
      refresh_token_enc: enc,
      token_updated_at: now,
      updated_at: now,
    },
    { onConflict: "id" },
  );

  if (error) {
    if (isMissingTable(error)) return tableMissingFailure();
    console.error("[device-binding] 寫入裝置授權失敗:", error.message);
    return { ok: false, error: "授權裝置失敗，請稍後再試。", status: 503 };
  }

  return { ok: true, secret };
}

export async function revokeBoundDevice(
  storeId: string,
  deviceId: string,
): Promise<DeviceBindingSuccess | DeviceBindingFailure> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return dbMissingFailure();

  const { error } = await supabase
    .from(TABLE)
    .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
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
  refreshToken: string;
};

export async function verifyBoundDevice(
  storeId: string,
  deviceId: string,
  secret: string,
): Promise<DeviceBindingOk<{ device: VerifiedBoundDevice }> | DeviceBindingFailure> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return dbMissingFailure();

  const { data, error } = await supabase
    .from(TABLE)
    .select("store_id, device_id, label, secret_hash, refresh_token_enc, revoked_at")
    .eq("id", boundDeviceId(storeId, deviceId))
    .limit(1);

  if (error) {
    if (isMissingTable(error)) return tableMissingFailure();
    console.error("[device-binding] 讀取裝置授權失敗:", error.message);
    return { ok: false, error: "讀取裝置授權失敗，請稍後再試。", status: 503 };
  }

  const row = data?.[0] as
    | {
        store_id?: string;
        device_id?: string;
        label?: string;
        secret_hash?: string;
        refresh_token_enc?: string;
        revoked_at?: string | null;
      }
    | undefined;

  // 失敗原因刻意唔區分（唔可以俾人探測邊個 device 存在／邊個 secret 錯）
  const deny: DeviceBindingFailure = {
    ok: false,
    error: "呢部機嘅授權已失效，請店主重新授權。",
    status: 401,
  };

  if (!row || row.revoked_at) return deny;
  if (!bindingSecretMatches(secret, String(row.secret_hash ?? ""))) return deny;

  const refreshToken = decryptRefreshToken(String(row.refresh_token_enc ?? ""));
  if (!refreshToken) {
    // 解密失敗 = 金鑰換過（例如改了 secret）⇒ 要店主重新授權，唔可以靜靜失敗
    console.warn("[device-binding] refresh token 解密失敗（secret 可能已更換）:", row.device_id);
    return deny;
  }

  return {
    ok: true,
    device: {
      storeId: String(row.store_id ?? storeId),
      deviceId: String(row.device_id ?? deviceId),
      label: String(row.label ?? ""),
      refreshToken,
    },
  };
}

export async function updateBoundDeviceToken(input: {
  storeId: string;
  deviceId: string;
  refreshToken: string;
}): Promise<DeviceBindingSuccess | DeviceBindingFailure> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return dbMissingFailure();

  const enc = encryptRefreshToken(input.refreshToken);
  if (!enc) {
    return { ok: false, error: "系統未設定終端憑證密鑰。", status: 503 };
  }

  const now = new Date().toISOString();
  const { error } = await supabase
    .from(TABLE)
    .update({
      refresh_token_enc: enc,
      token_updated_at: now,
      last_seen_at: now,
      updated_at: now,
    })
    .eq("id", boundDeviceId(input.storeId, input.deviceId))
    .is("revoked_at", null);

  if (error) {
    if (isMissingTable(error)) return tableMissingFailure();
    console.error("[device-binding] 更新裝置憑證失敗:", error.message);
    return { ok: false, error: "更新裝置憑證失敗。", status: 503 };
  }

  return { ok: true };
}
