"use client";

import { useEffect, useState } from "react";

import {
  buildLabel,
  describeBuildMismatch,
  describeReloadRisk,
  getObservedServerBuildId,
  readClientBuildInfo,
  subscribeObservedServerBuild,
  type BuildInfo,
} from "@/lib/build-info";

/**
 * 收銀台「版本過期」橫幅（2026-09-22）。
 *
 * ## 顯示條件
 *
 * 只有**客戶端內聯版本 ≠ 伺服器線上版本**時才出現（其餘時間完全唔 render，
 * 唔會佔任何空間、唔會干擾收銀）。
 *
 * ## 為何係 in-flow 橫幅而唔係 fixed overlay
 *
 * 放喺頁面**最頂**（`pos-app` 嘅 flex-col 容器第一個 child）：
 * · in-flow ⇒ 會將內容**推低**，唔會蓋住任何控制項（fixed overlay 會蓋住「開工／接單」）；
 * · 唔會令內容被 `overflow-hidden` 裁切（配合內容改成 `flex-1 min-h-0`）。
 *
 * ## 🔴 一鍵重新載入：有未完成工作就一定要確認
 *
 * 收銀落單／結帳中途 reload 會出事（本專案明確禁用**自動** reload）。
 * 但**人手撳**係另一個情況 —— 只要講清楚**邊樣會冇**（購物車／結帳畫面）
 * 同**邊樣唔會冇**（未上雲嘅紀錄喺 localStorage，會保留）就安全。
 * 詳見 `@/lib/build-info` 嘅 `describeReloadRisk()`。
 *
 * ## 為何唔自動 reload
 *
 * 同上：收銀結帳中途自動 reload ＝ 災難。只可以提示 + 交人手撳。
 */
export function BuildStaleBanner({
  cartItemCount,
  settlementOpen,
  pendingSyncCount,
}: {
  cartItemCount: number;
  settlementOpen: boolean;
  pendingSyncCount: number;
}) {
  const [client] = useState<BuildInfo>(() => readClientBuildInfo());
  const [serverId, setServerId] = useState<string | null>(() => getObservedServerBuildId());
  const [confirming, setConfirming] = useState(false);

  useEffect(
    () => subscribeObservedServerBuild(() => setServerId(getObservedServerBuildId())),
    [],
  );

  const mismatch = describeBuildMismatch(client, serverId);
  if (!mismatch) return null;

  const risk = describeReloadRisk({ cartItemCount, settlementOpen, pendingSyncCount });

  function requestReload() {
    // 冇未完成工作 → 直接重載（唔想為咗一按多一步）
    if (!risk.needsConfirm) {
      window.location.reload();
      return;
    }
    setConfirming(true);
  }

  return (
    <div className="shrink-0 border-b border-amber-300 bg-amber-50 px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm font-semibold text-amber-900">
          ⚠ 此裝置運行舊版本（本機 <span className="font-mono">{buildLabel(client)}</span>，
          線上最新 <span className="font-mono">{serverId}</span>）
        </span>
        <span className="text-xs text-amber-800">
          功能仍然可用，但請盡快更新（完全閂掉此視窗再開，或撳右邊掣）。
        </span>

        {confirming ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-amber-900">{risk.message}</span>
            <button
              className="min-h-[40px] rounded-full bg-amber-600 px-4 text-sm font-semibold text-white"
              onClick={() => window.location.reload()}
              type="button"
            >
              確認重新載入
            </button>
            <button
              className="min-h-[40px] rounded-full bg-white px-4 text-sm font-semibold text-amber-800 ring-1 ring-amber-300"
              onClick={() => setConfirming(false)}
              type="button"
            >
              取消
            </button>
          </span>
        ) : (
          <button
            className="min-h-[40px] rounded-full bg-amber-600 px-4 text-sm font-semibold text-white"
            onClick={requestReload}
            type="button"
          >
            立即重新載入
          </button>
        )}
      </div>
    </div>
  );
}
