"use client";

import { useEffect, useState } from "react";

import { describeReloadRisk } from "@/lib/build-info";
import { clearAuthSession } from "@/lib/storage";
import {
  getPosSessionRevokedReason,
  isPosSessionRevoked,
  subscribePosSessionRevoked,
} from "@/lib/pos/session-revoked";

/**
 * 收銀台「此工作階段已被管理員關閉」橫幅（2026-09-22）。
 *
 * ## 為何需要呢個橫幅（而唔係靜靜停咗就算）
 *
 * 管理員喺 `/admin/sessions` 撳「強制關閉」之後，server 只可以**通知**：
 * 本分頁下次請求會收到 `x-pos-session-closed: 1`，然後：
 *   · 輪詢閘當「冇 session」⇒ **停止所有輪詢**（止住 egress，呢個係原本目的）；
 *   · 新生意（建單／加菜）被 server 拒收（`reason: "session-closed"`）。
 *
 * 如果唔出橫幅，收銀員只會見到「撳落去冇反應」——最容易被誤判成「部機壞咗」，
 * 然後打電話求救，或者索性自己重開（而重開之後其實就冇事，但佢唔知）。
 *
 * ## 為何 in-flow、唔自動 reload
 *
 * 同《版本過期橫幅》完全一樣嘅取捨（見 `build-stale-banner.tsx`）：
 * · in-flow ⇒ 推低內容，唔會蓋住「開工／接單」等控制項；
 * · **唔自動 reload** ⇒ 收銀結帳中途 reload 會出事。只可以提示 + 交人手撳，
 *   而且撳之前要用 `describeReloadRisk()` 講清楚**邊樣會冇／邊樣唔會冇**。
 *
 * ## 為何有「重新登入」而唔止「重新載入」
 *
 * reload 只會令同一個（已被撤銷嘅）工作階段再開一次 —— 換言之 reload 之後
 * 仍然係「已關閉」。真正嘅復原係**重新登入**（`login-screen` 會輪替工作階段識別碼，
 * 見 `session-key.ts` 嘅 `rotatePosSessionKey()`）。
 * ⇒ 兩個掣都提供，並講明分別。
 */
export function SessionRevokedBanner({
  cartItemCount,
  settlementOpen,
  pendingSyncCount,
}: {
  cartItemCount: number;
  settlementOpen: boolean;
  pendingSyncCount: number;
}) {
  const [revoked, setRevoked] = useState(() => isPosSessionRevoked());
  const [reason, setReason] = useState<string | null>(() => getPosSessionRevokedReason());
  const [confirming, setConfirming] = useState(false);

  useEffect(
    () =>
      subscribePosSessionRevoked(() => {
        setRevoked(isPosSessionRevoked());
        setReason(getPosSessionRevokedReason());
      }),
    [],
  );

  if (!revoked) return null;

  const risk = describeReloadRisk({ cartItemCount, settlementOpen, pendingSyncCount });

  function requestReload() {
    if (!risk.needsConfirm) {
      window.location.reload();
      return;
    }
    setConfirming(true);
  }

  /**
   * 真正嘅復原路徑：清 session → 回登入頁。
   *
   * ⚠️ **唔可以**只係 `location.assign("/login")`：`AuthGuard` 見到仲有 session
   * 會即刻踢返嚟，變成「撳完好似冇反應」。所以一定要先 `clearAuthSession()`。
   *
   * 重新登入成功時，`login-screen` 會輪替工作階段識別碼
   *（`rotatePosSessionKey()`）⇒ 新工作階段，唔會再被當成「已關閉」。
   */
  function handleRelogin() {
    clearAuthSession();
    window.location.replace("/login");
  }

  return (
    <div className="shrink-0 border-b border-red-300 bg-red-50 px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm font-semibold text-red-900">
          ⛔ 此工作階段已被管理員關閉
        </span>
        <span className="text-xs text-red-800">
          本機已停止接收新訂單。<b>已落單／未上雲嘅紀錄會保留</b>
          ，當前畫面嘅結帳仍可完成。
          {reason ? `關閉原因：${reason}` : ""}
        </span>
        {/* 獨立一行：指令要一眼睇到（收銀員係繁忙中讀呢句） */}
        <span className="w-full text-xs font-semibold text-red-900">
          要繼續開單：請「登出並重新登入」或開新視窗。單純重新載入冇用 —— 身分仍然係已關閉。
        </span>

        {confirming ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-red-900">{risk.message}</span>
            <button
              className="min-h-[40px] rounded-full bg-red-600 px-4 text-sm font-semibold text-white"
              onClick={() => window.location.reload()}
              type="button"
            >
              確認重新載入
            </button>
            <button
              className="min-h-[40px] rounded-full bg-white px-4 text-sm font-semibold text-red-800 ring-1 ring-red-300"
              onClick={() => setConfirming(false)}
              type="button"
            >
              取消
            </button>
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            <button
              className="min-h-[40px] rounded-full bg-red-600 px-4 text-sm font-semibold text-white"
              onClick={handleRelogin}
              type="button"
            >
              登出並重新登入
            </button>
            <button
              className="min-h-[40px] rounded-full bg-white px-4 text-sm font-semibold text-red-800 ring-1 ring-red-300"
              onClick={requestReload}
              type="button"
            >
              只重新載入
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
