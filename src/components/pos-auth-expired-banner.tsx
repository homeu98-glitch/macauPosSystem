"use client";

import { useEffect, useState } from "react";

import { signOutLedgerSession } from "@/lib/ledger/session";
import {
  getPosAuthExpiredAt,
  getPosAuthExpiredReason,
  isPosAuthExpired,
  subscribePosAuthExpired,
} from "@/lib/pos/auth-expired";

/**
 * 收銀台「雲端登入已過期」橫幅（2026-11-03）。
 *
 * ## 為何一定要出（靜默 = 最貴）
 *
 * Ledger 會話一死，`/api/pos/device-token` 就續唔到 POS 憑證，跟住：
 *   · 新單／結帳／打印任務全部被 server 當「匿名」拒收 ⇒ 只留喺本機 outbox；
 *   · 報表、交班、線上訂單、會員全部斷；
 *   · 舊版**冇任何提示**，收銀員以為一切正常，直到對數嗰日才發現。
 *
 * ## 為何唔自動 reload／唔自動登出
 *
 * 同《工作階段被關閉》橫幅同一取捨：收銀**結帳中途**重載會出事，
 * 所以只出 in-flow 提示（推低內容、唔蓋住按鈕）＋交人手撳。
 *
 * ## 為何要講「本機照開得單」
 *
 * 呢個系統係 offline-first：本機落單、出紙全部照運作，只係**上唔到雲**。
 * 如果文案只講「登入失效」，收銀員會以為部機壞咗、唔敢做生意 —— 反而更差。
 * 所以要同時講清楚「會暫存、重新登入後會補傳」。
 */
export function PosAuthExpiredBanner() {
  const [expired, setExpired] = useState(() => isPosAuthExpired());
  const [reason, setReason] = useState<string | null>(() => getPosAuthExpiredReason());
  const [at, setAt] = useState<string | null>(() => getPosAuthExpiredAt());
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      subscribePosAuthExpired(() => {
        setExpired(isPosAuthExpired());
        setReason(getPosAuthExpiredReason());
        setAt(getPosAuthExpiredAt());
      }),
    [],
  );

  if (!expired) return null;

  const timeLabel = at
    ? new Intl.DateTimeFormat("zh-HK", {
        timeZone: "Asia/Macau",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(at))
    : null;

  async function handleRelogin() {
    if (busy) return;
    setBusy(true);
    try {
      // ⚠️ 一定要真登出（清 session + 標記裝置已登出），單純跳 `/login` 會被
      //    AuthGuard 用同一個殘留 session 踢返嚟，收銀員會覺得「撳完冇反應」。
      await signOutLedgerSession();
    } catch {
      // 清唔到都照跳；最壞情況係登入頁再登入一次覆蓋
    }
    window.location.replace("/login");
  }

  return (
    <div className="shrink-0 border-b border-amber-300 bg-amber-50 px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm font-semibold text-amber-900">⚠️ 雲端登入已過期</span>
        <span className="text-xs text-amber-900">
          <b>本機照樣開單、出紙</b>；但新單／結帳暫時<b>上唔到雲</b>
          （會留在本機，重新登入後自動補傳）。線上訂單、會員、報表、交班同步會失敗。
          {timeLabel ? `（由 ${timeLabel} 起）` : ""}
          {reason === "session_expired" ? "" : reason ? `原因：${reason}` : ""}
        </span>
        <span className="w-full text-xs font-semibold text-amber-900">
          請喺空檔時間撳「重新登入」，用店員帳號再入一次即可恢復。
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <button
            className="min-h-[40px] rounded-full bg-amber-600 px-4 text-sm font-semibold text-white disabled:opacity-60"
            disabled={busy}
            onClick={handleRelogin}
            type="button"
          >
            {busy ? "正在登出…" : "重新登入"}
          </button>
        </span>
      </div>
    </div>
  );
}
