"use client";

import { useEffect, useState } from "react";

import { useT } from "@/components/lang-provider";

/**
 * 「顯示尺寸（診斷）」卡 —— 2026-10-14 加。
 *
 * ## 點解要有（背景）
 *
 * 平板適配全部靠「HUAWEI MatePad SE 10.4" ＝ 2000×1200 物理像素 ÷ DPR 2
 * ＝ CSS viewport **1000×600**」呢個**推算**。而家縮放觸發條件係
 * `@media (min-width:900px) and (max-width:1023px)`（見 `globals.css`）。
 *
 * ⚠️ 如果推算錯（例如實際 DPR 唔係 2、或者部機用咗系統「顯示大小」放大），
 *    viewport 可能 ≥1024 ⇒ **縮放完全唔會生效**，而家咁就會出現
 *    「老細話其他頁面冇變化」但完全搵唔到原因。
 *
 * ⇒ 呢張卡就係俾人一眼睇到：**闊×高 / DPR / 網頁字級 / 縮放有冇開着**。
 *
 * 🔴 **純顯示，零副作用**：淨係讀 `window.innerWidth`、`devicePixelRatio`
 *    同 `getComputedStyle(document.documentElement).fontSize`，
 *    冇 fetch、冇 localStorage 寫入、唔加任何請求（記憶：版本偵測唔可以加請求）。
 *
 * ⚠️ 只喺 `ClientOnly` 之後 render（成個 app 已經係），所以唔會有 hydration 唔一致：
 *    首屏 `null` → `useEffect` 之後先顯示真值。
 */

type Snapshot = {
  width: number;
  height: number;
  dpr: number;
  fontSize: string;
  scaleActive: boolean;
  device: string;
};

function detect(): Snapshot {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const fontSize = getComputedStyle(document.documentElement).fontSize;
  const parsed = Number.parseFloat(fontSize);
  // 縮放生效嘅兩個條件：闊度喺 900–1023px，**同埋** root font-size 真係細咗（12.8px）。
  const inRange = width >= 900 && width <= 1023;
  const scaled = inRange && Number.isFinite(parsed) && parsed < 15;
  const ua = navigator.userAgent;
  const device = /iPad/i.test(ua)
    ? "iPad"
    : /Android/i.test(ua)
      ? "Android"
      : /Macintosh/i.test(ua)
        ? "macOS"
        : "桌面";
  return { width, height, dpr: window.devicePixelRatio, fontSize, scaleActive: scaled, device };
}

export function ViewportSelfCheck() {
  const t = useT();
  const [snap, setSnap] = useState<Snapshot | null>(null);

  useEffect(() => {
    const read = () => setSnap(detect());
    read();
    window.addEventListener("resize", read);
    window.addEventListener("orientationchange", read);
    return () => {
      window.removeEventListener("resize", read);
      window.removeEventListener("orientationchange", read);
    };
  }, []);

  if (!snap) return null;

  const summary = [
    t("畫面闊 × 高：{w} × {h}", { w: String(snap.width), h: String(snap.height) }),
    t("像素密度 DPR：{dpr}", { dpr: String(snap.dpr) }),
    t("網頁字級：{size}", { size: snap.fontSize }),
    t("小平板縮放：{state}", {
      state: snap.scaleActive ? t("已啟用") : t("未啟用（闊度唔喺 900–1023px）"),
    }),
    t("裝置類型：{device}", { device: snap.device }),
  ].join("\n");

  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50/60 p-3 text-xs text-slate-700">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold text-slate-900">{t("顯示尺寸（診斷）")}</div>
        <button
          className="shrink-0 rounded-lg bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-300"
          onClick={() => {
            void navigator.clipboard?.writeText(summary);
          }}
          type="button"
        >
          {t("複製診斷")}
        </button>
      </div>
      <dl className="mt-2 grid grid-cols-1 gap-y-1">
        <div className="flex justify-between gap-2">
          <dt>{t("畫面闊 × 高")}</dt>
          <dd className="font-mono font-semibold">{snap.width} × {snap.height}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>{t("像素密度 DPR")}</dt>
          <dd className="font-mono font-semibold">{snap.dpr}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>{t("網頁字級")}</dt>
          <dd className="font-mono font-semibold">{snap.fontSize}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>{t("小平板縮放")}</dt>
          <dd className={snap.scaleActive ? "font-semibold text-emerald-700" : "font-semibold text-amber-700"}>
            {snap.scaleActive ? t("已啟用") : t("未啟用")}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>{t("裝置類型")}</dt>
          <dd className="font-semibold">{snap.device}</dd>
        </div>
      </dl>
      {!snap.scaleActive ? (
        <p className="mt-2 leading-relaxed text-amber-800">
          {t("縮放冇生效：如果呢部機實際唔係 900–1023px 闊，請將上面數字 send 返俾我哋改觸發條件。")}
        </p>
      ) : null}
    </section>
  );
}