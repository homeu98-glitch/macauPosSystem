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
 *    測試亦可以用完整收據物件而唔使逐個欄位剝走。函式**只讀 `items`**。
 */
export type PurchaseReceiptInput = {
  items: PurchaseItemInput[];
  [key: string]: unknown;
};

/** 一行「貨品細項」統計：以庫存品項（收據行嘅 name）為單位聚合。 */
export type ItemStat = {
  /** 顯示名（取該品項首見嘅寫法，保留原文大小寫）。 */
  name: string;
  /** 聚合 key（`name` 去空白轉小寫）——同名跨收據合併用。 */
  key: string;
  /** 累計數量（同一品項跨收據相加）。 */
  qty: number;
  /** 數量單位（如 kg / 包 / 罐）；同名品項多個單位時取第一個非空者。 */
  unit: string;
  /** 累計金額（Σ 單價 × 數量），單位 MOP。 */
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
 * · key = `name.trim().toLowerCase()` ⇒ 同名跨收據、跨供應商合併（如「墨魚滑」分兩次買）
 * · `qty` 直接相加：**假設同名品項單位一致**。單位唔一致時（例如「豬扒 2 包」＋「豬扒 5 kg」）
 *   相加冇意義，但現實中同名品項極少換單位；換咗名就會變另一行（同 POS 菜品排行同思路）。
 * · `amount` = Σ（`unit_price` × `quantity`）—— **唔用** `receipt.total_amount`，
 *   因為後者係整張收據總額，拆唔開到單一品項。
 * · 排序：**金額倒序**（同菜品排行新口徑一致），並列時按名稱升序（穩定、可重現）。
 *
 * ⚠️ 空名稱行（`name` 全空白）一律跳過，避免出「(未命名)」噪音行。
 */
export function buildItemStats(receipts: PurchaseReceiptInput[]): ItemStat[] {
  const map = new Map<string, ItemStat>();

  for (const r of receipts ?? []) {
    for (const it of r?.items ?? []) {
      const rawName = typeof it?.name === "string" ? it.name.trim() : "";
      if (!rawName) continue;
      const key = rawName.toLowerCase();
      const qty = toNumber(it.quantity, 0);
      const unitPrice = toNumber(it.unit_price, 0);
      const unit = typeof it?.quantity_unit === "string" ? it.quantity_unit.trim() : "";

      const cur = map.get(key);
      if (cur) {
        cur.qty += qty;
        cur.amount += unitPrice * qty;
        cur.lines += 1;
        if (!cur.unit && unit) cur.unit = unit;
      } else {
        map.set(key, {
          name: rawName,
          key,
          qty,
          unit,
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
 * `summary.items` 最多回幾行貨品細項。
 *
 * 取值理由：報表頁「買貨明細」卡預設顯示 5 行 + 「更多（共 N 款）」；
 * 留 20 行做 buffer＝一般小店（10–20 款常用食材）一次過睇完，唔需要展開，
 * 同時仍封頂 payload（詳見 `inventory-stats.ts` 嘅 `buildPurchaseSummary`）。
 */
export const PURCHASE_ITEMS_PREVIEW = 20;
