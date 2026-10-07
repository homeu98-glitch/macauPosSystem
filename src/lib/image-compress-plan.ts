/**
 * 相片壓縮：**決策邏輯**（零 import 純函式）。
 *
 * 🔴 為何要拆成兩層？
 *
 * 真正做壓縮嘅 `compressImage()` 需要 `createImageBitmap` / `document` /
 * `canvas.toBlob` —— 全部係瀏覽器 API，喺 `node --test` 環境**根本冇**。
 * 而本專案嘅測試慣例係 `node --test` ＋ 零 import 純模組（見 `pos-task-router`
 * 技能：`npm test` 跑 `node --test`、唔認 `@/` 別名、唔認 `.tsx`）。
 *
 * ⇒ 所以把「點揀參數」嘅**決策**抽到呢個檔（可測），
 *   真正嘅 canvas 繪圖留喺 `image-compress.ts`（不可測，只做機械操作）。
 *
 * 硬要求（J 2026-10-07 拍板）：**上傳前必須壓縮到 200KB 以下**。
 * 呢個唔係「優化」，係需求 —— 所以設計成**逐級降級直到達標**，
 * 而唔係「壓一次，唔得就算」。
 */

/**
 * 硬性上限：200 KB。
 *
 * ⚠️ 用 1024（KB）而唔係 1000：商家／瀏覽器／Supabase 都係用 KiB 語意，
 * 用 1024 較保守（要求係「200kb 以下」，保守 = 安全）。
 */
export const MAX_UPLOAD_BYTES = 200 * 1024;

/** 最長邊上限（第一級）。單據 A4 縮到 1600px 仍然睇得清細字。 */
export const MAX_EDGE = 1600;

/**
 * 品質階梯（由高到低）。
 *
 * 策略：**先保解析度、後降品質**。單據係文字，解析度比品質重要 ——
 * 1600px + q0.75 比 900px + q0.92 更易讀。
 * 最後一級 0.5 係保底（再低文字就開始糊）。
 */
export const QUALITY_LADDER = [0.82, 0.72, 0.62, 0.5] as const;

/**
 * 縮邊階梯（第二階段用）。
 *
 * 若降 quality 到最後一級仍然超標（例如原圖係 8000×6000 嘅超高細節相，
 * q0.5 都仲有 400KB），就開始縮邊重試。
 */
export const EDGE_LADDER = [1600, 1280, 1024, 800] as const;

export type CompressPlanStep = {
  /** 目標最長邊（px）。 */
  maxEdge: number;
  /** JPEG 品質（0–1）。 */
  quality: number;
};

/**
 * 產生嘗試序列。
 *
 * 次序：**先用最高品質、逐級降 quality；quality 到底都唔得，才開始縮邊重來。**
 *
 * 為何係「先降 quality」而唔係「先縮邊」？
 * → 單據係文字，縮邊傷可讀性（筆劃黏埋）多過降 quality 起格。
 *   先試 q0.82 → 0.5，多數單據相（白底黑字、色塊單一）喺 q0.62 前就達標。
 *
 * @param maxEdge 自訂最大邊；預設 `MAX_EDGE`。傳入值會被夾到唔大過 `MAX_EDGE`
 *                （唔可以放大過 1600 —— 放大只會增加 bytes 但零資訊增益）。
 * @param ladder  自訂品質階梯；預設 `QUALITY_LADDER`。測試用。
 * @param edges   自訂縮邊階梯；預設 `EDGE_LADDER`。測試用。
 */
export function buildCompressPlan(
  maxEdge: number = MAX_EDGE,
  ladder: readonly number[] = QUALITY_LADDER,
  edges: readonly number[] = EDGE_LADDER,
): CompressPlanStep[] {
  const start = clampEdge(maxEdge);
  // 由起點開始嘅縮邊序列（唔可以大過起點，亦唔可以有重複）。
  const usableEdges = edges.filter((e) => e <= start);
  if (!usableEdges.includes(start)) usableEdges.unshift(start);

  const plan: CompressPlanStep[] = [];
  for (const edge of usableEdges) {
    for (const quality of ladder) {
      plan.push({ maxEdge: edge, quality });
    }
  }
  return plan;
}

/** 把「想要嘅最長邊」夾入 [200, MAX_EDGE]。太細會壓到睇唔清，太大冇意義。 */
export function clampEdge(edge: number): number {
  if (!Number.isFinite(edge) || edge <= 0) return MAX_EDGE;
  return Math.min(MAX_EDGE, Math.max(200, Math.round(edge)));
}

/**
 * 依原圖尺寸算出縮放後嘅畫布尺寸。
 *
 * ⚠️ **唔會放大**：原圖 800×600、maxEdge 1600 ⇒ 回 800×600（scale = 1）。
 * 放大只會增加 bytes 而唔會多任何資訊，反而令 200KB 更難達到。
 *
 * ⚠️ 最少 1px：極端長條圖（例如 4000×3）縮完高度可能變 0，
 * canvas 尺寸 0 會令 `toBlob()` 回 `null`。
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number; scale: number } {
  const w = Number.isFinite(width) && width > 0 ? width : 1;
  const h = Number.isFinite(height) && height > 0 ? height : 1;
  const longest = Math.max(w, h);
  if (longest <= maxEdge) {
    return { width: Math.round(w), height: Math.round(h), scale: 1 };
  }
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale,
  };
}

/**
 * 判斷壓縮產物係唔係達標（< 200KB）。
 *
 * @param bytes 實際產物大小（byte）。
 * @param limit 上限；預設 `MAX_UPLOAD_BYTES`。
 *
 * 🔴 用 **strict `<`**（唔係 `<=`）：要求係「200kb **以下**」。
 *    剛好 204800 bytes 唔算達標（要再壓一級）。
 *    ⚠️ 呢度係最容易寫錯嘅一條 —— 204800 = 200×1024 係「等於 200KB」，
 *    而「200KB 以下」嚴格黎講唔包括 200KB 本身。
 */
export function isWithinLimit(bytes: number, limit: number = MAX_UPLOAD_BYTES): boolean {
  if (!Number.isFinite(bytes) || bytes <= 0) return false;
  return bytes < limit;
}

/**
 * 上傳前嘅把關。
 *
 * 回 `null` = 可以上傳。
 * 回字串 = **唔可以上傳**，字串係要顯示畀商家嘅原因。
 *
 * ⚠️ **最後防線**：就算 `compressImage()` 走完所有階梯都仲係超標
 * （例如 PNG 透明背景轉 JPEG 反而變大、或者 canvas 唔支援 JPEG），
 * 呢個函式會擋住 —— 唔可以「壓縮失敗就照上傳原圖」，
 * 否則「200KB 以下」呢個要求就會被靜默繞過。
 */
export function rejectReason(bytes: number, limit: number = MAX_UPLOAD_BYTES): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0) return "圖片處理失敗，請換一張再試。";
  if (isWithinLimit(bytes, limit)) return null;
  const kb = Math.round(bytes / 1024);
  const maxKb = Math.round(limit / 1024);
  return `這張圖片壓縮後仍有 ${kb}KB，超過 ${maxKb}KB 上限，請改用較小的圖片。`;
}

/** 人類可讀大小（提示用）。 */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0KB";
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    // 小數一位，但 0.x KB 唔好顯示成「0.0KB」
    return `${kb < 10 ? Math.max(0.1, Math.round(kb * 10) / 10) : Math.round(kb)}KB`;
  }
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}MB`;
}
