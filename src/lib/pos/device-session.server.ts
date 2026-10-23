import "server-only";

import { createClient } from "@supabase/supabase-js";

import { resolveLedgerPublicConfig } from "@/lib/ledger/supabase-server-auth";
import { loadMerchantGrants } from "@/lib/pos/merchant-modules-server";
import { updateBoundDeviceToken, verifyBoundDevice } from "@/lib/pos/device-binding-server";
import type { MerchantModuleGrants } from "@/lib/pos/module-catalog";

/**
 * 由「已初始化裝置」換一對**真嘅** Ledger token（docs/160 §10／§11）。
 *
 * ## 為何要抽一支共用函數
 *
 * 兩個入口都要同一段邏輯：
 *   ① `POST /api/pos/device/session` —— 冇 session 時自動開機（去 `/operator`）；
 *   ② `POST /api/pos/login/identity` —— 店員喺登入頁揀身份後直接開機。
 * 抄兩份必然漂移，而呢段係「一錯就全店登入唔到」嘅高危區。
 *
 * ## 🔴 Refresh token 輪換
 *
 * Supabase 每次 refresh 都輪換 refresh token。所以換完**一定要即刻**寫返 DB
 * （`updateBoundDeviceToken`），否則客戶端下次自己 refresh 之後，DB 嗰張變廢票 ⇒
 * 第二日開機「授權已失效」，而且查唔到原因。
 */

export type MintedDeviceSession = {
  ok: true;
  storeId: string;
  storeName: string;
  accessToken: string;
  refreshToken: string;
  allowedModules: MerchantModuleGrants;
};

export type MintDeviceSessionFailure = {
  ok: false;
  error: string;
  status: number;
  code: string;
  /** 表未建（migration 未跑）—— route 可以回 200 + tableReady:false */
  tableMissing?: boolean;
};

function createRefreshClient() {
  const { url, anonKey } = resolveLedgerPublicConfig();
  if (!url || !anonKey) return null;
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export async function mintSessionFromBoundDevice(input: {
  storeId: string;
  deviceId: string;
  secret: string;
}): Promise<MintedDeviceSession | MintDeviceSessionFailure> {
  const verified = await verifyBoundDevice(input.storeId, input.deviceId, input.secret);
  if (!verified.ok) {
    return {
      ok: false,
      error: verified.error,
      status: verified.status,
      code: verified.tableMissing ? "table_missing" : "device_not_ready",
      tableMissing: verified.tableMissing,
    };
  }

  const client = createRefreshClient();
  if (!client) {
    return {
      ok: false,
      error: "Ledger 環境變數未設定，暫時無法自動開機。",
      status: 503,
      code: "ledger_not_configured",
    };
  }

  const { data: refreshed, error: refreshError } = await client.auth.refreshSession({
    refresh_token: verified.device.refreshToken,
  });

  if (refreshError || !refreshed.session) {
    console.warn(
      "[device-session] refresh token 已失效:",
      input.deviceId,
      refreshError?.message ?? "no session",
    );
    return {
      ok: false,
      error: "呢部機嘅登入憑證已過期，請店主重新登入一次。",
      status: 401,
      code: "binding_expired",
    };
  }

  const accessToken = refreshed.session.access_token;
  const refreshToken = refreshed.session.refresh_token;

  const saved = await updateBoundDeviceToken({
    storeId: input.storeId,
    deviceId: input.deviceId,
    refreshToken,
  });
  if (!saved.ok) {
    // 寫唔返 = 下次開機一定失敗。要嘈（但唔可以令今次開機失敗）。
    console.error("[device-session] 未能保存輪換後嘅 refresh token:", saved.error);
  }

  const { data: merchantRows } = await client
    .from("merchants")
    .select("status, name")
    .eq("id", input.storeId)
    .limit(1);
  const merchant = merchantRows?.[0] as { status?: string; name?: string } | undefined;
  const merchantStatus = String(merchant?.status ?? "").toLowerCase();
  if (merchantStatus && merchantStatus !== "active" && merchantStatus !== "pending") {
    return {
      ok: false,
      error: "商戶狀態異常，暫時無法開機。",
      status: 403,
      code: "merchant_inactive",
    };
  }

  const allowedModules = await loadMerchantGrants(input.storeId);

  return {
    ok: true,
    storeId: input.storeId,
    storeName: merchant?.name ?? verified.device.label ?? "店舖終端",
    accessToken,
    refreshToken,
    allowedModules,
  };
}
