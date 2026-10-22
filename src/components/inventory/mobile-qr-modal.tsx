"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { QrSvg } from "@/components/qr-svg";
import { posDeviceAuthHeadersFresh } from "@/lib/pos/pos-sync-auth";

/**
 * 「手機版庫存表」二維碼彈窗（2026-10-22 · J 要求）。
 *
 * 撳庫存頁右上角掣彈出；打開時即向 `POST /api/inventory/mobile-qr` 換一條
 * 一次性短碼 URL（預設 5 分鐘有效）渲染成 QR。手機掃完會自動開啟並登入
 * expense-recorder-sigma.vercel.app，直接用手機版庫存表。
 *
 * 設計要點：
 * - **倒數＋過期態**：短碼一次性兼短效，過咗要一撳「重新產生」再嚟（免得以為
 *   掃到但入面已經爛咗）。
 * - **錯誤態分類提示**：伺服器未設定 secret／資料表未跑 migration／未授權
 *   （舊 session 冇 device token）分開講，商家先知道搵邊個。
 * - 觸屏友好：所有掣 ≥44px 高。
 */

type QrStatus = "loading" | "ready" | "expired" | "error";

/** 伺服器錯誤碼 → 人話。 */
function friendlyError(code: string | undefined, fallback: string): string {
  switch (code) {
    case "SSO_SECRET_MISSING":
      return "手機版庫存表尚未啟用（伺服器未設定 MACAU_LEDGER_SSO_SECRET），請聯絡管理員。";
    case "QR_TABLE_MISSING":
      return "手機版庫存表尚未啟用（資料表未建立），請聯絡管理員。";
    case "EXPENSE_CLIENT_MISSING":
      return "庫存伺服器連線未設定，請聯絡管理員。";
    case "INVALID_ACCOUNT":
      return "搵唔到有效帳號，請登出並重新登入 POS。";
    default:
      return fallback;
  }
}

function fmtRemain(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function MobileQrModal({
  open,
  onClose,
  account,
  merchantId,
  storeName,
}: {
  open: boolean;
  onClose: () => void;
  account: string | null;
  merchantId: string | null;
  storeName: string;
}) {
  const [status, setStatus] = useState<QrStatus>("loading");
  const [url, setUrl] = useState("");
  const [expiresAtMs, setExpiresAtMs] = useState(0);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [remainMs, setRemainMs] = useState(0);
  const cancelledRef = useRef(false);

  const issue = useCallback(async () => {
    if (!merchantId) {
      setStatus("error");
      setError("搵唔到店舖資料，請登出並重新登入 POS。");
      return;
    }
    setStatus("loading");
    setError("");
    setUrl("");
    setCopied(false);
    try {
      const res = await fetch("/api/inventory/mobile-qr", {
        method: "POST",
        headers: { ...(await posDeviceAuthHeadersFresh()), "Content-Type": "application/json" },
        body: JSON.stringify({ storeId: merchantId, account, storeName }),
      });
      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; url?: string; expiresAt?: string; error?: string; code?: string }
        | null;
      if (cancelledRef.current) return;
      if (!res.ok || !payload?.ok || !payload.url) {
        setStatus("error");
        setError(friendlyError(payload?.code, payload?.error ?? "產生二維碼失敗，請稍後再試。"));
        return;
      }
      const expMs = payload.expiresAt ? new Date(payload.expiresAt).getTime() : 0;
      setUrl(payload.url);
      setExpiresAtMs(expMs);
      setRemainMs(expMs ? Math.max(0, expMs - Date.now()) : 0);
      setStatus("ready");
    } catch (e) {
      if (cancelledRef.current) return;
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [account, merchantId, storeName]);

  // 打開時產生一粒；關閉時標記取消（避免關窗後 setState）。
  useEffect(() => {
    if (!open) return;
    cancelledRef.current = false;
    void issue();
    return () => {
      cancelledRef.current = true;
    };
  }, [open, issue]);

  // 倒數（只在 ready 時行）。
  useEffect(() => {
    if (status !== "ready" || !expiresAtMs) return;
    const tick = () => {
      const left = expiresAtMs - Date.now();
      setRemainMs(left);
      if (left <= 0) setStatus("expired");
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [status, expiresAtMs]);

  const copyLink = useCallback(async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [url]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3">
      <div className="flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-4">
          <h3 className="text-xl font-semibold text-slate-900">手機版庫存表</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200"
          >
            關閉
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5 text-center">
          <p className="text-sm text-slate-500">
            請用手機相機掃描下方二維碼，掃描後會自動開啟並登入手機版庫存表，即刻可以使用。
          </p>

          {status === "loading" && (
            <div className="flex flex-col items-center gap-3 py-8">
              <div className="h-8 w-8 animate-spin rounded-full border-3 border-slate-200 border-t-slate-600" />
              <p className="text-sm text-slate-400">正在產生二維碼…</p>
            </div>
          )}

          {status === "ready" && (
            <>
              <div className="flex justify-center">
                <div className="rounded-2xl bg-white p-3 ring-1 ring-slate-200">
                  <QrSvg text={url} size={220} />
                </div>
              </div>
              <div>
                <span
                  className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold ${
                    remainMs <= 60_000 ? "bg-red-50 text-red-600" : "bg-slate-100 text-slate-600"
                  }`}
                >
                  有效時間 {fmtRemain(remainMs)}
                </span>
              </div>
              <p className="break-all text-xs text-slate-400">{url}</p>
            </>
          )}

          {status === "expired" && (
            <div className="rounded-2xl bg-amber-50 px-4 py-6 text-sm text-amber-700">
              二維碼已過期，請按下方「重新產生」換過一粒。
            </div>
          )}

          {status === "error" && (
            <div className="rounded-2xl bg-red-50 px-4 py-6 text-sm text-red-600">{error}</div>
          )}

          <div className="flex flex-wrap justify-center gap-2 pt-1">
            {status === "ready" && (
              <button
                type="button"
                onClick={() => void copyLink()}
                className="inline-flex min-h-[44px] items-center rounded-xl bg-white px-5 text-sm font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
              >
                {copied ? "已複製 ✓" : "複製連結"}
              </button>
            )}
            {(status === "expired" || status === "error") && (
              <button
                type="button"
                onClick={() => void issue()}
                className="inline-flex min-h-[44px] items-center rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700"
              >
                {status === "expired" ? "重新產生" : "重試"}
              </button>
            )}
            {status === "ready" && (
              <button
                type="button"
                onClick={() => void issue()}
                className="inline-flex min-h-[44px] items-center rounded-xl bg-slate-900 px-5 text-sm font-semibold text-white hover:bg-slate-800"
              >
                重新產生
              </button>
            )}
          </div>

          <p className="text-xs text-slate-400">
            二維碼短時間內有效，且僅限使用一次；過期或被使用過請按「重新產生」。
          </p>
        </div>
      </div>
    </div>
  );
}
