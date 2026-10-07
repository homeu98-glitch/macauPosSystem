/**
 * Tooltip／氣泡**自動定位**運算（2026-10-07）。
 *
 * ## 為咩要有
 *
 * `InfoBubble` 原本寫死 `absolute left-0 top-[26px]`（永遠喺球下面靠左）。
 * 截圖實證：KPI 卡右上角嘅提示球（例如「客單價」）本身就貼住卡片右緣，
 * 氣泡向右伸展 ⇒ **超出螢幕右邊界被切走**（商家見唔到「= 營業額…」嗰幾行）。
 *
 * 兩個錨點場景要獨立處理：
 *  - **右側錨點**（卡內靠右嘅球）→ 預設向右伸展會出界 ⇒ 要改為**向左**伸展。
 *  - **左側錨點**（卡內靠左嘅球）→ 預設已經正確，**唔可以**因為右邊有其他球就一齊翻。
 *
 * ## 口徑（J 拍板）
 *
 * - **先水平、後垂直**：先決定氣泡嘅**水平對齊**（靠左／靠右），
 *   再決定**垂直邊**（下面／上面）。咁樣每顆球嘅水平判斷互不干擾。
 * - 三層兜底：預設 → 翻轉 → **夾入**（保證任何情況都完整顯示於可視區）。
 * - 邊界要計 **safe area**（iPad／iPhone 瀏海）＋ **visual viewport**
 *   （iOS 鍵盤彈起時 `innerHeight` 唔可信，要用 `visualViewport.height/offsetTop`）。
 *
 * ## 點解係純函式
 *
 * 專案行 `node --test`：唔認 `@/` alias、唔認 `.tsx` ⇒ 呢個檔案**零 import**，
 * 定位邏輯可以獨立測（見 `tooltip-placement.test.ts`），DOM 讀取只留喺最底兩個函式。
 */

/** 四邊安全區間距（px）。 */
export type EdgeInsets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

/** 錨點（觸發元素）喺 **viewport 座標**嘅矩形。 */
export type AnchorRect = {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

/** 可視範圍（已扣走 safe area 之前嘅原始視窗 + 視口偏移）。 */
export type PlacementViewport = {
  /** 可視寬度（css px）。 */
  width: number;
  /** 可視高度 —— iOS 鍵盤彈起時應該用 `visualViewport.height`，唔係 `innerHeight`。 */
  height: number;
  /** 可視區左上角喺 layout viewport 內嘅偏移（zoomed／鍵盤時唔係 0）。 */
  offsetTop: number;
  offsetLeft: number;
  /** safe area 間距。 */
  insets: EdgeInsets;
};

/** 氣泡自身量到嘅尺寸。 */
export type BubbleSize = {
  width: number;
  height: number;
};

export type TooltipSide = "top" | "bottom";
export type TooltipAlign = "left" | "right";

export type TooltipPlacement = {
  side: TooltipSide;
  align: TooltipAlign;
  /** 相對 viewport 左上角嘅 px 座標（配合 `position: fixed` 使用）。 */
  left: number;
  top: number;
  /** 建議嘅 `max-width`（已收窄至可視區可用闊度）。 */
  maxWidth: number;
  /** 建議嘅 `max-height`（已收窄至可視區可用高度；內容過長則內部捲動）。 */
  maxHeight: number;
  /** 有冇由預設（下方靠左）翻轉過 —— 主要用嚟做測試／debug。 */
  flippedX: boolean;
  flippedY: boolean;
  /** 翻轉都擺唔落 ⇒ 已經夾入可視區。 */
  clampedX: boolean;
  clampedY: boolean;
};

export type TooltipPlacementInput = {
  anchor: AnchorRect;
  bubble: BubbleSize;
  viewport: PlacementViewport;
  /** 球同氣泡之間嘅空隙（px）。 */
  gap?: number;
  /** 氣泡離可視區邊緣最少保留（px）。 */
  padding?: number;
  /** 氣泡本身嘅最大闊度（px）；實際會再被可視區闊度收窄。 */
  preferredMaxWidth?: number;
};

const DEFAULT_GAP = 8;
const DEFAULT_PADDING = 8;
const DEFAULT_MAX_WIDTH = 320;

/** 浮點寬限：subpixel 落位唔好因為 0.01px 就判定「唔啱」。 */
const EPS = 0.5;

const ZERO_INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** `left`（氣泡左緣）落喺 `[minX, maxX - width]` 之外就當擺唔落。 */
function fitsX(left: number, width: number, minX: number, maxX: number): boolean {
  return left >= minX - EPS && left + width <= maxX + EPS;
}

/** `top`（氣泡上緣）落喺 `[minY, maxY - height]` 之外就當擺唔落。 */
function fitsY(top: number, height: number, minY: number, maxY: number): boolean {
  return top >= minY - EPS && top + height <= maxY + EPS;
}

/**
 * 計出氣泡應該點放。
 *
 * **① 水平（先做）**：靠左對齊（氣泡左緣 = 球左緣）→ 唔啱就靠右對齊（氣泡右緣 = 球右緣）
 * → 兩樣都唔啱就夾入 `[minX, maxX - width]`。
 * **② 垂直（後做）**：喺球下面 → 唔啱就翻到上面 → 都唔啱就夾入。
 *
 * 順序咁排嘅原因：右側錨點嘅球應該**淨係自己**向左翻，
 * 唔應該因為垂直方向要調而連水平對齊都亂掉。
 */
export function computeTooltipPlacement(input: TooltipPlacementInput): TooltipPlacement {
  const gap = input.gap ?? DEFAULT_GAP;
  const padding = input.padding ?? DEFAULT_PADDING;
  const preferredMaxWidth = input.preferredMaxWidth ?? DEFAULT_MAX_WIDTH;

  const { anchor, bubble, viewport } = input;
  const insets = viewport.insets ?? ZERO_INSETS;

  // 可視區（已經扣咗 safe area 同 padding）。
  const minX = viewport.offsetLeft + insets.left + padding;
  const maxX = viewport.offsetLeft + viewport.width - insets.right - padding;
  const minY = viewport.offsetTop + insets.top + padding;
  const maxY = viewport.offsetTop + viewport.height - insets.bottom - padding;

  // 可用空間（可能係 0，例如極窄視窗）。
  const availableWidth = Math.max(0, maxX - minX);
  const availableHeight = Math.max(0, maxY - minY);
  const maxWidth = Math.max(0, Math.min(preferredMaxWidth, availableWidth));
  /**
   * 氣泡過高（口徑說明寫得長、或者好矮嘅視窗）⇒ 收窄到可用高度並內部捲動，
   * 否則無論點擺都一定出界。
   */
  const maxHeight = availableHeight;

  // 量到嘅闊度可能仲係未收窄嘅舊值 ⇒ 以建議值為準（保證唔會超出可用空間）。
  const width = Math.max(0, Math.min(bubble.width, maxWidth));
  const height = Math.max(0, Math.min(bubble.height, maxHeight));

  // ── ① 水平 ────────────────────────────────────────────────────────────
  const alignLeftX = anchor.left;
  const alignRightX = anchor.right - width;

  let left: number;
  let align: TooltipAlign;
  let flippedX: boolean;
  let clampedX: boolean;

  if (fitsX(alignLeftX, width, minX, maxX)) {
    left = alignLeftX;
    align = "left";
    flippedX = false;
    clampedX = false;
  } else if (fitsX(alignRightX, width, minX, maxX)) {
    left = alignRightX;
    align = "right";
    flippedX = true;
    clampedX = false;
  } else {
    // 兩邊都擺唔落（通常係「氣泡闊過剩餘空間」）⇒ 夾入。
    left = clamp(alignLeftX, minX, Math.max(minX, maxX - width));
    clampedX = Math.abs(left - alignLeftX) > EPS;
    flippedX = clampedX;
    // 對齊語意：揀離夾位最近嗰種對齊（方便 CSS 之類判斷）。
    align = Math.abs(left - alignRightX) < Math.abs(left - alignLeftX) ? "right" : "left";
  }

  // ── ② 垂直 ────────────────────────────────────────────────────────────
  const belowY = anchor.bottom + gap;
  const aboveY = anchor.top - gap - height;

  let top: number;
  let side: TooltipSide;
  let flippedY: boolean;
  let clampedY: boolean;

  if (fitsY(belowY, height, minY, maxY)) {
    top = belowY;
    side = "bottom";
    flippedY = false;
    clampedY = false;
  } else if (fitsY(aboveY, height, minY, maxY)) {
    top = aboveY;
    side = "top";
    flippedY = true;
    clampedY = false;
  } else {
    top = clamp(belowY, minY, Math.max(minY, maxY - height));
    clampedY = Math.abs(top - belowY) > EPS;
    // 夾位落喺球下面就當「下面」，否則當「上面」。
    side = top < anchor.bottom ? "top" : "bottom";
    flippedY = side === "top";
  }

  return {
    side,
    align,
    left,
    top,
    maxWidth,
    maxHeight,
    flippedX,
    flippedY,
    clampedX,
    clampedY,
  };
}

/** `max-width: min(320px, calc(100vw - 24px))` 呢類 calc 值 → 數字（px）。 */
export function parseCssPixels(value: string | null | undefined): number {
  if (typeof value !== "string") return 0;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

let safeAreaProbe: HTMLElement | null = null;

/**
 * 讀 `env(safe-area-inset-*)`。
 *
 * ⚠️ `env()` 係 CSS 函式，JS 讀唔到 ⇒ 標準做法：用一個隱藏探針元素把四邊
 * padding 設成 `env(safe-area-inset-*)`，再讀 `getComputedStyle`。
 * 冇 `viewport-fit=cover` 嘅話四邊都係 0（正常唔會影響）。
 */
export function readSafeAreaInsets(): EdgeInsets {
  if (typeof document === "undefined" || !document.body) return ZERO_INSETS;
  if (!safeAreaProbe || !safeAreaProbe.isConnected) {
    const el = document.createElement("div");
    el.setAttribute("aria-hidden", "true");
    el.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
      "padding:env(safe-area-inset-top) env(safe-area-inset-right) " +
      "env(safe-area-inset-bottom) env(safe-area-inset-left);";
    document.body.appendChild(el);
    safeAreaProbe = el;
  }
  const cs = getComputedStyle(safeAreaProbe);
  return {
    top: parseCssPixels(cs.paddingTop),
    right: parseCssPixels(cs.paddingRight),
    bottom: parseCssPixels(cs.paddingBottom),
    left: parseCssPixels(cs.paddingLeft),
  };
}

/**
 * 讀目前可視範圍。
 *
 * ⚠️ 一律優先用 `visualViewport` —— iOS 鍵盤彈起／頁面 zoom 過之後，
 * `window.innerHeight` 依然係 layout viewport，會令氣泡「擺咗喺鍵盤底下」。
 */
export function readTooltipViewport(): PlacementViewport {
  if (typeof window === "undefined") {
    return { width: 0, height: 0, offsetTop: 0, offsetLeft: 0, insets: ZERO_INSETS };
  }
  const vv = window.visualViewport;
  return {
    width: vv ? vv.width : window.innerWidth,
    height: vv ? vv.height : window.innerHeight,
    offsetTop: vv ? vv.offsetTop : 0,
    offsetLeft: vv ? vv.offsetLeft : 0,
    insets: readSafeAreaInsets(),
  };
}
