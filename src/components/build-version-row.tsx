"use client";

import { useEffect, useState } from "react";

import {
  buildLabel,
  describeBuildMismatch,
  getObservedServerBuildId,
  readClientBuildInfo,
  subscribeObservedServerBuild,
  type BuildInfo,
} from "@/lib/build-info";

/**
 * 設置頁「版本」列（2026-09-22）。
 *
 * ## 顯示咩
 *
 * | 欄 | 意義 | 來源 |
 * |---|---|---|
 * | **版本 `xxxxxxx（時間 · 環境）`** | **呢部機而家跑緊嘅嗰份 JS** | 建置時**內聯**入 bundle（`next.config` `env`）|
 * | `線上最新：xxxxxxx` | 伺服器部署緊嘅版本 | `/api/pos/state` 回應標頭 `x-pos-build` |
 * | ⚠ 黃色提示 | 兩者唔同 ＝ **呢個分頁過期** | 由上面兩者算出 |
 *
 * ## 為何「本機版本」一定要內聯（唔可以由 server 攞）
 *
 * 如果呢個數字係由 server 提供，一個**跑住舊 JS 嘅分頁**一樣會顯示「最新版本」
 * ⇒ 完全失去「確認商家實際用邊個版本」嘅作用（詳見 `@/lib/build-info` 頂部）。
 *
 * ## 為何只有提示、冇自動 reload
 *
 * 收銀落單／結帳中途 reload 會出事（本專案明確禁用）⇒ 只可以叫用戶自己
 * **完全閂掉視窗再開**。
 *
 * ## 為何唔加任何請求
 *
 * 「線上最新」係搭 `/api/pos/state` 嘅**回應標頭**（POS 本身每次都會打）
 * ⇒ 零額外呼叫、零額外 egress。
 */
export function BuildVersionRow() {
  // 內聯值喺 build 時已經固定，render 期間讀一次就夠。
  const [client] = useState<BuildInfo>(() => readClientBuildInfo());
  const [serverId, setServerId] = useState<string | null>(() => getObservedServerBuildId());

  useEffect(
    () => subscribeObservedServerBuild(() => setServerId(getObservedServerBuildId())),
    [],
  );

  const mismatch = describeBuildMismatch(client, serverId);

  return (
    <div className="mb-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-semibold text-slate-700">版本</span>
        <span className="font-mono text-slate-800">{buildLabel(client)}</span>
        {serverId ? (
          <span className="text-xs text-slate-400">
            線上最新：<span className="font-mono">{serverId}</span>
          </span>
        ) : null}
      </div>
      {mismatch ? (
        <div className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold leading-relaxed text-amber-700 ring-1 ring-amber-200">
          ⚠ {mismatch.text}
        </div>
      ) : null}
    </div>
  );
}
