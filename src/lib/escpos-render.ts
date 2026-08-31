import { EscPosSize, EscPosAlign, EscPosTemplateSnapshot, EscPosItemsLayout } from "@/lib/types";

export type PrintItemLine = { name: string; quantity: number; price?: number; specs?: string[]; note?: string };

/**
 * 把 groupName / optionLabel / priceDelta 攤平成收據／廚房單用嘅單行字串。priceDelta > 0 會自動加 ` $X` 後綴；
 * priceDelta === 0 唔加，唔加符號，避免冇加購嘅規格被誤會有收費。
 */
export function formatSpecLine(spec: { groupName: string; optionLabel: string; priceDelta?: number }): string {
  const head = `${spec.groupName}:${spec.optionLabel}`;
  const delta = Number(spec.priceDelta ?? 0);
  if (!Number.isFinite(delta) || delta === 0) return head;
  const abs = Math.abs(Math.round(delta));
  return delta < 0 ? `${head} -${abs}` : `${head} $${abs}`;
}

export type EscPosLine =
  | { kind: "text"; text: string; size: EscPosSize; bold: boolean; align: EscPosAlign }
  | { kind: "divider" }
  | { kind: "items"; size: EscPosSize; bold: boolean; align: EscPosAlign; subSize: EscPosSize; items: PrintItemLine[]; layout: EscPosItemsLayout };

// 單據抬頭（label 唔印抬頭，62mm 標籤紙太細）
const TITLE: Record<string, string> = {
  receipt: "＊＊＊ 收據 ＊＊＊",
  label: "",
  kitchen: "＊＊＊ 廚房 ＊＊＊",
};

/**
 * 核心渲染演算法：template 快照 + 靜態內容 + 菜品陣列 → 有序行列。
 * 網頁預覽（escpos-preview.tsx）同桌面 Companion / Android（各自 ESC/POS 實作）都跟呢套規則，
 * 所以「設計介面 == 螢幕預覽 == 實際打印」三者 100% 一致。
 */
export function renderEscPosLines(
  snapshot: EscPosTemplateSnapshot,
  content: Record<string, string> | undefined,
  items: PrintItemLine[],
): EscPosLine[] {
  const lines: EscPosLine[] = [];
  const title = TITLE[snapshot.kind] ?? "";
  if (title) lines.push({ kind: "text", text: title, size: "m", bold: true, align: "center" });

  for (const b of snapshot.blocks) {
    if (!b.visible) continue;
    if (b.id === "items") {
      lines.push({ kind: "divider" });
      lines.push({ kind: "items", size: b.size, bold: b.bold, align: b.align, subSize: b.subSize ?? "s", items, layout: b.layout ?? "card" });
      lines.push({ kind: "divider" });
    } else {
      const text = content?.[b.id];
      if (!text) continue;
      lines.push({ kind: "text", text, size: b.size, bold: b.bold, align: b.align });
    }
  }
  return lines;
}

// 預覽用：字型大小 → px（thermal 只有 3 檔，預覽用近似 px 表達）
// l=22 ≈ 2× s，貼近實際 ESC 雙高雙寬（2×2）；m=14≈雙寬視覺。見 docs/70。
export const SIZE_PX: Record<EscPosSize, number> = { s: 11, m: 14, l: 22 };

export const SIZE_LABEL: Record<EscPosSize, string> = { s: "細", m: "中", l: "大" };
