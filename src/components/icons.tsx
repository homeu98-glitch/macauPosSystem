/**
 * 輕量 SVG 圖標集合（冇外部依賴，避免引入 icon 庫）。
 * 所有圖標接受 `size` / `strokeWidth`，用 `currentColor` 上色，方便隨父層文字顏色變化。
 */

export function Check({ size = 16, strokeWidth = 2.5 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M5 12l4.5 4.5L19 7" />
    </svg>
  );
}

export function X({ size = 16, strokeWidth = 2.5 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M6 6l12 12M6 18L18 6" />
    </svg>
  );
}
