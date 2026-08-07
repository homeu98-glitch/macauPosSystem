"use client";

import { useRouter } from "next/navigation";
import { KeyboardEvent, useState } from "react";

import { PwaInstallButton } from "@/components/pwa-install-button";
import { saveAuthSession, saveOperatingMode } from "@/lib/storage";

export function LoginScreen() {
  const router = useRouter();
  const [account, setAccount] = useState("");
  const [pin, setPin] = useState("");
  const [mode, setMode] = useState<"quick" | "dinein">("dinein");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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
      const response = await fetch("/api/auth/login", {
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
          role: "manager" | "cashier";
          permissions: {
            refundOrder: boolean;
            voidItem: boolean;
          };
        };
      };
      if (!payload.ok) {
        throw new Error(payload.error ?? "登入失敗");
      }

      if (!payload.session) {
        throw new Error("登入資料不完整");
      }
      saveAuthSession({ ...payload.session, loggedInAt: new Date().toISOString() });
      saveOperatingMode(mode === "quick" ? "quick" : "dinein");
      router.replace("/");
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
            <div className="text-sm font-semibold tracking-widest text-orange-200/90">
              澳門會員通POS系統
            </div>
            <div className="mt-2 text-2xl font-semibold text-white">登入</div>
            <div className="mt-2 text-sm text-white/70">請使用 8 位數字帳號及 4 位 PIN。</div>
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
              </div>
              <div className="text-xs text-white/40">快餐：無桌台，直接結帳；堂食：使用樓層與桌台。</div>
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
                placeholder="例如：63936541"
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
                placeholder="例如：1234"
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

          <PwaInstallButton />

          <div className="mt-4 text-center text-xs text-white/40">
            店長：63936541 / 1234　　收銀：63936542 / 1234
          </div>
        </div>
      </div>
    </div>
  );
}
