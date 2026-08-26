import { EscPosSize, EscPosAlign, EscPosTemplateSnapshot, EscPosItemsLayout } from "@/lib/types";

export type PrintItemLine = { name: string; quantity: number; specs?: string[]; note?: string };

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
export const SIZE_PX: Record<EscPosSize, number> = { s: 11, m: 14, l: 18 };

export const SIZE_LABEL: Record<EscPosSize, string> = { s: "細", m: "中", l: "大" };
