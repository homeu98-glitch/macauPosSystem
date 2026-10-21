"use client";

import { useState } from "react";

import { loadAuthSession, saveAuthSession } from "@/lib/storage";

/**
 * 改 PIN 彈窗（2026-10-21 · 多店控制台 P2-4）。
 *
 * ## 為何要有 `forced` 模式
 *
 * 平台派發初始 PIN（例如 1234），如果唔強制改，就等於「公開嘅 4 位密碼」——
 * 10⁴ 組合 + 已知初始值。所以建號／重設 PIN 之後，登入第一件事就要改。
 * `forced` = true 時**唔可以關閉**（冇關閉按鈕、按 Esc 無效），唯一出路係改完或者登出。
 *
 * ## 為何要驗舊 PIN
 *
 * 已登入唔代表係本人（平板可能係上一個店員未登出）。改 PIN 等於改「長期憑證」，
 * 一定要再驗一次舊 PIN（同銀行 App 改密碼同一道理）。
 */

export function AdminChangePinModal({
  forced,
  onClose,
  onChanged,
}: {
  forced: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);

    if (newPin !== confirmPin) {
      setError("兩次輸入嘅新 PIN 唔一致。");
      return;
    }
    if (newPin === oldPin) {
      setError("新 PIN 唔可以同舊 PIN 一樣。");
      return;
    }

    setBusy(true);
    try {
      const token = loadAuthSession()?.adminSessionToken;
      const res = await fetch("/api/admin/me/pin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token ?? ""}`,
        },
        body: JSON.stringify({ oldPin, newPin }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `修改失敗（HTTP ${res.status}）`);
        return;
      }

      // 清走 localStorage 的 mustChangePin，避免 reload 後又彈。
      const session = loadAuthSession();
      if (session) saveAuthSession({ ...session, mustChangePin: undefined });
      onChanged();
    } catch {
      setError("網絡錯誤，請重試。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <h2 className="text-base font-bold text-slate-900">
          {forced ? "請先修改初始 PIN" : "修改 PIN"}
        </h2>
        <p className="mt-1 mb-4 text-xs text-slate-500">
          {forced
            ? "呢個帳號仲用緊平台派發嘅初始 PIN。為咗安全，請即刻改成只有你自己知嘅 4 位數字。"
            : "輸入舊 PIN 再設定新 PIN（4 位數字）。"}
        </p>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-slate-600">舊 PIN</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            maxLength={4}
            value={oldPin}
            onChange={(e) => setOldPin(e.target.value.replace(/\D/g, ""))}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500"
            placeholder="4 位數字"
          />
        </label>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-slate-600">新 PIN</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={4}
            value={newPin}
            onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500"
            placeholder="4 位數字"
          />
        </label>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-slate-600">再輸入一次新 PIN</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={4}
            value={confirmPin}
            onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ""))}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500"
            placeholder="4 位數字"
          />
        </label>

        {error ? <p className="mb-3 text-xs text-red-600">{error}</p> : null}

        <div className="mt-5 flex items-center justify-end gap-2">
          {forced ? null : (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
            >
              取消
            </button>
          )}
          <button
            type="submit"
            disabled={busy || oldPin.length !== 4 || newPin.length !== 4 || confirmPin.length !== 4}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {busy ? "儲存中…" : "確認修改"}
          </button>
        </div>
      </form>
    </div>
  );
}
