"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  clearDeviceBinding,
  clearDeviceSignedOut,
  defaultDeviceLabel,
  loadDeviceBinding,
  loadOrCreateDeviceId,
  saveBindingFromLogin,
} from "@/lib/pos/device-binding";
import {
  describeIdentity,
  describeIdentityGap,
  fetchLoginIdentities,
  staffNoFromAccount,
  storeAccountOf,
  type LoginIdentity,
} from "@/lib/pos/login-identities";
import { findWorkbench, WORKBENCH_IDS, type WorkbenchId } from "@/lib/pos/module-catalog";
import {
  clearOperatorSession,
  loadOperatorSession,
  saveOperatorSession,
  type OperatorSession,
} from "@/lib/pos/operator-session";
import { markTerminalUnlocked } from "@/lib/pos/terminal-lock";
import { resolveRememberedWorkbench } from "@/lib/pos/workbench-preference";
import { loadAuthSession, saveAuthSession, type AuthSession } from "@/lib/storage";

/**
 * 換人（L1／L2 切換）—— **角色清單 → PIN**。
 *
 * ## 呢一頁嘅歷史（2026-10-23 第二次改版）
 *
 * 第一版係「而家嘅操作員」＋ 一個「切換操作員」掣，撳完只會出一個**自由輸入**嘅
 * 工號輸入框。實際用落係死路：
 *
 * - 店員切換過去之後，**冇任何方法返去店主**（工號框填咩都只會查到店員）；
 * - 用家根本唔記得自己嘅工號，要人肉打；
 * - 「而家嘅操作員」呢張卡對換人零幫助 —— 佢只係講「你係邊個」。
 *
 * 第二版（而家）：直接列**呢間店所有身份**（店主 ＋ 已啟用店員），
 * 現任嘅高亮，揀邊個就跳去邊個嘅 PIN。店主同店員走**同一條路**，
 * 唔會再有「一邊返唔到另一邊」。
 *
 * ## 🔴 店主揀完之後點解真係返得去
 *
 * 店主**唔係** `pos_staff` 入面嘅一員（冇工號、冇 PIN hash），所以唔可以行
 * `/api/pos/login/identity`。佢一定要行 `/api/ledger/login`（Ledger 驗身），
 * 成功之後要**清走 L2 操作員 session** —— 唔清走嘅話 `operatorVisiblePages()`
 * 會繼續用上一個店員嘅白名單限制店主嘅側欄。
 *
 * ## 兩種憑證
 *
 * | 情況 | 身份清單 | 店員登入 | 店主登入 |
 * |---|---|---|---|
 * | 部機已初始化（有 device binding） | `{deviceId, deviceSecret}` | `/api/pos/login/identity` | `/api/ledger/login` ＋ secret |
 * | 未初始化但仲有 L1 session | `{account}`（要 8 位帳號） | `/api/pos/staff/login`（舊路徑） | `/api/ledger/login` ＋ 帳號 |
 *
 * 未初始化又冇 8 位帳號（例如 session 係 `staff:01`）⇒ 列唔到身份，
 * 只能引導去 `/login`。呢個係唯一嘅真死路，所以要明確講出原因。
 */

type Phase = "loading" | "blocked" | "roles" | "pin";

export function OperatorSignInScreen() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [session, setSession] = useState<AuthSession | null>(null);
  const [storeId, setStoreId] = useState("");
  const [storeName, setStoreName] = useState("");
  const [identities, setIdentities] = useState<LoginIdentity[]>([]);
  const [current, setCurrent] = useState<OperatorSession | null>(null);
  const [gap, setGap] = useState<string | null>(null);
  const [blockedReason, setBlockedReason] = useState("");

  const [selected, setSelected] = useState<LoginIdentity | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** 重試用：撳「再試一次」遞增，令 effect 重跑。 */
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const stored = loadAuthSession();
      const binding = loadDeviceBinding();
      const account = storeAccountOf(stored?.account);

      if (!binding && !account) {
        // 連「呢部機屬邊間店」都講唔出 —— 列唔到身份，唯一出路係完整登入
        if (cancelled) return;
        setSession(stored);
        setBlockedReason(
          stored?.merchantId
            ? "呢部機未完成店主授權，暫時列唔到店員名單。請店主用 8 位店舖帳號登入一次。"
            : "呢部機未完成店舖登入（Ledger 帳號），所以未知道屬於邊間店。",
        );
        setPhase("blocked");
        return;
      }

      const result = binding
        ? await fetchLoginIdentities({
            deviceId: binding.deviceId,
            deviceSecret: binding.secret,
          })
        : await fetchLoginIdentities({ account });

      if (cancelled) return;

      if (!result.ok) {
        // 憑證已被撤銷／表未升級 ⇒ 清走本機票，唔好留住一張永遠失敗嘅票。
        // 網絡問題就保留（下次開頁會再試）。
        if (binding && (result.status === 401 || result.tableMissing)) {
          clearDeviceBinding();
        }
        setSession(stored);
        setBlockedReason(result.error);
        setPhase("blocked");
        return;
      }

      const payload = result.payload;
      const resolvedStoreId = payload.storeId || stored?.merchantId || "";
      setSession(stored);
      setStoreId(resolvedStoreId);
      setStoreName(payload.storeName ?? "");
      setIdentities(payload.identities ?? []);
      setGap(describeIdentityGap(payload));
      setCurrent(loadOperatorSession(resolvedStoreId));
      setPhase("roles");
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  /**
   * 而家邊個身份。
   *
   * 三個來源（唔可以只靠一個）：
   *   ① L2 操作員 session → `staffId`（最準）
   *   ② L1 session `role === "admin"` → 店主
   *   ③ 舊資料：L1 session `account === "staff:01"` → 對返工號
   * 冇 ① 又冇 ② ③ 就係「未知」，唔高亮任何一個（唔好亂指）。
   */
  const activeId = useMemo(() => {
    if (current) return current.staffId;
    if (session?.role === "admin") return "owner";
    const staffNo = staffNoFromAccount(session?.account);
    if (!staffNo) return "";
    return identities.find((item) => item.kind === "staff" && item.staffNo === staffNo)?.id ?? "";
  }, [current, identities, session]);

  /** 揀完身份 → 直接入 PIN（用家明確要求：唔好再加一層確認）。 */
  function choose(identity: LoginIdentity) {
    setSelected(identity);
    setPin("");
    setError("");
    setPhase("pin");
  }

  function backToRoles() {
    setSelected(null);
    setPin("");
    setError("");
    setPhase("roles");
  }

  /** 登入成功後共通落地：一律整頁跳轉（同登入頁一致，避免殘留舊操作員 state）。 */
  const land = useCallback(async (next: AuthSession) => {
    const granted: WorkbenchId[] = next.allowedModules?.workbenches ?? [...WORKBENCH_IDS];
    const remembered = resolveRememberedWorkbench(next.merchantId, granted);
    const home = remembered ? (findWorkbench(remembered)?.homePath ?? "/pos") : "/pos";
    window.location.replace(home);
  }, []);

  async function submit() {
    if (!selected) return;
    const cleanPin = pin.replace(/\D/g, "").slice(0, 4);
    if (!/^\d{4}$/.test(cleanPin)) {
      setError("請輸入 4 位 PIN。");
      return;
    }

    setError("");
    setBusy(true);
    try {
      if (selected.kind === "owner") {
        await signInAsOwner(cleanPin);
      } else {
        await signInAsStaff(selected, cleanPin);
      }
    } finally {
      setBusy(false);
    }
  }

  /** 店主：行 Ledger 驗身，成功即清走 L2 操作員 session（否則側欄仲係店員白名單）。 */
  async function signInAsOwner(cleanPin: string) {
    const binding = loadDeviceBinding();
    const account = storeAccountOf(session?.account);
    if (!binding && !account) {
      setError("呢部機未完成店主授權，請用 8 位店舖帳號登入一次。");
      return;
    }

    try {
      const response = await fetch("/api/ledger/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // 有裝置憑證就唔使打帳號（server 反查）；冇就要用返 L1 session 嗰個
          account: binding ? undefined : account,
          pin: cleanPin,
          deviceId: loadOrCreateDeviceId(),
          deviceLabel: defaultDeviceLabel(),
          deviceSecret: binding?.secret,
        }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        code?: string;
        session?: AuthSession & { ledgerAccessToken?: string; ledgerRefreshToken?: string };
        accessToken?: string;
        refreshToken?: string;
        deviceBinding?: { deviceId: string; secret: string };
      };

      if (!response.ok || !payload.ok || !payload.session) {
        // 憑證壞咗（撤銷／0075 未跑）⇒ 唔好淨係出紅字然後困住用家，
        // 直接講清楚下一步去邊。
        if (payload.code === "device_not_ready" || payload.code === "table_missing") {
          clearDeviceBinding();
          setBlockedReason(
            "呢部機嘅店主授權已失效（可能係 migration 0075 未跑，或者授權被撤銷）。請店主用 8 位店舖帳號登入一次。",
          );
          setPhase("blocked");
          return;
        }
        setError(payload.error ?? "登入失敗，請再試一次。");
        return;
      }

      const next: AuthSession = {
        ...payload.session,
        loggedInAt: new Date().toISOString(),
        ledgerAccessToken: payload.session.ledgerAccessToken ?? payload.accessToken,
        ledgerRefreshToken: payload.session.ledgerRefreshToken ?? payload.refreshToken,
      };

      // ① 先清 L2（店主＝全部權限，唔應該再受上一個店員嘅白名單限制）
      clearOperatorSession(next.merchantId || storeId);
      // ② 再寫 L1 session（會 dispatch `pos-auth-changed`，所以 L2 一定要先寫好）
      saveAuthSession(next);
      clearDeviceSignedOut();
      markTerminalUnlocked();

      if (payload.deviceBinding && next.merchantId) {
        saveBindingFromLogin({
          storeId: next.merchantId,
          deviceId: payload.deviceBinding.deviceId,
          secret: payload.deviceBinding.secret,
          label: defaultDeviceLabel(),
        });
      }

      await land(next);
    } catch {
      setError("網絡錯誤，請稍後再試。");
    }
  }

  /** 店員：有裝置憑證就用 v2 route（連 Ledger session 一齊換），否則退回舊路徑。 */
  async function signInAsStaff(identity: LoginIdentity, cleanPin: string) {
    const binding = loadDeviceBinding();

    try {
      if (binding) {
        const response = await fetch("/api/pos/login/identity", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            staffNo: identity.staffNo,
            pin: cleanPin,
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
            permissions: OperatorSession["permissions"];
          };
        };

        if (!response.ok || !payload.ok || !payload.session || !payload.operator || !payload.token) {
          setError(payload.error ?? "簽到失敗，請再試一次。");
          return;
        }

        // 🔴 L2 先寫：`saveAuthSession()` 會 dispatch `pos-auth-changed`，
        //    AuthGuard 收到可能即刻 reload；L2 遲一步寫就等於冇簽到。
        saveOperatorSession({
          storeId: payload.session.merchantId ?? storeId,
          staffId: payload.operator.staffId,
          staffNo: payload.operator.staffNo,
          name: payload.operator.name,
          role: payload.operator.role,
          permissions: payload.operator.permissions,
          token: payload.token,
          signedInAt: new Date().toISOString(),
          expiresAt: payload.expiresAt ?? "",
        });
        saveAuthSession(payload.session);
        clearDeviceSignedOut();
        markTerminalUnlocked();
        await land(payload.session);
        return;
      }

      // ── 舊路徑：未初始化嘅機（0075 未跑）仍然要店主先登入 ──────────────
      if (!session?.merchantId) {
        setError("呢部機未完成店舖登入，請店主先登入一次。");
        return;
      }
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (session.posDeviceToken) headers.Authorization = `Bearer ${session.posDeviceToken}`;

      const response = await fetch("/api/pos/staff/login", {
        method: "POST",
        headers,
        body: JSON.stringify({
          storeId: session.merchantId,
          staffNo: identity.staffNo,
          pin: cleanPin,
        }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        token?: string;
        expiresAt?: string;
        tableReady?: boolean;
        operator?: {
          staffId: string;
          staffNo: string;
          name: string;
          role: "manager" | "cashier";
          permissions: OperatorSession["permissions"];
        };
      };

      if (!response.ok || !payload.ok || !payload.token || !payload.operator) {
        setError(
          payload.tableReady === false
            ? "店員權限表未建立：請店長先喺「設置 › 權限控制」完成設定。"
            : (payload.error ?? "簽到失敗，請再試一次。"),
        );
        return;
      }

      saveOperatorSession({
        storeId: session.merchantId,
        staffId: payload.operator.staffId,
        staffNo: payload.operator.staffNo,
        name: payload.operator.name,
        role: payload.operator.role,
        permissions: payload.operator.permissions,
        token: payload.token,
        signedInAt: new Date().toISOString(),
        expiresAt: payload.expiresAt ?? "",
      });
      markTerminalUnlocked();
      await land(session);
    } catch {
      setError("網絡錯誤，請稍後再試。");
    }
  }

  if (phase === "loading") {
    return (
      <Shell title="換人" subtitle="正在讀取呢間店嘅身份…">
        <div className="text-sm text-slate-500">載入中…</div>
      </Shell>
    );
  }

  if (phase === "blocked") {
    return (
      <Shell title="換人" subtitle="需要先完成店舖登入。">
        <div className="rounded-2xl bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-900">
          {blockedReason}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            className="inline-flex min-h-[44px] items-center rounded-full bg-orange-500 px-5 text-sm font-semibold text-white"
            href="/login"
          >
            去登入
          </Link>
          <button
            className="min-h-[44px] rounded-full bg-slate-100 px-5 text-sm font-semibold text-slate-700"
            onClick={() => {
              setBlockedReason("");
              setPhase("loading");
              setReloadKey((value) => value + 1);
            }}
            type="button"
          >
            再試一次
          </button>
        </div>
      </Shell>
    );
  }

  if (phase === "pin" && selected) {
    return (
      <Shell
        title="輸入 PIN"
        subtitle={
          selected.kind === "owner"
            ? "店主 PIN（Ledger 4 位數字）。"
            : `工號 ${selected.staffNo ?? "—"} 嘅員工 PIN（4 位數字）。`
        }
      >
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="min-w-0">
            <div className="text-base font-semibold text-slate-900">{selected.name}</div>
            <div className="mt-0.5 text-xs text-slate-500">{describeIdentity(selected)}</div>
          </div>
          <button
            className="shrink-0 rounded-full border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600"
            onClick={backToRoles}
            type="button"
          >
            換第二個
          </button>
        </div>

        <label className="mt-4 grid gap-1">
          <span className="text-sm font-medium text-slate-700">PIN（4 位數字）</span>
          <input
            autoComplete="off"
            autoFocus
            className="min-h-[52px] w-full max-w-[220px] rounded-2xl border border-slate-200 bg-white px-4 text-lg tracking-[0.5em] text-slate-900 outline-none focus:border-orange-400"
            inputMode="numeric"
            maxLength={4}
            onChange={(event) => {
              setError("");
              setPin(event.target.value.replace(/\D/g, "").slice(0, 4));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
            placeholder="••••"
            type="password"
            value={pin}
          />
        </label>

        {error ? (
          <div className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            className="min-h-[48px] rounded-full bg-orange-500 px-6 text-white disabled:opacity-60"
            disabled={busy}
            onClick={() => void submit()}
            type="button"
          >
            <span className="text-sm font-semibold">{busy ? "登入中…" : "登入"}</span>
          </button>
          <button
            className="min-h-[48px] rounded-full bg-slate-100 px-5 text-sm font-semibold text-slate-700"
            onClick={backToRoles}
            type="button"
          >
            返回
          </button>
        </div>
      </Shell>
    );
  }

  // ── 角色清單（預設畫面）─────────────────────────────────────────────────
  return (
    <Shell
      title="換人"
      subtitle={
        storeName
          ? `${storeName} —— 揀你要用嘅身份，再打自己嘅 PIN。`
          : "揀你要用嘅身份，再打自己嘅 PIN。"
      }
    >
      <div className="grid gap-2">
        {identities.map((identity) => {
          const isActive = identity.id === activeId;
          return (
            <button
              className={[
                "flex min-h-[60px] w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left transition",
                isActive
                  ? "border-orange-400 bg-orange-50 ring-2 ring-orange-200"
                  : "border-slate-200 bg-white hover:border-orange-300 hover:bg-orange-50/40",
              ].join(" ")}
              key={identity.id}
              onClick={() => choose(identity)}
              type="button"
            >
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-semibold text-slate-900">{identity.name}</span>
                  {isActive ? (
                    <span className="rounded-full bg-orange-500 px-2 py-0.5 text-[11px] font-semibold text-white">
                      而家
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  {describeIdentity(identity)}
                </span>
              </span>
              <span className="shrink-0 text-lg text-slate-300">›</span>
            </button>
          );
        })}
      </div>

      {gap ? (
        <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
          {gap}
        </div>
      ) : null}

      {current ? (
        // 舊版成張卡講權限明細；換人用唔着，但「簽到有效到幾點」係收銀員真係會問嘅
        <div className="mt-3 text-xs text-slate-500">
          而家：{current.name}（工號 {current.staffNo}）· 簽到有效至{" "}
          {current.expiresAt
            ? new Intl.DateTimeFormat("zh-HK", {
                timeZone: "Asia/Macau",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              }).format(new Date(current.expiresAt))
            : "—"}
        </div>
      ) : null}

      {error ? (
        <div className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-2">
        <Link
          className="inline-flex min-h-[44px] items-center rounded-full bg-slate-100 px-5 text-sm font-semibold text-slate-700"
          href="/pos"
        >
          返回收銀台
        </Link>
        <button
          className="min-h-[44px] rounded-full px-4 text-sm font-semibold text-slate-500 hover:text-slate-800"
          onClick={() => {
            setPhase("loading");
            setReloadKey((value) => value + 1);
          }}
          type="button"
        >
          重新整理
        </button>
      </div>

      <p className="mt-4 text-xs leading-relaxed text-slate-500">
        換人唔需要登出店舖帳號，亦唔會影響未同步嘅訂單。
        唔記得 PIN／名單冇你？請店長喺「設置 › 權限控制」重設。
      </p>
    </Shell>
  );
}

function Shell(props: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-slate-100 px-4 py-8">
      <div className="mx-auto w-full max-w-md">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xl font-semibold text-slate-900">{props.title}</div>
          <div className="mt-1 text-sm leading-relaxed text-slate-500">{props.subtitle}</div>
          <div className="mt-5">{props.children}</div>
        </div>
      </div>
    </div>
  );
}
