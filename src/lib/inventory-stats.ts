/**
 * 庫存（買貨）統計：移植自 expenseRecorder/lib/reporting.ts 的純函式，供庫存頁／報表頁／交班頁共用。
 * 月份計算改用原生 Date，避免引入 date-fns 依賴。
 * 僅做唯讀聚合，不寫入任何表。
 */
import { macauDateKey, type ReportRangeKey } from "@/lib/ledger/report-period";

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  on_delivery: "貨到付款",
  cash: "現金",
  card: "信用卡",
  transfer: "轉帳",
  unknown: "未知",
};

export type StatItem = {
  name: string;
  unit_price: number;
  quantity: number;
  quantity_unit?: string;
  product_type?: string | null;
};

export type StatReceipt = {
  id: string;
  merchant_name: string;
  receipt_date: string;
  total_amount: number;
  payment_status: string; // "paid" | "unpaid" | ...
  payment_method: string;
  items: StatItem[];
};

export type SupplierStat = { name: string; count: number; total: number };
export type MonthlyExpense = { key: string; name: string; amount: number };
export type TrendSummary = { up: number; down: number };
export type PaymentMethodBreakdown = { method: string; label: string; total: number; count: number };
export type PriceTrendPoint = { key: string; name: string; up: number; down: number };

export type PurchaseSummary = {
  total: number;
  paid: number;
  unpaid: number;
  count: number;
  supplierStats: SupplierStat[];
  monthlyExpenses: MonthlyExpense[];
  trend: TrendSummary;
  paymentMethodBreakdown: PaymentMethodBreakdown[];
  priceTrendSeries: PriceTrendPoint[];
};

export type PurchaseApiResponse = {
  ok: boolean;
  matched?: boolean;
  schemaReady?: boolean;
  receipts?: StatReceipt[];
  summary?: PurchaseSummary;
  message?: string;
  error?: string;
};

function round2(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/,/g, "").replace(/[^\d.-]/g, "").trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** 以澳門日曆判斷收據日期是否落在選取區間（receipt_date 為 YYYY-MM-DD）。 */
export function receiptDateMatchesRange(receiptDate: string, range: ReportRangeKey, now = new Date()): boolean {
  if (range === "all") return true;
  const key = macauDateKey(new Date(receiptDate));
  if (range === "today") return key === macauDateKey(now);
  if (range === "yesterday") return key === macauDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const days = range === "7d" ? 6 : 29; // 含今日共 7 / 30 天
  const startKey = macauDateKey(new Date(now.getTime() - days * 24 * 60 * 60 * 1000));
  return key >= startKey && key <= macauDateKey(now);
}

export function buildPurchaseSummary(receipts: StatReceipt[]): PurchaseSummary {
  let total = 0;
  let paid = 0;
  let unpaid = 0;
  for (const r of receipts) {
    const amt = normalizeNumber(r.total_amount, 0);
    total += amt;
    if (r.payment_status === "paid") paid += amt;
    else unpaid += amt;
  }
  return {
    total: round2(total),
    paid: round2(paid),
    unpaid: round2(unpaid),
    count: receipts.length,
    supplierStats: buildSupplierStats(receipts),
    monthlyExpenses: buildMonthlyExpenses(receipts, 6),
    trend: buildTrendSummary(receipts),
    paymentMethodBreakdown: buildPaymentMethodBreakdown(receipts),
    priceTrendSeries: buildPriceTrendSeries(receipts, 6),
  };
}

export function buildSupplierStats(receipts: StatReceipt[]): SupplierStat[] {
  const totals = new Map<string, { name: string; count: number; total: number }>();
  for (const r of receipts) {
    const current = totals.get(r.merchant_name) ?? { name: r.merchant_name, count: 0, total: 0 };
    current.count += 1;
    current.total += normalizeNumber(r.total_amount, 0);
    totals.set(r.merchant_name, current);
  }
  return Array.from(totals.values())
    .map((row) => ({ ...row, total: round2(row.total) }))
    .sort((a, b) => b.total - a.total);
}

export function buildPaymentMethodBreakdown(receipts: StatReceipt[]): PaymentMethodBreakdown[] {
  const totals = new Map<string, { total: number; count: number }>();
  for (const r of receipts) {
    const method = r.payment_method || "unknown";
    const current = totals.get(method) ?? { total: 0, count: 0 };
    current.total += normalizeNumber(r.total_amount, 0);
    current.count += 1;
    totals.set(method, current);
  }
  return Array.from(totals.entries())
    .map(([method, v]) => ({
      method,
      label: PAYMENT_METHOD_LABEL[method] ?? method,
      total: round2(v.total),
      count: v.count,
    }))
    .sort((a, b) => b.total - a.total);
}

export function buildMonthlyExpenses(receipts: StatReceipt[], months = 6): MonthlyExpense[] {
  const now = new Date();
  const buckets = new Map<string, number>();
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!buckets.has(key)) {
      buckets.set(key, 0);
      keys.push(key);
    }
  }
  for (const r of receipts) {
    const d = new Date(r.receipt_date);
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + normalizeNumber(r.total_amount, 0));
  }
  return keys.map((key) => ({
    key,
    name: `${new Date(`${key}-01`).getMonth() + 1}月`,
    amount: round2(buckets.get(key) ?? 0),
  }));
}

export function buildPriceTrendSeries(receipts: StatReceipt[], months = 6): PriceTrendPoint[] {
  const now = new Date();
  const buckets = new Map<string, { up: number; down: number }>();
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!buckets.has(key)) {
      buckets.set(key, { up: 0, down: 0 });
      keys.push(key);
    }
  }
  const rows = buildItemRows(receipts);
  for (const row of rows) {
    if (row.direction !== "up" && row.direction !== "down") continue;
    const d = new Date(row.receipt_date);
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const bucket = buckets.get(key);
    if (!bucket) continue;
    if (row.direction === "up") bucket.up += 1;
    else bucket.down += 1;
  }
  return keys.map((key) => ({
    key,
    name: `${new Date(`${key}-01`).getMonth() + 1}月`,
    up: buckets.get(key)?.up ?? 0,
    down: buckets.get(key)?.down ?? 0,
  }));
}

type ItemRow = { name: string; unit_price: number; receipt_date: string; change_percent: number | null; direction: "up" | "down" | "same" | "new" };

export function buildItemRows(receipts: StatReceipt[]): ItemRow[] {
  const grouped = new Map<string, Array<{ name: string; unit_price: number; receipt_date: string }>>();
  for (const r of receipts) {
    for (const it of r.items) {
      const key = it.name.trim().toLowerCase();
      if (!key) continue;
      const bucket = grouped.get(key) ?? [];
      bucket.push({ name: it.name, unit_price: normalizeNumber(it.unit_price, 0), receipt_date: r.receipt_date });
      grouped.set(key, bucket);
    }
  }

  const rows: ItemRow[] = [];
  grouped.forEach((items) => {
    const sorted = [...items].sort((a, b) => Date.parse(b.receipt_date) - Date.parse(a.receipt_date));
    sorted.forEach((item, index) => {
      const previous = sorted[index + 1];
      if (!previous || previous.unit_price === 0) {
        rows.push({ ...item, change_percent: null, direction: "new" });
        return;
      }
      const currentPrice = item.unit_price;
      const previousPrice = previous.unit_price;
      if (previousPrice === 0) {
        rows.push({ ...item, change_percent: null, direction: "new" });
        return;
      }
      const changePercent = ((currentPrice - previousPrice) / previousPrice) * 100;
      rows.push({
        ...item,
        change_percent: changePercent,
        direction: changePercent > 0 ? "up" : changePercent < 0 ? "down" : "same",
      });
    });
  });

  return rows.sort((a, b) => Date.parse(b.receipt_date) - Date.parse(a.receipt_date));
}

export function buildTrendSummary(receipts: StatReceipt[]): TrendSummary {
  const comparable = buildItemRows(receipts).filter((row) => row.direction === "up" || row.direction === "down");
  const seenNames = new Set<string>();
  let up = 0;
  let down = 0;
  for (const row of comparable) {
    const key = row.name.trim().toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    if (row.direction === "up") up += 1;
    else if (row.direction === "down") down += 1;
  }
  return { up, down };
}

/** 客戶端封裝：呼叫庫存收據 API 並取回買貨統計（含 schemaReady/matched 降級）。 */
export async function fetchPurchaseSummary(account: string, range: ReportRangeKey): Promise<PurchaseApiResponse | null> {
  try {
    const res = await fetch(`/api/inventory/receipts?account=${encodeURIComponent(account)}&range=${range}`);
    if (!res.ok) return null;
    const json = (await res.json()) as PurchaseApiResponse;
    return json.ok ? json : null;
  } catch {
    return null;
  }
}
