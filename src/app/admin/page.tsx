"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { loadAuthSession, saveAuthSession, type AuthSession } from "@/lib/storage";
import { UserPermissions, UserRole } from "@/lib/types";

/**
 * /admin — 管理員登入入口（8 位帳號 + 4 位 PIN）。
 *
 * 登入成功後用 `/api/admin/session` 換一張 12h 短效 token，存入 auth session
 * （localStorage），再跳去 /admin/accounts（帳戶管理主頁）。所有帳戶管理操作都靠呢張 token 授權
 * （見 docs/89 §2）。只有 `manageAccounts` 權限嘅帳號（admin / manager）先攞到 token。
 *
 * 呢度係獨立於 POS 收銀登入嘅管理入口：即使部機未做 POS 收銀登入，都可以用
 * 管理員帳號直接登入後台。
 */

function permsForRole(role: UserRole): UserPermissions {
  if (role === "admin") return { refundOrder: true, voidItem: true, manageAccounts: true };
  if (role === "manager") return { refundOrder: true, voidItem: true, manageAccounts: false };
  return { refundOrder: false, voidItem: false, manageAccounts: false };
}

export default function AdminLoginPage() {
  const router = useRouter();
  const [account, setAccount] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const session = loadAuthSession();
    if (session?.adminSessionToken) {
      router.replace("/admin/accounts");
    }
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, pin }),
      });
      const payload = (await res.json()) as {
        ok?: boolean;
        token?: string;
        account?: string;
        name?: string;
        role?: UserRole;
        error?: string;
      };
      if (!res.ok || !payload.ok || !payload.token) {
        setError(payload.error ?? "登入失敗，請重試。");
        return;
      }
      const role = payload.role ?? "admin";
      const existing = loadAuthSession();
      const next: AuthSession = existing
        ? { ...existing, adminSessionToken: payload.token }
        : {
            account: payload.account ?? account,
            name: payload.name ?? "",
            role,
            permissions: permsForRole(role),
            loggedInAt: new Date().toISOString(),
            adminSessionToken: payload.token,
          };
      saveAuthSession(next);
      router.replace("/admin/accounts");
    } catch {
      setError("網絡錯誤，請重試。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg"
      >
        <h1 className="mb-1 text-xl font-bold text-slate-800">管理員登入</h1>
        <p className="mb-6 text-sm text-slate-500">請輸入 8 位帳號與 4 位 PIN。</p>

        <label className="mb-3 block">
          <span className="mb-1 block text-sm font-medium text-slate-600">帳號</span>
          <input
            inputMode="numeric"
            autoComplete="username"
            maxLength={8}
            value={account}
            onChange={(e) => setAccount(e.target.value.replace(/\D/g, ""))}
            placeholder="8 位帳號"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-800 outline-none focus:border-blue-500"
          />
        </label>

        <label className="mb-4 block">
          <span className="mb-1 block text-sm font-medium text-slate-600">PIN</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            placeholder="4 位 PIN"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-800 outline-none focus:border-blue-500"
          />
        </label>

        {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}

        <button
          type="submit"
          disabled={busy || account.length === 0 || pin.length === 0}
          className="w-full rounded-lg bg-blue-600 py-2.5 font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {busy ? "登入中…" : "登入"}
        </button>
      </form>
    </main>
  );
}
