"use client";

import { KeyboardEvent, useState } from "react";

import { AppDownloadButton } from "@/components/app-download-button";
import { PwaInstallButton, isRunningInNativeShell } from "@/components/pwa-install-button";
import { getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";
import {
  bindThisDevice,
  clearDeviceSignedOut,
  defaultDeviceLabel,
  loadDeviceBinding,
} from "@/lib/pos/device-binding";
import { saveOperatorSession } from "@/lib/pos/operator-session";
import { applyWorkbenchSelection } from "@/lib/pos/apply-workbench";
import {
  WORKBENCH_IDS,
  findWorkbench,
  type MerchantModuleGrants,
  type WorkbenchId,
} from "@/lib/pos/module-catalog";
import { resolveRememberedWorkbench } from "@/lib/pos/workbench-preference";
import { readClientBuildInfo } from "@/lib/build-info";
import { getPosSessionKey, rotatePosSessionKey } from "@/lib/pos/session-key";
import { POS_BUILD_HEADER, POS_SESSION_HEADER } from "@/lib/pos/session-record";
import { clearPosSessionRevoked } from "@/lib/pos/session-revoked";
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

/** 登入第 2 步嘅身份卡（店主 或 已啟用店員）。 */
type LoginIdentity = {
  kind: "owner" | "staff";
  id: string;
  name: string;
  staffNo?: string;
  role: "owner" | "manager" | "cashier";
};

export function LoginScreen() {
  const [account, setAccount] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // 原生殼（Android APK / PC Electron）入面唔使顯示 PWA 安裝入口
  const [isNativeShell] = useState<boolean>(() => isRunningInNativeShell());

  /**
   * 三步登入（2026-10-23，docs/160 §11）：
   *
   *   ① 輸入 8 位店舖帳號
   *   ② 顯示呢個帳號可用嘅身份（店主 ＋ 已設定店員）
   *   ③ 揀好身份 → 打 PIN → 登入
   *
   * 為何要咁做：舊流程店員一定要「店主先登入 → /operator 簽到」，
   * 等於店員要知店主帳密。新流程店員自己揀自己、打自己 PIN 就入得。
   */
  const [step, setStep] = useState<"account" | "identity" | "pin">("account");
  const [identities, setIdentities] = useState<LoginIdentity[]>([]);
  const [selected, setSelected] = useState<LoginIdentity | null>(null);
  const [storeName, setStoreName] = useState("");
  const [checking, setChecking] = useState(false);
  /**
   * 身份清單嘅「診斷狀態」。
   *
   * 🔴 為何要存：`known:false`（店主未登入過）、`staffTotal === 0`（未加店員）、
   * `staffActive === 0`（店員全停用）三種情況喺畫面上**長得一模一樣**——
   * 都係得「店主 · 切換」一張卡，用家只會覺得「壞咗」。
   * 所以 server 回呢幾個數，UI 直接講出原因。
   */
  const [known, setKnown] = useState<boolean | null>(null);
  const [staffTotal, setStaffTotal] = useState(0);
  const [staffActive, setStaffActive] = useState(0);
  const [staffTableMissing, setStaffTableMissing] = useState(false);

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

  /** 第 1 步 → 查身份。查唔到（新店／未跑 0074）就直接跳去 PIN（傳統店主登入）。 */
  async function goToIdentity() {
    setError("");
    const normalizedAccount = account.replace(/\D/g, "").slice(0, 8);
    if (!/^\d{8}$/.test(normalizedAccount)) {
      setError("請輸入 8 位數字帳號。");
      return;
    }

    setChecking(true);
    try {
      const response = await fetch("/api/pos/login/identities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: normalizedAccount }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        known?: boolean;
        storeName?: string;
        identities?: LoginIdentity[];
        staffTotal?: number;
        staffActive?: number;
        staffTableMissing?: boolean;
      };
      if (!response.ok || !payload.ok) {
        setError(payload.error ?? "讀取身份失敗，請再試一次。");
        return;
      }

      const list = payload.identities ?? [];
      setStoreName(payload.storeName ?? "");
      setIdentities(list);
      setKnown(payload.known === true);
      setStaffTotal(Number(payload.staffTotal ?? 0));
      setStaffActive(Number(payload.staffActive ?? 0));
      setStaffTableMissing(payload.staffTableMissing === true);

      // 未有任何店主登入過（known:false）或得一個身份 → 唔需要揀，直接打 PIN
      if (!payload.known || list.length <= 1) {
        setSelected(list[0] ?? { kind: "owner", id: "owner", name: "店主", role: "owner" });
        setStep("pin");
        return;
      }
      setStep("identity");
    } catch {
      setError("網絡錯誤，請稍後再試。");
    } finally {
      setChecking(false);
    }
  }

  function chooseIdentity(identity: LoginIdentity) {
    setSelected(identity);
    setPin("");
    setError("");
    setStep("pin");
  }

  function backFromPin() {
    setPin("");
    setError("");
    setStep(identities.length > 1 ? "identity" : "account");
  }

  function backToAccount() {
    setPin("");
    setError("");
    setSelected(null);
    setStep("account");
  }

  /**
   * 「點解得店主一個身份？」——直接講原因。
   *
   * 冇呢段，三種完全唔同嘅成因（店主未登入過 / 未加店員 / 店員全停用）
   * 喺畫面上都係一模一樣嘅「店主 · 切換」，用家只會覺得個掣壞咗。
   */
  function identityHint(): string | null {
    if (identities.length > 1) return null;
    if (known === false) {
      return "呢間店第一次用：店主用自己帳號登入一次之後，店員就會出現喺呢個清單。";
    }
    if (staffTableMissing) {
      return "店員表未建立（migration 0072 未跑），所以暫時淨係得店主可以登入。";
    }
    if (staffTotal === 0) {
      return "呢間店仲未加入店員。去「設定 → 員工權限」加咗店員，佢哋就會出現喺呢個清單。";
    }
    if (staffActive === 0) {
      return "店員全部已停用，所以暫時淨係得店主可以登入。";
    }
    return null;
  }

  function submitPin() {
    if (!selected) return;
    if (selected.kind === "owner") {
      void loginAsOwner();
      return;
    }
    void loginAsStaff();
  }

  async function loginAsOwner() {
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
      // ── 工作階段身分（2026-09-22，migration 0047）────────────────────────
      //
      // ① **先換一個新識別碼**：管理員強制關閉之後，商家要重新登入；
      //    如果沿用舊 key，新登入會續期**嗰行已經被撤銷**嘅紀錄 ⇒ admin 頁顯示
      //    「已強制關閉」但商戶明明用緊（或者橫幅一登入就再彈）。
      //    ⇒「重新登入 ＝ 新工作階段」，舊 row 留低做歷史。
      //    （登入失敗都已經換咗 key：最多留一行冇再更新嘅紀錄，30 日後可清除。）
      // ② 清咗「已被關閉」旗標（否則橫幅唔會消失）。
      // ③ 帶住新 key + 內聯版本號去註冊（server 端唯一知道 merchantId 嘅地方）。
      rotatePosSessionKey();
      clearPosSessionRevoked();
      const loginHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        [POS_SESSION_HEADER]: getPosSessionKey(),
      };
      const clientBuildId = readClientBuildInfo().id;
      if (clientBuildId) loginHeaders[POS_BUILD_HEADER] = clientBuildId;

      const response = await fetch("/api/ledger/login", {
        method: "POST",
        headers: loginHeaders,
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
      // 店主／店員成功登入 ⇒ 清走「已登出」標記，之後 reload 可以再自動開機
      clearDeviceSignedOut();

      // 統一行為：saveAuthSession 已經自動 dispatch `pos-auth-changed`。
      // 任何 React component 訂閱呢個事件都會自動 reset + 重 backfill。
      // （bootstrap 對齊 / Supabase setSession / 工作台跳轉一律喺 finishLogin 做，
      //   店主同店員兩條路徑共用，避免兩份漂移。）

      // 自動初始化呢部機（docs/160 §11）：店主登入一次之後，店員就可以喺
      // 登入頁揀自己嘅身份 + PIN 開機，唔需要再經店主。
      // 🔴 失敗唔可以阻登入（可能 0073 未跑）—— 只 log，下次登入再試。
      if (session.merchantId) {
        const init = await bindThisDevice({
          storeId: session.merchantId,
          label: defaultDeviceLabel(),
          ledgerAccessToken: session.ledgerAccessToken,
          ledgerRefreshToken: session.ledgerRefreshToken,
        });
        if (!init.ok) console.warn("[login] 裝置自動初始化未完成:", init.error);
      }

      await finishLogin(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登入失敗");
    } finally {
      setLoading(false);
    }
  }

  /**
   * 店員登入（docs/160 §11）。
   *
   * 店員冇 Ledger 戶口，但會員／加值／報表要 Ledger token ⇒ 由 server 用
   * 「呢部機已初始化」嘅憑證代為換一對新 token（`/api/pos/login/identity`）。
   *
   * 🔴 未初始化就明確叫店主先登入一次，唔可以靜靜降級 ——
   *    否則店員開到機但冇會員／冇報表，更難查。
   */
  async function loginAsStaff() {
    if (!selected || selected.kind !== "staff") return;
    setError("");

    const normalizedAccount = account.replace(/\D/g, "").slice(0, 8);
    const normalizedPin = pin.replace(/\D/g, "").slice(0, 4);
    if (!/^\d{4}$/.test(normalizedPin)) {
      setError("請輸入 4 位 PIN。");
      return;
    }

    const binding = loadDeviceBinding();
    if (!binding) {
      // 呢部機從未由店主登入過（或 storage 被清）⇒ 冇憑證可以換 Ledger token
      setError("呢部機未初始化，請店主先登入一次。");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/pos/login/identity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: normalizedAccount,
          staffNo: selected.staffNo,
          pin: normalizedPin,
          deviceId: binding.deviceId,
          deviceSecret: binding.secret,
        }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        session?: AuthSession;
        token?: string;
        expiresAt?: string;
        operator?: {
          staffId: string;
          staffNo: string;
          name: string;
          role: "manager" | "cashier";
          permissions: Parameters<typeof saveOperatorSession>[0]["permissions"];
        };
      };

      if (!response.ok || !payload.ok || !payload.session || !payload.operator || !payload.token) {
        setError(payload.error ?? "登入失敗，請再試一次。");
        return;
      }

      const session = payload.session;
      saveAuthSession(session);
      clearDeviceSignedOut();

      saveOperatorSession({
        storeId: session.merchantId ?? "",
        staffId: payload.operator.staffId,
        staffNo: payload.operator.staffNo,
        name: payload.operator.name,
        role: payload.operator.role,
        permissions: payload.operator.permissions,
        token: payload.token,
        signedInAt: new Date().toISOString(),
        expiresAt: payload.expiresAt ?? "",
      });

      await finishLogin(session);
    } catch {
      setError("網絡錯誤，請稍後再試。");
    } finally {
      setLoading(false);
    }
  }

  /** 登入成功後共通落地：bootstrap 對齊 → Supabase session → 工作台。 */
  async function finishLogin(session: AuthSession) {
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

    // 未揀過 / 冇記住 → 入**統一入口**（`/`＝工作台選擇頁）。
    //
    // ⚠️ 2026-09-17：由 `/select-workbench` 改為 `/`。
    //    兩者 render 同一個元件，但 `/` 先係對外嘅唯一入口 ——
    //    書籤、文件、PWA start_url 一律用 `/`，避免商家要記兩條路徑。
    //    （`/select-workbench` 保留為相容別名＋落單專用終端嘅逃生門。）
    window.location.replace("/");
  }

  function handleEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (step === "account") {
      void goToIdentity();
      return;
    }
    if (step === "pin") submitPin();
  }

  const pinHint = identityHint();

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
            <div className="mt-2 text-sm text-white/70">
              輸入店舖帳號，再揀你嘅身份登入。
            </div>
          </div>

          {step === "account" ? (
            <div className="mt-6 grid gap-3">
              <label className="grid gap-1">
                <span className="text-xs font-semibold text-white/70">帳號（8 位數字）</span>
                <input
                  className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-base text-white outline-none ring-orange-500/40 placeholder:text-white/30 focus:ring-2"
                  inputMode="numeric"
                  maxLength={8}
                  onKeyDown={handleEnter}
                  onChange={(event) => {
                    setError("");
                    setAccount(event.target.value.replace(/\D/g, "").slice(0, 8));
                  }}
                  placeholder="店舖電話"
                  value={account}
                />
              </label>
              <div className="text-xs leading-relaxed text-white/45">
                下一步會顯示呢個帳號可以用嘅身份（店主／店員）。
              </div>
            </div>
          ) : null}

          {step === "identity" ? (
            <div className="mt-6 grid gap-2">
              <div className="text-xs text-white/60">
                {storeName ? `${storeName} · ` : ""}揀你要用嘅身份
              </div>
              {identities.map((identity) => (
                <button
                  className="flex min-h-[56px] w-full items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-left hover:border-orange-400/60 hover:bg-white/10"
                  key={identity.id}
                  onClick={() => chooseIdentity(identity)}
                  type="button"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-white">
                      {identity.name}
                    </span>
                    <span className="mt-0.5 block text-xs text-white/50">
                      {identity.kind === "owner"
                        ? "店主 · Ledger 帳號"
                        : `工號 ${identity.staffNo} · ${identity.role === "manager" ? "店長" : "收銀員"}`}
                    </span>
                  </span>
                  <span className="shrink-0 text-lg text-white/30">›</span>
                </button>
              ))}
              <button
                className="mt-1 min-h-[44px] text-xs text-white/50 hover:text-white/80"
                onClick={backToAccount}
                type="button"
              >
                返回，改帳號
              </button>
            </div>
          ) : null}

          {step === "pin" ? (
            <div className="mt-6 grid gap-3">
              <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-white">
                    {selected?.name ?? "店主"}
                  </div>
                  <div className="mt-0.5 text-xs text-white/50">
                    {selected?.kind === "owner"
                      ? "店主 · Ledger PIN"
                      : `工號 ${selected?.staffNo} · ${selected?.role === "manager" ? "店長" : "收銀員"}`}
                  </div>
                </div>
                <button
                  className="shrink-0 rounded-full border border-white/15 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10"
                  onClick={backFromPin}
                  type="button"
                >
                  {identities.length > 1 ? "切換" : "改帳號"}
                </button>
              </div>

              {pinHint ? (
                <div className="rounded-2xl border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-xs leading-relaxed text-amber-100">
                  {pinHint}
                </div>
              ) : null}

              <label className="grid gap-1">
                <span className="text-xs font-semibold text-white/70">PIN（4 位數字）</span>
                <input
                  autoFocus
                  className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-base text-white outline-none ring-orange-500/40 placeholder:text-white/30 focus:ring-2"
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
          ) : null}

          {error ? (
            <div className="mt-4 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-100">
              {error}
            </div>
          ) : null}

          {step === "account" ? (
            <button
              className="mt-5 w-full rounded-2xl bg-orange-500 px-4 py-3 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-60"
              disabled={checking}
              onClick={() => void goToIdentity()}
              type="button"
            >
              {checking ? "查詢中…" : "下一步"}
            </button>
          ) : (
            <button
              className="mt-5 w-full rounded-2xl bg-orange-500 px-4 py-3 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-60"
              disabled={loading}
              onClick={submitPin}
              type="button"
            >
              {loading ? "正在登入…" : "登入"}
            </button>
          )}

          {/*
            下載入口（2026-09-23）——裝置偵測決定文案：
              Android ⇒「下載 APK」；其他 ⇒「下載安裝包」。
            連去 admin「版本控制」頁目前設為 active 嘅版本。
            ⚠️ 元件自己判斷「原生殼內唔顯示」同「拎唔到版本就唔顯示」，
               所以呢度**唔需要**再加條件；亦唔可以喺呢度包一層 `isNativeShell`
               判斷 —— 邏輯收喺元件內只有一份，唔會兩邊走樣。
          */}
          <AppDownloadButton />

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
