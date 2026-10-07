"use client";

/**
 * 相片壓縮（瀏覽器端）。
 *
 * 決策邏輯（階梯、上限、把關）喺 `image-compress-plan.ts`（零 import、可測）；
 * 呢個檔只做**機械操作**：解碼 → 畫落 canvas → `toBlob` → 檢查大小 → 唔夠再試下一級。
 *
 * 🔴 硬要求（J 2026-10-07）：**上傳前必須壓縮到 200KB 以下**。
 *    所以呢個檔唔會「壓一次就算」—— 會沿住 `buildCompressPlan()` 嘅階梯
 *    逐級重試，直到達標或者階梯走完。
 *
 * 🔴 跑完都唔達標點算？**回傳結果連 `ok:false`，由呼叫方決定唔上傳。**
 *    絕對唔可以「壓縮失敗就照上傳原圖」—— 咁樣 200KB 要求就被靜默繞過。
 *    最後防線喺 `rejectReason()`。
 */

import {
  MAX_EDGE,
  buildCompressPlan,
  fitWithin,
  humanSize,
  isWithinLimit,
  rejectReason,
} from "./image-compress-plan";

export type CompressResult =
  | { ok: true; blob: Blob; width: number; height: number; quality: number; attempts: number }
  | { ok: false; error: string; attempts: number };

/**
 * 解碼圖片。
 *
 * 🔴 用 `createImageBitmap()` 而唔係 `new Image()`：
 *    前者**會自動套用 EXIF Orientation**，iPad 直拍嘅相唔會轉 90° 躺低。
 *    `new Image()` 要自己讀 EXIF 再計旋轉，好易錯。
 *
 * ⚠️ Safari 15 以下唔支援 `createImageBitmap` 嘅 `imageOrientation` 選項，
 *    但**基本 `createImageBitmap(file)` 由 Safari 15 已經有**（iPad POS 最低要求）。
 *    真係冇就降級用 `<img>` + `URL.createObjectURL`（唔處理 EXIF，但唔會爆）。
 */
async function decode(file: File): Promise<{ bitmap: ImageBitmap | HTMLImageElement; width: number; height: number; revoke?: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file);
      return { bitmap: bmp, width: bmp.width, height: bmp.height };
    } catch {
      /* 落到下面嘅 <img> 降級 */
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("無法讀取圖片"));
      el.src = url;
    });
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    return { bitmap: img, width: w, height: h, revoke: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/** 畫落指定尺寸嘅 canvas 再編 JPEG。失敗（例如 toBlob 回 null）回 null。 */
async function renderJpeg(
  src: ImageBitmap | HTMLImageElement,
  width: number,
  height: number,
  quality: number,
): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  /*
   * 🔴 白色底：單據相片若係 PNG（透明背景）轉 JPEG，透明位會變**黑**，
   * 黑底黑字等於睇唔到。先填白底再畫圖。
   * 順帶：白底令 JPEG 壓縮率更高（大面積純色）⇒ 更容易達到 200KB。
   * 🔴 一定要喺 drawImage **之前**填。
   */
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // 縮圖時開平滑，避免文字筆劃起鋸齒（單據係文字，鋸齒 = 睇唔清）。
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, width, height);

  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", quality);
  });
}

/**
 * 把使用者揀嘅相片壓到 200KB 以下。
 *
 * 策略：沿 `buildCompressPlan()` 逐級試 —— 先降 quality，唔得再縮邊。
 * 一達標**立即停**（唔會為咗「再細啲」白做多幾次編碼，慳 iPad 電同時間）。
 *
 * @param file    使用者揀嘅檔案（`<input type="file">`）。
 * @param onStage 可選進度回報（例如「壓縮中…第 2 次嘗試」）。
 *
 * ⚠️ 回 `ok:false` 時**唔可以上傳**（見檔頂註解）。
 */
export async function compressImage(
  file: File,
  onStage?: (text: string) => void,
): Promise<CompressResult> {
  let decoded: Awaited<ReturnType<typeof decode>>;
  try {
    decoded = await decode(file);
  } catch {
    // 解碼失敗係「本身唔係圖片」／檔案損毀，唔值得逐級重試。
    return { ok: false, error: "無法讀取這張圖片，請換一張再試。", attempts: 0 };
  }

  const { bitmap, width, height, revoke } = decoded;
  try {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      return { ok: false, error: "圖片尺寸異常，請換一張再試。", attempts: 0 };
    }

    const plan = buildCompressPlan(MAX_EDGE);
    // 記住最後一次嘅產物：若全部階梯都唔達標，把最細嗰個交去 rejectReason 砌訊息
    // （比用原圖大小砌訊息準確 —— 商家見到「壓完仲有 X KB」更易理解）。
    let smallest: { blob: Blob; width: number; height: number; quality: number } | null = null;

    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];
      const size = fitWithin(width, height, step.maxEdge);
      onStage?.(`壓縮中…（${i + 1}/${plan.length}）`);

      const blob = await renderJpeg(bitmap, size.width, size.height, step.quality);
      if (!blob) continue;

      if (!smallest || blob.size < smallest.blob.size) {
        smallest = { blob, width: size.width, height: size.height, quality: step.quality };
      }

      if (isWithinLimit(blob.size)) {
        return {
          ok: true,
          blob,
          width: size.width,
          height: size.height,
          quality: step.quality,
          attempts: i + 1,
        };
      }
    }

    // 走完階梯都超標 ⇒ 擋住，唔上傳（最後防線）。
    const reason = rejectReason(smallest?.blob.size ?? 0);
    return {
      ok: false,
      error: reason ?? `這張圖片壓縮後仍有 ${humanSize(smallest?.blob.size ?? 0)}，超過 200KB 上限。`,
      attempts: plan.length,
    };
  } finally {
    revoke?.();
    // ImageBitmap 要主動 close()，否則連續處理幾張相會佔住幾十 MB 記憶體
    // （iPad Safari 記憶體緊，會直接 reload 分頁 = 商家填嘅資料全失）。
    if (typeof ImageBitmap !== "undefined" && bitmap instanceof ImageBitmap) bitmap.close();
  }
}
