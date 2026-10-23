"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { findWorkbench, type WorkbenchId } from "@/lib/pos/module-catalog";
import {
  clearOperatorSession,
  loadOperatorSession,
  saveOperatorSession,
  type OperatorSession,
} from "@/lib/pos/operator-session";
import { POS_STAFF_ACTION_IDS, POS_STAFF_ACTION_LABELS, POS_STAFF_PAGE_IDS, POS_STAFF_PAGE_LABELS, POS_STAFF_ROLE_LABELS } from "@/lib/pos/staff-core";
import { resolveRememberedWorkbench } from "@/lib/pos/workbench-preference";
import { loadAuthSession } from "@/lib/storage";

/**
 * 店員簽到（L2）—— 工號 + PIN。
 *
 * ## 為何需要呢一頁
 *
 * 商家實況：**員工唔一定個個有 Ledger 戶口**。L1（Ledger 8 位電話 + PIN）
 * 只係開機嗰個人做；之後換班嘅店員用「工號 + PIN」簽到即可。
 *
 * ## 分層（唔可以搞亂）
 *
 * ```
 * L1 裝置登入（Ledger）  → 呢部機屬於邊間店 ＋ ledger token（member/online 功能靠佢）
 * L2 店員簽到（本頁）    → 而家係邊個店員、可做咩（POS 本地，Ledger 零改動）
 * ```
 *
 * ⚠️ 冇 L1 session 就唔可以簽到：我哋需要 `storeId` 才知查邊間店嘅店員。
 */

type LoadState = "loading" | "ready" | "no-session";

export function OperatorSignInScreen() {
  const [state, setState] = useState<LoadState>("loading");
  const [storeId, setStoreId] = useState("");
  const [deviceToken, setDeviceToken] = useState<string | null>(null);
  const [current, setCurrent] = useState<OperatorSession | null>(null);
  const [switching, setSwitching] = useState(false);

  const [staffNo, setStaffNo] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const session = loadAuthSession();
    if (!session?.merchantId) {
      setState("no-session");
      return;
    }
    setStoreId(session.merchantId);
    setDeviceToken(session.posDeviceToken ?? null);
    setCurrent(loadOperatorSession(session.merchantId));
    setState("ready");
  }, []);

  const submit = useCallback(async () => {
    setError("");
    const cleanNo = staffNo.trim().replace(/\s+/g, "");
    const cleanPin = pin.replace(/\D/g, "").slice(0, 4);

    if (!cleanNo) {
      setError("請輸入工號。");
      return;
    }
    if (!/^\d{4}$/.test(cleanPin)) {
      setError("請輸入 4 位 PIN。");
      return;
    }

    setBusy(true);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (deviceToken) headers.Authorization = `Bearer ${deviceToken}`;

      const response = await fetch("/api/pos/staff/login", {
        method: "POST",
        headers,
        body: JSON.stringify({ storeId, staffNo: cleanNo, pin: cleanPin }),
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
        storeId,
        staffId: payload.operator.staffId,
        staffNo: payload.operator.staffNo,
        name: payload.operator.name,
        role: payload.operator.role,
        permissions: payload.operator.permissions,
        token: payload.token,
        signedInAt: new Date().toISOString(),
        expiresAt: payload.expiresAt ?? "",
      });

      const granted: WorkbenchId[] = loadAuthSession()?.allowedModules?.workbenches ?? [];
      const remembered = resolveRememberedWorkbench(storeId, granted);
      const home = remembered ? (findWorkbench(remembered)?.homePath ?? "/pos") : "/pos";
      // 整頁跳轉：同登入一樣，確保 React state（訂單／設定）唔會殘留舊操作員嘅資料
      window.location.replace(home);
    } catch (e) {
      setError(e instanceof Error ? e.message : "網絡錯誤，請稍後再試。");
    } finally {
      setBusy(false);
    }
  }, [deviceToken, pin, staffNo, storeId]);

  function switchOperator() {
    clearOperatorSession(storeId);
    setCurrent(null);
    setSwitching(true);
    setStaffNo("");
    setPin("");
    setError("");
  }

  if (state === "no-session") {
    return (
      <Shell title="店員簽到" subtitle="需要先完成店舖登入。">
        <div className="rounded-2xl bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-900">
          呢部機未完成店舖登入（Ledger 帳號），所以未知道屬於邊間店。
          請先用 8 位帳號＋PIN 登入，再返嚟簽到。
        </div>
        <div className="mt-4">
          <Link
            className="inline-flex min-h-[44px] items-center rounded-full bg-orange-500 px-5 text-sm font-semibold text-white"
            href="/login"
          >
            去登入
          </Link>
        </div>
      </Shell>
    );
  }

  if (state === "loading") {
    return (
      <Shell title="店員簽到" subtitle="載入中…">
        <div className="text-sm text-slate-500">載入中…</div>
      </Shell>
    );
  }

  if (current && !switching) {
    const visiblePages = POS_STAFF_PAGE_IDS.filter((id) => current.permissions.pages[id]);
    const allowedActions = POS_STAFF_ACTION_IDS.filter((id) => current.permissions.actions[id]);
    return (
      <Shell title="而家嘅操作員" subtitle="換班請先切換操作員，唔需要登出店舖帳號。">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-semibold text-slate-900">{current.name}</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
              工號 {current.staffNo}
            </span>
            <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-semibold text-violet-700">
              {POS_STAFF_ROLE_LABELS[current.role]}
            </span>
          </div>

          <div className="mt-4 grid gap-2 text-sm">
            <div>
              <span className="text-slate-500">可見頁面：</span>
              <span className="text-slate-800">
                {visiblePages.length > 0
                  ? visiblePages.map((id) => POS_STAFF_PAGE_LABELS[id]).join("、")
                  : "（冇）"}
              </span>
            </div>
            <div>
              <span className="text-slate-500">操作權限：</span>
              <span className="text-slate-800">
                {allowedActions.length > 0
                  ? allowedActions.map((id) => POS_STAFF_ACTION_LABELS[id].label).join("、")
                  : "（冇）"}
              </span>
            </div>
            <div className="text-xs text-slate-500">
              簽到有效期至{" "}
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
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className="min-h-[44px] rounded-full bg-slate-900 px-5 text-white"
            onClick={switchOperator}
            type="button"
          >
            <span className="text-sm font-semibold">切換操作員</span>
          </button>
          <Link
            className="inline-flex min-h-[44px] items-center rounded-full bg-slate-100 px-5 text-sm font-semibold text-slate-700"
            href="/pos"
          >
            返回收銀台
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      title="店員簽到"
      subtitle="輸入工號同 4 位 PIN。呢個唔係店舖帳號 —— 係你自己嘅員工 PIN。"
    >
      <label className="grid gap-1">
        <span className="text-sm font-medium text-slate-700">工號</span>
        <input
          autoComplete="off"
          autoFocus
          className="min-h-[52px] rounded-2xl border border-slate-200 bg-white px-4 text-lg text-slate-900 outline-none focus:border-orange-400"
          inputMode="text"
          maxLength={12}
          onChange={(e) => setStaffNo(e.target.value)}
          placeholder="例如 01"
          value={staffNo}
        />
      </label>

      <label className="mt-3 grid gap-1">
        <span className="text-sm font-medium text-slate-700">PIN（4 位數字）</span>
        <input
          autoComplete="off"
          className="min-h-[52px] w-full max-w-[220px] rounded-2xl border border-slate-200 bg-white px-4 text-lg tracking-[0.5em] text-slate-900 outline-none focus:border-orange-400"
          inputMode="numeric"
          maxLength={4}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
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
          <span className="text-sm font-semibold">{busy ? "簽到中…" : "簽到"}</span>
        </button>
        {current ? (
          <button
            className="min-h-[48px] rounded-full bg-slate-100 px-5 text-slate-700"
            onClick={() => setSwitching(false)}
            type="button"
          >
            <span className="text-sm font-semibold">取消</span>
          </button>
        ) : null}
      </div>

      <p className="mt-4 text-xs leading-relaxed text-slate-500">
        冇工號／唔記得 PIN？請店長喺「設置 › 權限控制」新增或重設。
        店舖帳號（8 位電話）仍然可以照舊直接登入收銀台，唔影響現有做法。
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
