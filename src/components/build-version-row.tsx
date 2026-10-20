"use client";

import { useEffect, useState } from "react";

import { useT } from "@/components/lang-provider";
import {
  buildLabel,
  describeBuildMismatch,
  getObservedServerBuildId,
  readClientBuildInfo,
  subscribeObservedServerBuild,
  type BuildInfo,
} from "@/lib/build-info";

/**
 * 設置頁 header 右側「版本」一行字（2026-10-20 由 body 卡片搬上嚟、縮做一行）。
 *
 * ## 顯示咩
 *
 * | 欄 | 意義 | 來源 |
 * |---|---|---|
 * | **版本 `xxxxxxx（時間 · 環境）`** | **呢部機而家跑緊嘅嗰份 JS** | 建置時**內聯**入 bundle（`next.config` `env`）|
 * | `線上最新：xxxxxxx` | 伺服器部署緊嘅版本 | `/api/pos/state` 回應標頭 `x-pos-build` |
 *
 * 兩者唔同（本機過期）⇒ 整行轉琥珀色 ＋ 加 ⚠，但維持一行字。
 *
 * ## 為何「本機版本」一定要內聯（唔可以由 server 攞）
 *
 * 如果呢個數字係由 server 提供，一個**跑住舊 JS 嘅分頁**一樣會顯示「最新版本」
 * ⇒ 完全失去「確認商家實際用邊個版本」嘅作用（詳見 `@/lib/build-info` 頂部）。
 *
 * ## 為何唔加任何請求
 *
 * 「線上最新」係搭 `/api/pos/state` 嘅**回應標頭**（POS 本身每次都會打）
 * ⇒ 零額外呼叫、零額外 egress。
 */
/** `buildLabel()` 入面會出現嘅環境名（`src/lib/build-info.ts` `envLabel()`）。 */
const BUILD_LABELS = ["本機", "生產", "預覽"] as const;

export function BuildVersionRow() {
  const t = useT();
  // 內聯值喺 build 時已經固定，render 期間讀一次就夠。
  const [client] = useState<BuildInfo>(() => readClientBuildInfo());
  const [serverId, setServerId] = useState<string | null>(() => getObservedServerBuildId());

  useEffect(
    () => subscribeObservedServerBuild(() => setServerId(getObservedServerBuildId())),
    [],
  );

  const mismatch = describeBuildMismatch(client, serverId);

  return (
    <span
      className={`whitespace-nowrap text-xs leading-none ${
        mismatch ? "font-semibold text-amber-600" : "text-slate-500"
      }`}
    >
      {mismatch ? "⚠ " : ""}
      {t("版本")}{" "}
      {/* ⚠️ `buildLabel()` 嘅 hash／時間係技術值 ⇒ 唔翻譯；
          但入面嘅環境名（`本機` / `生產` / `預覽`）係顯示文案 ⇒ 只翻譯呢部分。 */}
      <span className="font-mono">{BUILD_LABELS.reduce((acc, w) => acc.split(w).join(t(w)), buildLabel(client))}</span>
      {serverId ? (
        <>
          {"　"}
          {t("線上最新：{id}", { id: "" })}
          <span className="font-mono">{serverId}</span>
        </>
      ) : null}
    </span>
  );
}
