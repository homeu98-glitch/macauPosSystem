"use client";

import { useRouter } from "next/navigation";
import { KeyboardEvent, useState } from "react";

import { PwaInstallButton, isRunningInNativeShell } from "@/components/pwa-install-button";
import { getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";
import { saveKioskSettings } from "@/lib/pos/kiosk-settings";
import { posDeviceAuthHeaders } from "@/lib/pos/pos-sync-auth";
import { scanModeForLoginMode, type LoginMode } from "@/lib/pos/scan-mode-from-login";
import { applyLedgerMerchantToBootstrap } from "@/lib/store-display";
import { loadBootstrapCache, loadAuthSession, saveAuthSession, saveBootstrapCache, saveOperatingMode } from "@/lib/storage";
import { saveKioskDeviceBinding, saveKioskMode } from "@/lib/kiosk-order";
import {
  clearKdsDeviceBinding,
  loadKdsDeviceBinding,
  saveKdsDeviceBinding,
} from "@/lib/kds/device-binding";
import { setTerminalIndustry } from "@/lib/salon/industry-config";
import { saveActiveSalonStore } from "@/lib/salon/storage";

export function LoginScreen() {
  const router = useRouter();
  const [account, setAccount] = useState("");
  const [pin, setPin] = useState("");
  // 深連結：`/login?mode=kiosk` / `?mode=kitchen` 可以直接預選裝置角色。
  const initialMode: LoginMode = (() => {
    if (typeof window === "undefined") return "dinein";
    const requested = new URLSearchParams(window.location.search).get("mode");
    return requested === "kiosk" || requested === "kitchen" || requested === "expo"
      ? requested
      : "dinein";
  })();
  const [mode, setMode] = useState<LoginMode>(initialMode);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // 原生殼（Android APK / PC Electron）入面唔使顯示 PWA 安裝入口
  const [isNativeShell] = useState<boolean>(() => isRunningInNativeShell());

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
        session?: {
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
          ledgerAccessToken?: string;
          ledgerRefreshToken?: string;
          /** POS 終端憑證（12h HMAC）—— 由 `/api/ledger/login` 簽發，見 docs/113。 */
          posDeviceToken?: string;
        };
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

      // ── Kiosk 模式：綁定呢台機到所屬店 ──
      // ⚠️ 呢度**唔可以再 early return 掉 staff session**（docs/87 P0-7）。
      // 自助點餐機要做 Ledger 會員扣款（`lookupCustomerWallet` / `applyPosDeduct`），
      // 而呢啲 RPC 按 `docs/integration/ledger-client-api.md` 嘅合約，必須喺
      // authenticated session 下 call（權限由 `auth.uid()` / `is_merchant_staff()` 保證），
      // service_role 取代唔到。所以下面 saveAuthSession + Ledger setSession 要照行。
      // 改動只係：額外寫綁店記錄，最後 redirect 去 `/order` 而唔係 `/`。
      if (mode === "kiosk") {
        // ⚠️ 唔好再 `?? DEFAULT_KIOSK_STORE_ID`。
        // `macau-store-a` 係示範店代碼（唔係 merchants.id），寫落綁定之後
        // `resolveStoreId()` 會拎到佢 → sync 落 pos_print_jobs.store_id →
        // 雲端中繼「配咗對但一張單都印唔出」（最難 debug 嗰種 silent failure）。
        // 冇 merchantId 就**唔好寫綁定**：resolveStoreId() 會返 undefined，
        // sync 大聲 400 提示重新登入 —— 好過靜默寫錯店。
        if (session.merchantId) {
          saveKioskDeviceBinding({
            storeId: session.merchantId,
            storeName: session.name,
            language: "zh-HK",
            boundAt: new Date().toISOString(),
          });
        } else {
          console.error(
            "[login] kiosk 模式但 session 冇 merchantId —— 唔寫綁定。呢部機嘅 sync 會 400 住，重新登入拎到 merchantId 先正常。",
          );
        }
        // 「狀態同模式保持一致」（2026-09-10 補）：揀咗「自助點餐機」就順手開埋
        // 本機 kiosk 旗標，否則登入完跳一次 `/order`，**下次重開呢部機又變返收銀台**
        // ——商家會覺得「明明揀咗自助點餐機，點解冇生效」。
        //
        // ⚠️ 刻意**唔**反向做（其他模式唔 `saveKioskMode(false)`）：kiosk 旗標係
        // 裝置設定，要停用有明確入口（`/order` 右上角「設定」→「退出自助點餐模式」）。
        // 如果每次登入都覆寫，喺同一部平板補做收銀就會靜靜熄咗 kiosk。
        saveKioskMode(true);
      }

      const previousAuth = loadAuthSession();
      const previousMerchantId = previousAuth?.merchantId;

      saveAuthSession(session);

      // 統一行為：saveAuthSession 已經自動 dispatch `pos-auth-changed`。
      // 任何 React component 訂閱呢個事件都會自動 reset + 重 backfill；
      // 喺呢度額外 force full reload，只係「保險網」，確保連冇訂閱嘅快取（kiosk binding、
      // 不同 page 嘅 mount state）都會被洗。

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

      // ── 掃碼點餐模式：由登入模式決定（docs/115 §12）──
      // 快餐登入 → 店級 quick（全店一碼）；堂食登入 → dine_in（每枱一碼）。
      // 設定頁唔再提供模式選擇器，所以呢一步係**唯一**嘅寫入點。
      //
      // ⚠️ 必須喺 `saveAuthSession()` **之後**做：POST `/api/pos/kiosk-settings`
      // 要帶 POS 終端憑證，而憑證就喺 `authSession.posDeviceToken`（登入 API 已簽發）。
      //
      // ⚠️ `scanMode` 係 `null` 時（kiosk / salon 登入）**一定要跳過**：
      // 自助點餐機同收銀機可以同時存在，kiosk 寫 `quick` 會同收銀台嘅堂食登入
      // 互相覆蓋 → 設定頁每次登入顯示嘅碼都唔同。詳見 `scan-mode-from-login.ts`。
      //
      // 離線 / 失敗都**唔可以阻住登入**：呢個只係「順手對齊設定」，
      // 失敗就保留 DB 舊值（設定頁仍然會顯示舊值，唔會出現假狀態）。
      // 用 `Promise.race` 加 2.5 秒上限，避免離線時卡住登入畫面。
      const loginScanMode = scanModeForLoginMode(mode);
      if (loginScanMode && session.merchantId) {
        await Promise.race([
          saveKioskSettings(
            session.merchantId,
            { scanMode: loginScanMode },
            posDeviceAuthHeaders(),
          ).catch(() => undefined),
          new Promise<void>((resolve) => {
            setTimeout(() => resolve(), 2500);
          }),
        ]);
      }

      // 自助點餐機只做快餐（規格 5），同「快餐」模式一樣用 quick。
      // ⚠️ 後廚屏 / 出餐台屏係**裝置角色**，唔應該改店級「營運模式」——
      // 同一部機之後補做收銀，就會靜靜變咗快餐／堂食。所以呢兩個模式跳過。
      if (mode !== "kitchen" && mode !== "expo") {
        saveOperatingMode(mode === "kiosk" || mode === "quick" ? "quick" : "dinein");
      }

      // ── 後廚屏 / 出餐台屏：唔寫店級設定，只確保綁定唔會跨店殘留 ──
      // ⚠️ 崗位（廚房／水吧）**唔喺呢度揀** —— 要入到 `/kitchen` 先揀，
      //    揀完先寫入完整綁定（見 docs/116 §4.4）。所以呢度唔寫半截綁定。
      if (mode === "kitchen" || mode === "expo") {
        const existingBinding = loadKdsDeviceBinding();
        // 換咗店 **或者換咗角色** → 舊綁定一定要清。
        // 唔清就會出現「呢部機上一個角色係廚房屏、今次揀出餐台屏，但仲留住個崗位」。
        if (
          existingBinding &&
          (existingBinding.storeId !== session.merchantId || existingBinding.role !== mode)
        ) {
          clearKdsDeviceBinding();
        }
        // 出餐台屏**唔需要崗位**（佢要睇整單核對），所以即刻寫得。
        // 廚房屏相反：要入到 `/kitchen` 揀完崗位先寫完整綁定。
        if (mode === "expo" && session.merchantId) {
          saveKdsDeviceBinding({
            storeId: session.merchantId,
            storeName: session.name,
            role: "expo",
            boundAt: new Date().toISOString(),
          });
        }
      }

      // 統一用「帳號」比對而唔係「merchantId」比對：
      // - 60000002 → 65273599（同店換人）→ SPA 切換會殘留舊 store scope 嘅 React state；
      // - 任何 account 變更都 force 整頁 reload，咁樣最安全。
      const accountSwitched =
        Boolean(previousAuth?.account) && previousAuth?.account !== session.account;
      // 保留舊嘅 merchantId 切換判定（salon / 跨店）向下相容。
      const storeSwitched = Boolean(
        previousMerchantId && session.merchantId && previousMerchantId !== session.merchantId,
      );

      if (mode === "salon") {
        setTerminalIndustry("salon");
        // 綁定真實 Ledger 商戶（store）：salon 數據以 merchantId 為 scope，唔再用 demo-salon-001。
        if (session.merchantId) {
          saveActiveSalonStore(session.merchantId);
        }
        if (accountSwitched || storeSwitched) {
          window.location.replace("/salon");
          return;
        }
        router.replace("/salon");
        return;
      }

      // kiosk → 自助點餐介面；後廚屏 → 揀崗位 / 入屏；出餐台屏 → /expo；其他 → 收銀台
      const homePath =
        mode === "kiosk" ? "/order" : mode === "kitchen" ? "/kitchen" : mode === "expo" ? "/expo" : "/";

      // 任何帳號切換（即使同一個 merchantId）→ 整頁 reload。
      // 原因：SPA 切換會殘留舊 store scope 嘅 React state（orders / bootstrap / deviceConfig 等），
      // 只有整頁 reload 先確保 authSession + 所有 localStorage + 所有 React state 一致。
      if (accountSwitched || storeSwitched) {
        window.location.replace(homePath);
        return;
      }

      router.replace(homePath);
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

  /**
   * 各登入模式各自會套用到嘅「掃碼點餐」口徑（docs/115 §12）。
   *
   * 呢段文案就係需求講嘅「依所選模式呈現對應設定」——所以每個模式都要講出
   * **客人會攞到咩碼**，唔可以只講收銀台行為（商家關注嘅係貼紙印幾張）。
   * `kiosk` / `salon` / `kitchen` / `expo` 要明確寫「不適用 / 唔會改動」，否則商家會以為
   * 登入完全店嘅掃碼設定會冇咗。
   */
  const scanOrderHint: Record<LoginMode, string> = {
    quick: "全店只有一個碼（印出貼喺櫃檯／快餐區），客人掃碼自助落單，每張單獨立、冇枱號。",
    dinein: "每張桌台各自一個碼，客人掃碼落單會綁定枱號；同一枱再加單會加入同一張單。",
    kiosk: "不適用 —— 客人喺呢部機直接落單，唔使用掃碼貼紙；亦唔會改動店鋪現有嘅掃碼設定。",
    salon: "不適用 —— 美容係預約制，唔涉及掃碼點餐。",
    kitchen:
      "不適用 —— 後廚屏係一部機嘅角色，唔會改動店鋪現有嘅掃碼設定。登入之後要先揀呢部機嘅崗位（廚房／水吧），揀完會鎖定，唔可以即場切換。",
    expo: "不適用 —— 出餐台屏係一部機嘅角色，唔會改動店鋪現有嘅掃碼設定。",
  };

  return (
    <div className="relative min-h-screen overflow-hidden login-animated-bg">
      <div className="pointer-events-none absolute inset-0">
        <div className="login-blob absolute -left-24 top-10 h-72 w-72 rounded-full bg-fuchsia-500/60" />
        <div className="login-blob absolute -right-24 top-24 h-80 w-80 rounded-full bg-cyan-400/60 [animation-delay:1.4s]" />
        <div className="login-blob absolute left-1/3 bottom-[-120px] h-96 w-96 -translate-x-1/2 rounded-full bg-amber-400/50 [animation-delay:2.6s]" />
        <div className="absolute inset-0 bg-slate-950/35" />
      </div>

      <div className="relative mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-10">
        <div className="rounded-3xl border border-white/15 bg-white/10 p-8 shadow-2xl backdrop-blur">
          <div className="text-center">
            <div className="text-sm font-semibold tracking-widest text-orange-200/90">澳門會員通POS系統</div>
            <div className="mt-2 text-2xl font-semibold text-white">登入</div>
            <div className="mt-2 text-sm text-white/70">請使用 Ledger 商戶 8 位電話及 4 位 PIN。</div>
          </div>

          <div className="mt-6 grid gap-3">
            <div className="grid gap-1">
              <span className="text-xs font-semibold text-white/70">模式</span>
              <div className="grid grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-black/20 p-2">
                <button
                  className={`rounded-2xl px-3 py-2 text-sm font-semibold transition ${
                    mode === "quick" ? "bg-orange-500 text-white" : "bg-white/5 text-white/70 hover:bg-white/10"
                  }`}
                  onClick={() => setMode("quick")}
                  type="button"
                >
                  快餐
                </button>
                <button
                  className={`rounded-2xl px-3 py-2 text-sm font-semibold transition ${
                    mode === "dinein" ? "bg-orange-500 text-white" : "bg-white/5 text-white/70 hover:bg-white/10"
                  }`}
                  onClick={() => setMode("dinein")}
                  type="button"
                >
                  堂食
                </button>
                <button
                  className={`rounded-2xl px-3 py-2 text-sm font-semibold transition ${
                    mode === "salon" ? "bg-rose-500 text-white" : "bg-white/5 text-white/70 hover:bg-white/10"
                  }`}
                  onClick={() => setMode("salon")}
                  type="button"
                >
                  美容
                </button>
                <button
                  className={`rounded-2xl px-3 py-2 text-sm font-semibold transition ${
                    mode === "kiosk" ? "bg-emerald-500 text-white" : "bg-white/5 text-white/70 hover:bg-white/10"
                  }`}
                  onClick={() => setMode("kiosk")}
                  type="button"
                >
                  自助點餐機
                </button>
                {/*
                  後廚屏 / 出餐台屏（KDS）—— 見 docs/116 §4.1 / §4.4 / §7.2。
                  ⚠️ 揀「後廚屏」只係「呢部機做後廚屏」；**分區**（後廚1/2/3、水吧1/2/3…）
                  要入到 `/kitchen` 先揀，揀完會鎖死，唔可以喺屏內即場切換（防誤按）。
                  「出餐台屏」唔需要分區（佢要睇整單核對齊唔齊）。
                */}
                <button
                  className={`rounded-2xl px-3 py-2.5 text-[13px] font-semibold leading-tight transition ${
                    mode === "kitchen" ? "bg-emerald-500 text-white" : "bg-white/5 text-white/70 hover:bg-white/10"
                  }`}
                  onClick={() => setMode("kitchen")}
                  type="button"
                >
                  後廚屏
                  <span className="block text-[11px] font-normal opacity-70">逐件菜撳 ✓</span>
                </button>
                <button
                  className={`rounded-2xl px-3 py-2.5 text-[13px] font-semibold leading-tight transition ${
                    mode === "expo" ? "bg-sky-500 text-white" : "bg-white/5 text-white/70 hover:bg-white/10"
                  }`}
                  onClick={() => setMode("expo")}
                  type="button"
                >
                  出餐台屏
                  <span className="block text-[11px] font-normal opacity-70">核對整單出餐</span>
                </button>
              </div>
              {/*
                掃碼點餐模式唔再喺設定頁揀（docs/115 §12）—— 佢跟登入模式走。
                所以呢度要**講清楚會套用咩**，否則商家登入完去設定頁見到 QR 變咗會一頭霧水。
              */}
              <div className="mt-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs leading-relaxed text-white/55">
                <span className="font-semibold text-orange-200/90">掃碼點餐：</span>
                {scanOrderHint[mode]}
              </div>
            </div>

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

          <div className="mt-4 text-center text-xs text-white/40">使用會員通商戶帳號登入（與 Ledger Web / Android 相同）</div>
        </div>
      </div>
    </div>
  );
}
