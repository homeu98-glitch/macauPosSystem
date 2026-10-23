"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { AdminChangePinModal } from "@/components/admin-change-pin-modal";
import { clearAuthSession, loadAuthSession } from "@/lib/storage";
import { decodeAdminSessionToken, isAdminSessionTokenExpired } from "@/lib/admin-session-token-client";

/**
 * Admin panel 外殼。
 *
 * - 頂部導航：按 **scope** 過濾（平台級睇全部；店舖級只睇自己店嘅頁面）
 * - 認證門：mount 後檢查 adminSessionToken，冇就踢返 /admin 登入頁
 * - 冇列印 / 寫入 UI（寫入由各頁自帶）
 *
 * 【2026-10-21 多店控制台 P1/P2】
 *   - 身份照舊由 token 解碼；但**可見範圍**由 `GET /api/admin/me` 拿
 *     （server 解析 bindings，唔信 client）。
 *   - 店舖級帳號（`scope.all = false`）**唔會見到**平台頁（帳號管理／工作階段／
 *     雲端用量／版本控制）—— 即使手動打 URL，server 一樣 403（雙重保險）。
 *   - `mustChangePin` → 強制彈改 PIN 窗，唔可以關（初始 PIN 等於公開密碼）。
 *
 * ⚠️ 呢個只係 UX 過濾，**唔係授權**。真正授權永遠喺 server（`requireAdmin()`）。
 */

type AdminProfile = {
  ok: boolean;
  account: string;
  role: string;
  mustChangePin: boolean;
  scope: { all: boolean; storeIds: string[] };
  stores: Array<{ id: string; name: string }>;
};

export function AdminShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [authed, setAuthed] = useState(false);
  const [account, setAccount] = useState<string>("");
  const [profile, setProfile] = useState<AdminProfile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [pinModal, setPinModal] = useState<null | "forced" | "manual">(null);

  useEffect(() => {
    const session = loadAuthSession();
    const token = session?.adminSessionToken;
    // 🔴 2026-10-17 修（J 拍板）：admin panel 身份必須以「登入嗰陣輸入嘅 admin 帳號」為準，
    // 唔可以繼承 POS 收銀登入嘅 account。之前 admin 登入做咗 { ...existing, adminSessionToken }，
    // 會保留 POS 收銀嘅 account，令 admin 頂部顯示成收銀戶口，仲以為「用咗之前個戶口入嚟」。
    // 呢度由 token payload 解碼出真正嘅 admin account（token 本身 encode 咗 account + role），
    // 同時驗 expiry：過期／解唔到就彈返登入頁。真正授權仍由 server 端 HMAC 驗簽把關
    //（每個 admin API route 都會再 verify 一次，客戶端解密唔等於放行）。
    const claims = token ? decodeAdminSessionToken(token) : null;
    if (!claims || isAdminSessionTokenExpired(claims)) {
      router.replace("/admin");
      return;
    }
    setAccount(claims.account);
    setAuthed(true);
  }, [router]);

  // 拉 scope / mustChangePin（server 解析；client 唔可以自行推定）
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;

    void (async () => {
      try {
        const token = loadAuthSession()?.adminSessionToken;
        const res = await fetch("/api/admin/me", {
          headers: { Authorization: `Bearer ${token ?? ""}` },
        });
        const json = (await res.json()) as AdminProfile & { error?: string };
        if (cancelled) return;

        if (res.status === 401) {
          clearAuthSession();
          router.replace("/admin");
          return;
        }
        if (!res.ok || !json.ok) {
          setProfileError(json.error ?? `載入身份資料失敗（HTTP ${res.status}）`);
          return;
        }
        setProfile(json);
        if (json.mustChangePin) setPinModal("forced");
      } catch {
        if (!cancelled) setProfileError("網絡錯誤，未能載入身份資料。");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authed, router]);

  const handleLogout = useCallback(() => {
    clearAuthSession();
    router.replace("/admin");
  }, [router]);

  if (!authed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100">
        <p className="text-sm text-slate-500">正在驗證管理員身份…</p>
      </div>
    );
  }

  /** `scope.all === false` 時隱藏 platformOnly 項目（未載入 profile 前先當平台，避免閃爍）。 */
  const isPlatform = profile ? profile.scope.all : true;

  const navItems = [
    { href: "/admin/dashboard", label: "店舖總覽", platformOnly: false },
    { href: "/admin/reports", label: "營業報表", platformOnly: false },
    // 2026-10-23：店主／平台都可見（店主只會見到自己店）。
    { href: "/admin/staff", label: "權限控制", platformOnly: false },
    // P2：帳號管理（平台專屬）
    { href: "/admin/accounts", label: "帳號管理", platformOnly: true },
    { href: "/admin/sessions", label: "POS 工作階段", platformOnly: true },
    { href: "/admin/traffic", label: "雲端用量", platformOnly: true },
    { href: "/admin/versions", label: "版本控制", platformOnly: true },
  ].filter((item) => !item.platformOnly || isPlatform);

  const scopeLabel = profile
    ? profile.scope.all
      ? "全部店舖"
      : `我的店舖 · ${profile.scope.storeIds.length} 間`
    : null;

  return (
    <div className="h-[100dvh] overflow-y-auto bg-slate-100">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-4">
            <span className="shrink-0 text-sm font-bold text-slate-900">Admin 管理後台</span>
            <nav className="flex items-center gap-1 overflow-x-auto">
              {navItems.map((item) => {
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    style={
                      active
                        ? { backgroundColor: "#0f172a", color: "#ffffff", fontWeight: 600 }
                        : undefined
                    }
                    className={`shrink-0 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                      active
                        ? "ring-2 ring-orange-400 ring-offset-1"
                        : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {scopeLabel ? (
              <span className="hidden rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-600 sm:inline">
                {scopeLabel}
              </span>
            ) : null}
            <span className="hidden text-xs text-slate-500 sm:inline">{account}</span>
            <button
              type="button"
              onClick={() => setPinModal("manual")}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition-colors hover:bg-slate-50"
            >
              修改 PIN
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition-colors hover:bg-slate-50"
            >
              登出
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 pb-12 pt-6">
        {profileError ? (
          <p className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            ⚠️ {profileError}（部分頁面可能無法使用，請重新登入或檢查 server log）
          </p>
        ) : null}
        {children}
      </main>

      {pinModal ? (
        <AdminChangePinModal
          forced={pinModal === "forced"}
          onClose={() => setPinModal(null)}
          onChanged={() => {
            setPinModal(null);
            setProfile((prev) => (prev ? { ...prev, mustChangePin: false } : prev));
          }}
        />
      ) : null}
    </div>
  );
}
