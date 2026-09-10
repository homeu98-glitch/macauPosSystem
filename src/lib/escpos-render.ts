import { EscPosSize, EscPosAlign, EscPosTemplateSnapshot, EscPosItemsLayout, PosOrder, QrPayload } from "@/lib/types";
import { discountedUnitPrice } from "@/lib/pos/discount";

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

/**
 * `PosOrder.items` → `PrintItemLine[]` 嘅**唯一真源**（2026-09-10）。
 *
 * 以前 `print-jobs.ts`（出紙）同 `print-center.tsx`（預覽）各自抄咗一份，
 * 兩份一旦唔同步就會出現「預覽 OK 但出紙唔同」（同當年交班單
 * `shiftDetailToLines` / `buildShiftPrintLines` 兩份 builder 分歧同一個死法）。
 * 而家兩邊都 call 呢條，保證「設計 == 預覽 == 出紙」。
 *
 * 價錢語義（同收據主行規則一致）：
 * - 冇折扣 → `price` = 基價 × quantity（加購 spec delta 由 spec row 個別加印，唔入主行）
 * - 有折扣 → `price` = 折後價 × quantity，另帶 `discountRate` / `originalUnitPrice` /
 *   `discountedUnitPrice` / `savingAmount`，等 renderer 加印「折扣率 X% 折讓 Y」反白行。
 */
export function toPrintItemLines(items: PosOrder["items"]): PrintItemLine[] {
  return items.map((it) => {
    const base = unitBasePrice(it);
    const rate = it.discountRate;
    const hasDiscount = typeof rate === "number" && rate > 0 && rate < 100;
    const discounted = hasDiscount ? discountedUnitPrice(base, rate) : base;
    const saving = hasDiscount ? Math.round((base - discounted) * it.quantity * 100) / 100 : 0;
    return {
      name: it.name,
      quantity: it.quantity,
      price: it.price > 0 ? Math.round(discounted * it.quantity) : undefined,
      discountRate: hasDiscount ? rate : undefined,
      originalUnitPrice: hasDiscount ? Math.round(base) : undefined,
      discountedUnitPrice: hasDiscount ? Math.round(discounted) : undefined,
      savingAmount: saving > 0 ? saving : undefined,
      specs: (it.selectedSpecs ?? []).map((spec) => formatSpecLine(spec)),
      note: it.note,
    };
  });
}

export type EscPosLine =
  | { kind: "text"; text: string; size: EscPosSize; bold: boolean; align: EscPosAlign }
  /**
   * 分格線（實體係一行 `-` 字符，`"-".repeat(cols)`）。
   *
   * `size` 決定嗰行 dash 嘅放大倍數（s = 1×、m = 雙闊、l = 2×2），
   * 同實機 `ESC ! n` / `GS ! n` 一致 —— m / l 雙闊會令 48 個 dash **wrap 成兩個物理行**。
   *
   * `cols` = 呢行要有幾多個 `-`（由 `EscPosTemplateSnapshot.cols` 帶入）；缺省 48。
   *
   * 來源：模板 `divider` 區塊嘅 `size`；舊模板冇嗰個區塊 → 用「繼承上一行 size」嘅舊行為
   * （對齊 print-relay APK `renderTemplateTicket` 嘅 sticky style）。
   */
  | { kind: "divider"; size: EscPosSize; cols: number }
  | {
      kind: "items";
      size: EscPosSize;
      bold: boolean;
      align: EscPosAlign;
      subSize: EscPosSize;
      items: PrintItemLine[];
      layout: EscPosItemsLayout;
      /**
       * card 排版「每件菜之間」嗰條分格線嘅字體大小；`null` = 唔印（模板 `divider` 區塊熄咗）。
       * 舊模板冇 `divider` 區塊 → 落 `size`（即繼承菜品主行 size，同實機一致）。
       */
      dividerSize: EscPosSize | null;
    }
  /** 收據二維碼（`qr_code` 區塊）。冇 `job.qr` 時 renderer 唔會產生呢一行。 */
  | { kind: "qr"; align: EscPosAlign; qr: QrPayload; size: EscPosSize };

/** `renderEscPosLines` 嘅額外輸入。items 以外嘅非文字區塊（而家得二維碼）放呢度。 */
export interface EscPosRenderExtras {
  /** 二維碼點陣（由 `encodeQrPayload(template.qrUrl)` 產生）；null = 唔印。 */
  qr?: QrPayload | null;
  /** 二維碼打印大小（`s` / `m` / `l`），隨 `template.qrSize` 帶過嚟；缺省 = `"m"`。 */
  qrSize?: EscPosSize;
}

/**
 * 80mm 熱敏紙每行可印嘅字符闊度（font A，203dpi，可印闊約 576 dots ÷ 12 dots/char = 48）。
 *
 * 收據 items 行要做「品名靠左 / 數量+價錢靠右」兩欄對齊，熱敏機冇 flex，
 * 只能靠空格 padding，所以一定要知道紙闊有幾多「格」。
 *
 * ⚠️ 呢個常數三個 repo 要一致（`companion-server.mjs` / `EscPosRenderer.kt`），
 * 否則同一張單喺唔同通道出紙會對唔齊。
 */
export const RECEIPT_PAPER_COLUMNS = 48;
/**
 * 58mm 機嘅每行字符數（可印闊約 48mm ÷ 1.5mm/char = 32）。
 * 同 `print hub` `EscPosRenderer.kt` 嘅 `PAPER_COLUMNS_58MM` 同一個數。
 *
 * ⚠️ 2026-09-10：呢個數以前**淨得 print hub 認**（`desktop-companion` 同 POS 預覽
 * 硬編 48），同一張 58mm 單喺三個通道會出三種闊度。而家由 POS 計一次寫入
 * `EscPosTemplateSnapshot.cols`，三個 repo 直接讀，唔好再各自判斷。
 */
export const RECEIPT_PAPER_COLUMNS_58MM = 32;

// 單據抬頭（label 唔印抬頭，62mm 標籤紙太細）
//
// ⚠️ 刻意**冇** `shift`：交班結算單嘅抬頭由模板嘅 `header` 區塊自己帶
// （`ShiftTemplate.headerText`，商家可改）。原因：呢個表要同三個 repo
// （POS / desktop-companion / print-agent-android）逐字一致，而下游兩個 repo
// 嘅 `TITLE` 表只認 receipt / label / kitchen —— 如果呢度加咗 `shift`，
// 就會出現「POS 預覽有抬頭、實紙冇」嘅不一致（違反「設計 == 預覽 == 出紙」）。
// 交班單亦唔應該借用 kitchen 嘅「＊＊＊ 廚房 ＊＊＊」。
// 要加就要三個 repo 同步加；目前用 header 區塊係零跨 repo 改動嘅做法。
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
  extras?: EscPosRenderExtras,
): EscPosLine[] {
  const lines: EscPosLine[] = [];
  const title = TITLE[snapshot.kind] ?? "";
  // 抬頭實機係 style("m", true) → line → reset()，所以抬頭之後 curSize 返落 "s"。
  if (title) lines.push({ kind: "text", text: title, size: "m", bold: true, align: "center" });

  /**
   * 模板 `divider` 區塊（設定型，自己唔 emit 行）。
   * - `undefined` = 舊模板冇呢個區塊 → 沿用「繼承上一行 size」舊行為（實機 sticky style）
   * - `EscPosSize` = 商家指定嘅分格線字體大小
   * - `null` = 區塊 visible=false → 全張單唔印分格線
   */
  const dividerBlock = snapshot.blocks.find((b) => b.id === "divider");
  const fixedDivider: EscPosSize | null | undefined = dividerBlock
    ? dividerBlock.visible
      ? dividerBlock.size
      : null
    : undefined;
  /** 印表機嘅 sticky 字體狀態（`ESC ! n` 殘留），用嚟模擬舊模板「分格線跟上一行放大」。 */
  let curSize: EscPosSize = "s";
  /**
   * 每行字符數：由快照帶入（`buildSnapshot` 計好），舊快照冇 → 48。
   * 分格線同網頁預覽嘅換行都靠佢，等三個 repo 出紙闊度一致。
   */
  const cols = snapshot.cols ?? RECEIPT_PAPER_COLUMNS;
  /** fixedDivider === null（區塊熄）→ 唔 push；undefined（舊模板）→ 用 fallback。 */
  const pushDivider = (fallback: EscPosSize) => {
    const size = fixedDivider === undefined ? fallback : fixedDivider;
    if (size === null) return;
    lines.push({ kind: "divider", size, cols });
  };

  for (const b of snapshot.blocks) {
    if (!b.visible) continue;
    // 分格線係設定型區塊：淨提供 size / 開關，唔會自己印一行（位置由 items 自動線決定）。
    if (b.id === "divider") continue;
    if (b.id === "items") {
      pushDivider(curSize); // 實機：印線前冇 style() → 繼承上一個區塊嘅 size
      lines.push({
        kind: "items",
        size: b.size,
        bold: b.bold,
        align: b.align,
        subSize: b.subSize ?? "s",
        items,
        layout: b.layout ?? "card",
        // card 每件菜之間嗰條線：實機紧跟主行（`style(b.size)` 未 reset）→ 舊模板 fallback = b.size
        dividerSize: fixedDivider === undefined ? b.size : fixedDivider,
      });
      // 實機：結尾嗰條線會繼承「最後 emit 嗰行」嘅 size。
      // card 排版每件菜之間（最後一件除外）會 `style("s")` 印空行 → 變細字；
      // 否則睇最後一件菜有冇規格 / 備註（`subSize`），冇就仲係主行嘅 `size`。
      const isCard = (b.layout ?? "card") === "card";
      const lastItem = items[items.length - 1];
      const hasSubLine = !!lastItem && ((lastItem.specs?.length ?? 0) > 0 || !!lastItem.note);
      curSize = isCard && items.length > 1 ? "s" : hasSubLine ? (b.subSize ?? "s") : b.size;
      pushDivider(curSize);
      continue;
    }
    // 二維碼：內容唔喺 content（嗰度只放純文字），而係讀 extras.qr。
    // 網址空白 / 編碼失敗 → qr 係 null → 直接略過，唔會留空框。
    if (b.id === "qr_code") {
      const qr = extras?.qr ?? null;
      if (!qr) continue;
      lines.push({ kind: "qr", align: b.align, qr, size: extras?.qrSize ?? "m" });
      // 實機 qrRaster 前會 resetMagnify() → 放大狀態清走，之後嘅線/字返落細
      curSize = "s";
      continue;
    }
    const text = content?.[b.id];
    if (!text) continue;
    lines.push({ kind: "text", text, size: b.size, bold: b.bold, align: b.align });
    curSize = b.size;
  }
  return lines;
}

// 預覽用：字型大小 → px（thermal 只有 3 檔，預覽用近似 px 表達）
// l=22 ≈ 2× s，貼近實際 ESC 雙高雙寬（2×2）；m=14≈雙寬視覺。見 docs/70。
export const SIZE_PX: Record<EscPosSize, number> = { s: 11, m: 14, l: 22 };

export const SIZE_LABEL: Record<EscPosSize, string> = { s: "細", m: "中", l: "大" };
