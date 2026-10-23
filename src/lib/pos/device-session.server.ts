import "server-only";

import { createClient } from "@supabase/supabase-js";

import { ledgerAuthEmail } from "@/lib/ledger/phone";
import { deriveLedgerAuthPassword } from "@/lib/ledger/pin.server";
import { resolveLedgerPublicConfig } from "@/lib/ledger/supabase-server-auth";
import { loadMerchantGrants } from "@/lib/pos/merchant-modules-server";
import { touchBoundDevice, verifyBoundDevice } from "@/lib/pos/device-binding-server";
import type { MerchantModuleGrants } from "@/lib/pos/module-catalog";

/**
 * 由「已初始化裝置」換一個**全新** Ledger session（docs/160 §10／docs/161）。
 *
 * ## 為何要抽一支共用函數
 *
 * 三個入口都要同一段邏輯：
 *   ① `POST /api/pos/device/session` —— 冇 session 時自動開機（去 `/operator`）；
 *   ② `POST /api/pos/login/identity` —— 店員喺登入頁揀身份後直接開機；
 *   ③ 將來任何「免店主在場」嘅開機路徑。
 * 抄三份必然漂移，而呢段係「一錯就全店登入唔到」嘅高危區。
 *
 * ## 🔴 2026-10-23 改版：唔再用 refresh token
 *
 * 舊實作攞住「店主登入時嗰個 session 嘅 refresh token」去 `refreshSession()`。
 * 結果店主一按登出（`signOut({scope:"local"})` 會撤銷該 session）憑證即死；
 * 加上瀏覽器端 `autoRefreshToken: true` 會喺背景輪換但唔同步返 DB，
 * 仲會被 Supabase 判定 token 重用而撤銷成條 family。
 *
 * 而家改為：解密裝置內嘅**店主 PIN** → `signInWithPassword()` → **全新獨立 session**。
 * 每次開機都係一條新 session，同任何人嘅登出／輪換完全無關。
 * ⇒ 唔再有 `updateBoundDeviceToken` / `syncDeviceBindingRefreshToken` 呢類保鮮動作。
 *
 * ## 失敗語義（route 直接轉發）
 *
 * · `table_missing`     → 200 + `tableReady:false`（0073／0075 未跑）
 * · `device_not_ready`  → 401（secret 錯／已撤銷／舊版 row）
 * · `owner_pin_invalid` → 401（店主改咗 Ledger PIN ⇒ 要重新登入一次）
 * · `secret_missing`    → 503（未設定 `AUTH_PIN_PEPPER` 或 token secret）
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

function createAuthClient() {
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

  const pepper = String(process.env.AUTH_PIN_PEPPER ?? "").trim();
  if (!pepper) {
    return {
      ok: false,
      error: "伺服器尚未設定 AUTH_PIN_PEPPER，暫時無法自動開機。",
      status: 503,
      code: "secret_missing",
    };
  }

  const client = createAuthClient();
  if (!client) {
    return {
      ok: false,
      error: "Ledger 環境變數未設定，暫時無法自動開機。",
      status: 503,
      code: "ledger_not_configured",
    };
  }

  const { account, pin } = verified.device;

  // 🔴 每次都係一個**全新 session**：同店主嘅瀏覽器 session 完全無關。
  //    所以店主登出、SDK 背景輪換、token 過期都唔會影響呢條路徑。
  const { data: signed, error: signInError } = await client.auth.signInWithPassword({
    email: ledgerAuthEmail(account),
    password: deriveLedgerAuthPassword(account, pin, pepper),
  });

  if (signInError || !signed.session) {
    console.warn(
      "[device-session] 用裝置 PIN 換 session 失敗:",
      input.deviceId,
      signInError?.message ?? "no session",
    );
    return {
      ok: false,
      // 最常見原因：店主改咗 Ledger PIN。要講清楚，唔可以講「憑證過期」咁含糊。
      error: "店主嘅 Ledger PIN 已更改，請店主喺呢部機重新登入一次。",
      status: 401,
      code: "owner_pin_invalid",
    };
  }

  void touchBoundDevice(input.storeId, input.deviceId);

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
    accessToken: signed.session.access_token,
    refreshToken: signed.session.refresh_token,
    allowedModules,
  };
}
