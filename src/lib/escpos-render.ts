import { EscPosSize, EscPosAlign, EscPosTemplateSnapshot, EscPosItemsLayout } from "@/lib/types";

/**
 * `PrintItemLine`：每件菜品打印時用嘅扁平資料。
 * 預覽（EscPosPreview）同 APK / Companion 嘅 renderer 都讀呢個結構，
 * 所以**加新 field 後必須 audit `print-bridge/native.ts:56-65` 同 `companion-server.mjs`
 * 嘅 payload map**，否則新 field 唔會去到 APK / Companion（docs/82 §18+20）。
 *
 * Optional + 數值類型：缺省即「數據未提供」，唔強求每個 caller 都填。
 */
export type PrintItemLine = {
  name: string;
  quantity: number;
  /** 主行顯示價：折後單價 × quantity（companion / android 已支援；缺省 = 舊版）。 */
  price?: number;
  specs?: string[];
  note?: string;
  /** 單品折扣百分比（0-100）。80 = 收 80 元 / 原價 100。undefined = 冇折扣。 */
  discountRate?: number;
  /**
   * 基價（單件原價，未扣 spec delta、未套 discountRate）。
   * 收據「主行菜價」喺有 discountRate 時會拆兩欄：「原價 $X / 折後 $Y」。
   * 冇 discountRate 就直接用 `price`。
   */
  originalUnitPrice?: number;
  /**
   * 折後每件單價（已套 discountRate）。同 `price / quantity` 數值一致，
   * 但獨立保留可以畀 renderer 唔使行除法。
   */
  discountedUnitPrice?: number;
  /**
   * 單品折讓（原價 − 折後）× quantity，金額。0 = 冇折讓唔顯示。
   * 收據「單品折扣明細」區塊會按呢個值生成「折讓 $X」一行（仿 57.doc）。
   */
  savingAmount?: number;
};

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

/**
 * 從 OrderItem 嘅 final unit price（同已選規格嘅 Σ priceDelta）倒推菜品「基價」。
 *
 * 收據主行印「菜品原價 × quantity」唔印 final 價，避免同下面 spec row（已經個別加印
 * `$X`）重複收費：招牌牛三寶 基價 95 + 加購 燙青菜 +10 → 主行 `$95`、spec row `加購:燙青菜 $10`
 *（而非主行 `$105`、spec row 仍 `$10`）。
 *
 * 冇 specs / specs 全 0 delta → 直接用 it.price（即基價 = final 價）。
 *
 * ⚠️ 只用於收據預覽，**唔動** OrderItem / PrintJob 持久資料：廚房單（kitchen builder）
 * 唔印價、companion / android 未支援 `price` 欄位，所以實際熱敏紙冇分別（docs/82 收據改進）。
 */
export function unitBasePrice(it: { price: number; selectedSpecs?: Array<{ priceDelta?: number }> }): number {
  const deltaSum = (it.selectedSpecs ?? []).reduce(
    (sum, s) => sum + Number(s.priceDelta ?? 0),
    0,
  );
  return Math.max(0, it.price - deltaSum);
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
