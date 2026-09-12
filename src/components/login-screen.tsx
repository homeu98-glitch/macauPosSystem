"use client";

import { KeyboardEvent, useState } from "react";

import { PwaInstallButton, isRunningInNativeShell } from "@/components/pwa-install-button";
import { getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";
import { applyWorkbenchSelection } from "@/lib/pos/apply-workbench";
import {
  WORKBENCH_IDS,
  findWorkbench,
  type MerchantModuleGrants,
  type WorkbenchId,
} from "@/lib/pos/module-catalog";
import { resolveRememberedWorkbench } from "@/lib/pos/workbench-preference";
import { applyLedgerMerchantToBootstrap } from "@/lib/store-display";
import {
  loadBootstrapCache,
  saveAuthSession,
  saveBootstrapCache,
  type AuthSession,
} from "@/lib/storage";

/**
 * 登入頁（2026-09-13 改版，見 migration 0037 / docs/127）。
 *
 * ## 呢一頁而家**只做一件事**：證明「你係邊個」
 *
 * 改版之前，呢一頁同時要撳「模式」（快餐／堂食／美容／自助點餐機／後廚屏／出餐台屏）
 * 同帳號 PIN —— 即係「未證明身份就先揀咗要做咩」。後果：
 *
 * - 6 個模式**人人見到**，包括商戶根本冇買嘅模組；
 * - Admin 後台想按商戶收窄可選範圍，只能改代碼，做唔到；
 * - 揀錯模式 = 直接登入咗一個唔應該入嘅畫面。
 *
 * 而家拆成兩步：
 *
 *   ① `/login`             帳號 + PIN          → 證明身份
 *   ② `/select-workbench`  揀呢部機做邊個崗位  → 只列 Admin 已開通嘅模組
 *
 * ## 兩個「唔使再揀」嘅捷徑
 *
 * 揀工作台之後仍然會喺兩處直接跳過第 ② 步（見 `enterWorkbench()`）：
 * - **深連結**：`/login?mode=kiosk` —— 保留舊有預約安裝／桌面捷徑嘅行為。
 * - **記住呢部機**：收銀機／後廚屏係固定崗位，每次開機都問一次好煩。
 *
 * ⚠️ 兩個捷徑都**必須先過授權檢查**：Admin 收窄咗之後，唔可以因為
 *    「上次用過」或者「URL 寫死」就自動入返一個已經被閂嘅工作台。
 *
 * ⚠️ 呢一頁**唔應該**再有任何工作台相關嘅副作用（綁店、寫店級掃碼模式、
 *    綁 KDS 崗位…）—— 全部搬晒去 `@/lib/pos/apply-workbench`，
 *    由 `enterWorkbench()` 呼叫。喺呢度抄一份 = 兩個地方各寫一半，日後必然走樣。
 */

type LoginPayloadSession = {
  account: string;
  name: string;
  role: "admin" | "manager" | "cashier";
  merchantId?: string;
  storeIds?: string[];
  permissions: {
    refundOrder: boolean;
    voidItem: boolean;
    manageAccounts?: boolean;
  };
  /** 商戶模組授權（migration 0037）。缺失 = 全部開通。 */
  allowedModules?: MerchantModuleGrants;
  ledgerAccessToken?: string;
  ledgerRefreshToken?: string;
  /** POS 終端憑證（12h HMAC）—— 由 `/api/ledger/login` 簽發，見 docs/113。 */
  posDeviceToken?: string;
};

/** 深連結 `/login?mode=kitchen` 用；只有合法工作台 id 才接納。 */
function readRequestedWorkbench(): WorkbenchId | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("mode");
  if (!raw) return null;
  return findWorkbench(raw)?.id ?? null;
}

export function LoginScreen() {
  const [account, setAccount] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // 原生殼（Android APK / PC Electron）入面唔使顯示 PWA 安裝入口
  const [isNativeShell] = useState<boolean>(() => isRunningInNativeShell());

  /**
   * 落地：套用工作台副作用，然後整頁跳去對應首頁。
   *
   * ⚠️ 一律用 `window.location.replace()` 而唔係 SPA 跳轉：
   * 登入啱啱換咗 authSession + merchantId，SPA 跳轉會殘留舊 store scope 嘅
   * React state（orders / bootstrap / deviceConfig 等），只有整頁 reload
   * 先確保所有 localStorage + React state 一致（同改版前 `accountSwitched`
   * 路徑嘅處理一致）。
   */
  async function enterWorkbench(workbench: WorkbenchId, session: AuthSession) {
    await applyWorkbenchSelection(workbench, session);
    window.location.replace(findWorkbench(workbench)?.homePath ?? "/");
  }

  async function submit() {
    setError("");
    const normalizedAccount = account.replace(/\D/g, "").slice(0, 8);
    const normalizedPin = pin.replace(/\D/g, "").slice(0, 4);

    if (!/^\d{8}$/.test(normalizedAccount)) {
      setError("請輸入 8 位數字帳號。");
      return;
    }
    if (!/^\d{4}$/.test(normalizedPin)) {
      setError("請輸入 4 位數字密碼。");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/ledger/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: normalizedAccount, pin: normalizedPin }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        error?: string;
        session?: LoginPayloadSession;
        accessToken?: string;
        refreshToken?: string;
      };

      if (!payload.ok || !payload.session) {
        throw new Error(payload.error ?? "登入失敗");
      }

      const session = {
        ...payload.session,
        loggedInAt: new Date().toISOString(),
        ledgerAccessToken: payload.session.ledgerAccessToken ?? payload.accessToken,
        ledgerRefreshToken: payload.session.ledgerRefreshToken ?? payload.refreshToken,
      };

      saveAuthSession(session);

      // 統一行為：saveAuthSession 已經自動 dispatch `pos-auth-changed`。
      // 任何 React component 訂閱呢個事件都會自動 reset + 重 backfill。

      const cachedBootstrap = loadBootstrapCache();
      if (cachedBootstrap && session.name) {
        saveBootstrapCache(applyLedgerMerchantToBootstrap(cachedBootstrap, session));
      }

      const client = getLedgerSupabaseClient();
      if (client && session.ledgerAccessToken && session.ledgerRefreshToken) {
        await client.auth.setSession({
          access_token: session.ledgerAccessToken,
          refresh_token: session.ledgerRefreshToken,
        });
      }

      // ── 要唔要跳過「選擇工作台」？──
      const granted: WorkbenchId[] = session.allowedModules?.workbenches ?? [...WORKBENCH_IDS];

      const requested = readRequestedWorkbench();
      if (requested && granted.includes(requested)) {
        await enterWorkbench(requested, session);
        return;
      }

      const remembered = resolveRememberedWorkbench(session.merchantId, granted);
      if (remembered) {
        await enterWorkbench(remembered, session);
        return;
      }

      // 未揀過 / 冇記住 → 入選擇頁（整頁 reload，確保 session 一致）。
      window.location.replace("/select-workbench");
    } catch (err) {
      setError(err instanceof Error ? err.message : "登入失敗");
    } finally {
      setLoading(false);
    }
  }

  function handleEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void submit();
  }

  return (
    /*
      🔴 `fixed inset-0 overflow-y-auto` 唔可以改返 `min-h-screen overflow-hidden`：
      root layout 嘅 <body> 係 `h-full overflow-hidden`，卡片一高過視窗
      就會被切走而且冇得滾。
    */
    <div className="fixed inset-0 overflow-y-auto login-animated-bg">
      <div className="pointer-events-none fixed inset-0">
        <div className="login-blob absolute -left-24 top-10 h-72 w-72 rounded-full bg-fuchsia-500/60" />
        <div className="login-blob absolute -right-24 top-24 h-80 w-80 rounded-full bg-cyan-400/60 [animation-delay:1.4s]" />
        <div className="login-blob absolute left-1/3 bottom-[-120px] h-96 w-96 -translate-x-1/2 rounded-full bg-amber-400/50 [animation-delay:2.6s]" />
        <div className="absolute inset-0 bg-slate-950/35" />
      </div>

      <div className="relative mx-auto flex min-h-full max-w-lg flex-col justify-center px-6 py-10">
        <div className="rounded-3xl border border-white/15 bg-white/10 p-8 shadow-2xl backdrop-blur">
          <div className="text-center">
            <div className="text-sm font-semibold tracking-widest text-orange-200/90">澳門會員通POS系統</div>
            <div className="mt-2 text-2xl font-semibold text-white">登入</div>
            <div className="mt-2 text-sm text-white/70">請使用 Ledger 商戶 8 位電話及 4 位 PIN。</div>
          </div>

          <div className="mt-6 grid gap-3">
            <label className="grid gap-1">
              <span className="text-xs font-semibold text-white/70">帳號（8 位數字）</span>
              <input
                className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none ring-orange-500/40 placeholder:text-white/30 focus:ring-2"
                inputMode="numeric"
                maxLength={8}
                onKeyDown={handleEnter}
                onChange={(event) => {
                  setError("");
                  setAccount(event.target.value.replace(/\D/g, "").slice(0, 8));
                }}
                placeholder="商戶電話"
                value={account}
              />
            </label>

            <label className="grid gap-1">
              <span className="text-xs font-semibold text-white/70">密碼（4 位 PIN）</span>
              <input
                className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none ring-orange-500/40 placeholder:text-white/30 focus:ring-2"
                inputMode="numeric"
                maxLength={4}
                onKeyDown={handleEnter}
                onChange={(event) => {
                  setError("");
                  setPin(event.target.value.replace(/\D/g, "").slice(0, 4));
                }}
                placeholder="PIN"
                type="password"
                value={pin}
              />
            </label>
          </div>

          {error ? (
            <div className="mt-4 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-100">
              {error}
            </div>
          ) : null}

          <button
            className="mt-5 w-full rounded-2xl bg-orange-500 px-4 py-3 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-60"
            disabled={loading}
            onClick={() => void submit()}
            type="button"
          >
            {loading ? "正在登入…" : "登入"}
          </button>

          {isNativeShell ? null : <PwaInstallButton />}

          <div className="mt-4 text-center text-xs text-white/60">
            登入成功之後，先揀呢部機要進入邊個工作台。
          </div>
          <div className="mt-2 text-center text-xs text-white/40">
            使用會員通商戶帳號登入（與 Ledger Web / Android 相同）
          </div>
        </div>
      </div>
    </div>
  );
}
