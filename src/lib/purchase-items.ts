/**
 * 買貨「貨品細項」聚合嘅**純函式**（零 import）。
 *
 * 🔴 為何要另開一個檔而唔係塞入 `inventory-stats.ts`：
 * 本專案嘅 `npm test` 係 `node --test`，**唔識解析 `@/` alias**。所以只有
 * 「零 import」嘅模組先可以被測試檔直接 import（見 docs/113 同 CLAUDE.md）。
 * `inventory-stats.ts` 有 `@/lib/ledger/...` import ⇒ 一 import 就爆。
 *
 * 呢個檔嘅職責只有一個：**由收據行算出「貨品細項」排行**。
 * 刻意唔碰 React／fetch／localStorage。
 *
 * ── 2026-10-05 J 要求 ──────────────────────────────────────────────
 * 報表頁「買貨明細」原本顯示**供貨商分拆**，J 要求改為**貨品細項**，
 * 並以庫存內的「品項」作為顯示單位。理由：供貨商分拆睇唔到「錢花喺邊款貨」，
 * 對控制成本冇用；品項排行才睇得出邊款食材食錢。
 */

/**
 * ── 2026-10-17 J 拍板：多幣值（MOP／HKD／RMB…）───────────────────
 * 收據各自帶一個幣值。聚合**必須**分幣值：
 * · 同名品項跨幣值 ⇒ **兩行**（唔可以加埋——MOP 103 + RMB 66 加埋做
 *   一個「MOP 169」係假數，加權平均單價亦無意義）；
 * · 每行帶自己幣值，UI 按幣值顯示；合計逐幣值分開（見
 *   {@link buildItemCurrencyTotals}）。
 * · 舊收據冇幣值 ⇒ fallback "MOP"（同 `/api/inventory/receipts` 讀取端
 *   `currency: getRaw("currency") || "MOP"` 一致，三處口徑要統一）。
 */

/** 收據行（同 `StatItem` 形狀一致，但**刻意唔 import**，避免引入 alias）。 */
export type PurchaseItemInput = {
  name: string;
  unit_price: number;
  quantity: number;
  quantity_unit?: string;
};

/**
 * 收據（只取聚合需要嘅欄位）。
 *
 * ⚠️ 其餘欄位（`id` / `merchant_name` / `total_amount` / `payment_status` …）刻意
 *    用 index signature 放行 —— 令真實嘅 `StatReceipt` 可以直接傳入，
 *    測試亦可以用完整收據物件而唔使逐個欄位剝走。函式讀 `items` ＋ `currency`。
 */
export type PurchaseReceiptInput = {
  items: PurchaseItemInput[];
  [key: string]: unknown;
};

/**
 * 幣值正規化（**聚合端唯一規則**）——trim 後統一做大寫（避免 `mop` / `MOP`
 * 喺分組時變成兩組），空／未提供 ⇒ `"MOP"`。
 *
 * 🔴 必須同三處一致，唔可以各自寫一份：
 *    · `/api/inventory/receipts` 讀取端（`getRaw("currency") || "MOP"`）
 *    · `expense-inventory.ts` 嘅 `normalizeReceiptCurrency()`（寫入端）
 *    · 呢度（聚合端）
 */
export function normalizeItemCurrency(raw?: unknown): string {
  const v = typeof raw === "string" ? raw.trim() : "";
  return v ? v.toUpperCase() : "MOP";
}

/** 一行「貨品細項」統計：以「庫存品項 ＋ 幣值」為單位聚合。 */
export type ItemStat = {
  /** 顯示名（取該品項首見嘅寫法，保留原文大小寫）。 */
  name: string;
  /** 聚合 key（`name` 去空白轉小寫 ＋ 幣值）——同名同幣值跨收據合併用。 */
  key: string;
  /** 累計數量（同一品項同一幣值跨收據相加）。 */
  qty: number;
  /** 數量單位（如 kg / 包 / 罐）；同名品項多個單位時取第一個非空者。 */
  unit: string;
  /**
   * 幣值（MOP／HKD／RMB…）——2026-10-17 加。跟隨收據；
   * 舊收據冇幣值 ⇒ "MOP"。
   */
  currency: string;
  /** 累計金額（Σ 單價 × 數量），**同 row 嘅 currency 同幣值**。 */
  amount: number;
  /** 出現喺幾多個收據行（＝採購次數，非收據張數）。 */
  lines: number;
  /** 加權平均單價（amount ÷ qty）；qty 為 0 時為 0。 */
  avgPrice: number;
};

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/,/g, "").replace(/[^\d.-]/g, "").trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function round2(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/**
 * 貨品細項排行。
 *
 * ── 聚合口徑 ──────────────────────────────────────────────────────
 * · key = `name.trim().toLowerCase()` ＋ 幣值 ⇒ 同名**同幣值**跨收據、跨供應商合併
 *   （如「墨魚滑」分兩次買）；同名**唔同幣值** ⇒ 兩行（MOP 同 RMB 加埋無意義）。
 * · `qty` 直接相加：**假設同名同幣值品項單位一致**。單位唔一致時（例如「豬扒 2 包」
 *   ＋「豬扒 5 kg」）相加冇意義，但現實中同名品項極少換單位；換咗名就會變另一行
 *   （同 POS 菜品排行同思路）。
 * · `amount` = Σ（`unit_price` × `quantity`）—— **唔用** `receipt.total_amount`，
 *   因為後者係整張收據總額，拆唔開到單一品項。
 * · 排序：**金額倒序**（同菜品排行新口徑一致），並列時按名稱升序（穩定、可重現）。
 *   ⚠️ 跨幣值排序只係顯示次序，每行各自帶幣值，唔構成「加總」。
 *
 * ⚠️ 空名稱行（`name` 全空白）一律跳過，避免出「(未命名)」噪音行。
 */
export function buildItemStats(receipts: PurchaseReceiptInput[]): ItemStat[] {
  const map = new Map<string, ItemStat>();

  for (const r of receipts ?? []) {
    const cur = normalizeItemCurrency(r?.currency);
    for (const it of r?.items ?? []) {
      const rawName = typeof it?.name === "string" ? it.name.trim() : "";
      if (!rawName) continue;
      const key = `${rawName.toLowerCase()}::${cur}`;
      const qty = toNumber(it.quantity, 0);
      const unitPrice = toNumber(it.unit_price, 0);
      const unit = typeof it?.quantity_unit === "string" ? it.quantity_unit.trim() : "";

      const row = map.get(key);
      if (row) {
        row.qty += qty;
        row.amount += unitPrice * qty;
        row.lines += 1;
        if (!row.unit && unit) row.unit = unit;
      } else {
        map.set(key, {
          name: rawName,
          key,
          qty,
          unit,
          currency: cur,
          amount: unitPrice * qty,
          lines: 1,
          avgPrice: 0,
        });
      }
    }
  }

  return Array.from(map.values())
    .map((row) => ({
      ...row,
      qty: round2(row.qty),
      amount: round2(row.amount),
      avgPrice: row.qty > 0 ? round2(row.amount / row.qty) : 0,
    }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
}

/**
 * 貨品細項合計 —— **逐幣值**加總（2026-10-17 J 拍板：唔同幣值唔可以加埋做一個數）。
 *
 * 輸入係 {@link buildItemStats} 嘅輸出 ⇒ **每幣值加總必然等於 UI 逐行加總**
 * （2026-10-13「兩個合計對唔上」bug 嘅防線：一定要由同一份 rows 計，
 * 唔可以另行由收據計，否則捨入路徑唔同會差幾分錢）。
 *
 * 只有一種幣值時，UI 應該同以前一樣單行顯示（見報表頁）。
 */
export function buildItemCurrencyTotals(stats: ItemStat[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of stats ?? []) {
    const cur = normalizeItemCurrency(s?.currency);
    out[cur] = round2((out[cur] ?? 0) + (Number(s?.amount) || 0));
  }
  return out;
}

/**
 * `summary.items` 最多回幾行貨品細項。
 *
 * 取值理由：報表頁「買貨明細」卡預設顯示 5 行 + 「更多（共 N 款）」；
 * 留 20 行做 buffer＝一般小店（10–20 款常用食材）一次過睇完，唔需要展開，
 * 同時仍封頂 payload（詳見 `inventory-stats.ts` 嘅 `buildPurchaseSummary`）。
 */
export const PURCHASE_ITEMS_PREVIEW = 20;
