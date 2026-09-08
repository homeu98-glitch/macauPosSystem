import { encodeQrMatrix } from "@/lib/qrcode";
import type { EscPosSize, QrPayload } from "@/lib/types";

/**
 * 收據二維碼：URL → 三個 repo 共用嘅點陣。
 *
 * ## 點解要喺 POS 端預先編碼，而唔係 renderer 自己 encode？
 *
 * 1. **「設計介面 == 螢幕預覽 == 實際出紙」**：三個 repo 各自 encode 就要各自實作 QR
 *    encoder（Companion 係 Node、APK 係 Kotlin），任一方 mask / version 揀選有偏差，
 *    出紙就同預覽唔同。POS 端 encode 一次，其他兩邊淨負責「點陣 → 點陣圖」。
 * 2. **相容性**：renderer 用 ESC/POS 點陣圖指令（`GS v 0`）輸出，唔使靠
 *    `GS ( k` 原生 QR 指令（舊機 / 平價機未必支援，唔支援會印亂碼）。
 * 3. **零外部依賴**：沿用 `src/lib/qrcode.ts`（已用 jsQR + qrcode 套件交叉驗證過）。
 *
 * 網址空白 / 太長（超出 v6 容量）→ 回傳 `null`，`qr_code` 區塊自動略過，唔會印空框。
 */
export function encodeQrPayload(url: string | undefined | null): QrPayload | null {
  const text = (url ?? "").trim();
  if (!text) return null;
  const matrix = encodeQrMatrix(text);
  if (!matrix) return null;
  const { size, modules } = matrix;
  let bits = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) bits += modules[r][c] ? "1" : "0";
  }
  return { size, bits };
}

/**
 * QR 規範要求嘅白邊（quiet zone）闊度，單位 = module。
 * 預覽（SVG）同出紙（點陣圖）都補同一個值，兩邊先會一致。
 */
export const QR_QUIET_MODULES = 4;

/**
 * 出紙時每個 module 放大到幾多點。
 *
 * 80mm 熱敏紙 203dpi 可印闊度約 576 dots。QR v1（21 modules）+ 8 格白邊 = 29 modules，
 * ×5 = 145 dots（≈18mm）—— 大細啱啱好掃得到又唔會大到甩出紙邊。
 * 高 version（長網址）自動縮細倍率，令最終點陣圖維持喺 ~150 dots 左右。
 */
export function qrModuleScale(size: number): number {
  const total = size + QR_QUIET_MODULES * 2;
  return Math.max(2, Math.min(6, Math.floor(160 / total)));
}

/**
 * 二維碼打印大小（`s` / `m` / `l`）→ 顯示比例（相對 80mm 紙可印闊度）。
 *
 * 收據/自助點餐機模板可以喺「打印 → 收據模板 / 自助點餐機」各自揀二維碼大小，
 * 網頁即時預覽（EscPosPreview）用呢個比例畫二維碼圖像大細。值越大個二維碼越大。
 *
 * ⚠️ 真實出紙嗰陣 Companion / APK 各自用 `qrModuleScale()` 決定點陣倍率，呢度主要控制
 * 「設計介面即時預覽」嘅顯示大小，並隨模板 (`qrSize`) 存落去，等設計 == 預覽一致。
 */
export const QR_SIZE_FRACTION: Record<EscPosSize, number> = {
  // 細：約紙闊 40%；中：約紙闊 55%（貼近舊 default 60% 附近）；大：約紙闊 80%（逼紙邊）。
  s: 0.4,
  m: 0.55,
  l: 0.8,
};

/** 二維碼大小嘅中文標籤。 */
export const QR_SIZE_LABEL: Record<EscPosSize, string> = { s: "細", m: "中", l: "大" };
