"use client";

import { useMemo, type ReactElement } from "react";

import { encodeQrMatrix } from "@/lib/qrcode";

/**
 * QR 圖形（SVG）。**兩個掃碼面板共用**（`kiosk-qr-panel` 每枱一碼／
 * `quick-scan-qr-panel` 全店一碼），避免兩份實作走樣。
 *
 * ⚠️ 用自家 `encodeQrMatrix()` 直接砌 `<rect>`，唔靠 canvas / 外部圖庫：
 *   設定頁同列印視窗（`lib/pos/qr-print.ts`）都要喺**冇 canvas 權限**嘅
 *   WebView 入面畫得出 QR。
 *
 * ⚠️ 下面兩句錯誤文案**刻意唔經 `t()`**：佢哋係 2026-09 原版嘅寫法，
 *   屬「QR 畫唔出」嘅技術提示（極少出現），加 key 落字典只會為一個
 *   幾乎唔會見到嘅分支添兩條永遠用唔著嘅翻譯。要翻譯就一齊改兩本字典。
 */
export function QrSvg({ text, size = 160 }: { text: string; size?: number }) {
  const matrix = useMemo(() => (text ? encodeQrMatrix(text) : null), [text]);
  if (!matrix) {
    return (
      <div className="flex h-40 w-40 items-center justify-center rounded-lg border border-red-200 bg-red-50 text-center text-xs text-red-500">
        {text ? "太長，無法生成 QR" : "缺少枱號，無法生成 QR"}
        <br />
        （請用複製網址）
      </div>
    );
  }
  const quiet = 4;
  const total = matrix.size + quiet * 2;
  const cell = size / total;
  const rects: ReactElement[] = [];
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (matrix.modules[r][c]) {
        rects.push(
          <rect
            key={`${r}-${c}`}
            x={(c + quiet) * cell}
            y={(r + quiet) * cell}
            width={cell}
            height={cell}
            fill="#0f172a"
          />,
        );
      }
    }
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="rounded bg-white">
      <rect width={size} height={size} fill="#ffffff" />
      {rects}
    </svg>
  );
}
