/**
 * 零售付款方式 + 拆分付款 —— **純函式，零 runtime 依賴**。
 *
 * 【為何要呢個檔】
 * 現有 `PosRules.paymentMethods` 係**自由文字 `string[]`**（`types.ts:180`），
 * 零售要知「邊個方法要收錢找零 / 開錢箱 / 接終端」，字串表達唔到。
 * 🔴 但**唔可以直接換型別** —— 有存量門店設定，換咗就會令現有商戶嘅付款方式消失
 * （同 `label.paperSize` 當年靜靜被剷走係同一個坑，見 docs/113）。
 * 所以：新欄位 `retailPaymentMethods?`（選填、有值優先），
 * 舊字串經 `normalizeRetailPaymentMethods()` 兼容轉換。
 *
 * 【拆分付款】`allowSplitBill`（`types.ts:176`）一直只係宣告、**全 repo 冇實作**。
 * 零售幾乎必需（現金 + 電子混合），所以呢度提供餘額 / 找零 / 完成判斷嘅純函式。
 */

import type { RetailPaymentMethod, SplitPaymentEntry } from "@/lib/retail/types";

const round2 = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 100) / 100;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** 金額比較容差：避免 0.1 + 0.2 !== 0.3 之類嘅 FP 假陽性 */
export const MONEY_EPSILON = 0.005;

/** 舊字串 → 付款方式種類嘅關鍵字對照（順序有意義：先配到先贏） */
const KIND_KEYWORDS: Array<{ kind: RetailPaymentMethod["kind"]; keys: string[] }> = [
  { kind: "member_balance", keys: ["會員", "餘額", "member", "balance", "積分", "points"] },
  { kind: "voucher", keys: ["券", "voucher", "coupon", "禮券", "現金券", "現金卷"] },
  {
    kind: "ewallet",
    keys: ["mpay", "m-pay", "澳門通", "支付寶", "alipay", "微信", "wechat", "雲閃付", "八達通", "電子", "掃碼", "qr"],
  },
  { kind: "card", keys: ["卡", "card", "visa", "master", "中銀", "銀聯", "unionpay", "信用", "借記", "debit"] },
  { kind: "cash", keys: ["現金", "现金", "cash", "現鈔"] },
];

/** 由文字（舊設定）猜付款方式種類 */
export function guessPaymentKind(label: string): RetailPaymentMethod["kind"] {
  const s = String(label ?? "").toLowerCase();
  for (const row of KIND_KEYWORDS) {
    if (row.keys.some((k) => s.includes(k.toLowerCase()))) return row.kind;
  }
  return "other";
}

/** 現金類先要「實收 / 找零 / 開錢箱」 */
export function kindRequiresTendered(kind: RetailPaymentMethod["kind"]): boolean {
  return kind === "cash";
}

/**
 * 兼容讀取付款方式設定。
 *
 * 接受：`RetailPaymentMethod[]`、`string[]`、兩者混合、垃圾值。
 * 舊字串嘅 `id` 用 `legacy:<label>` —— **穩定**（唔用時間戳），
 * 因為已存落 DB 嘅訂單會引用 `methodId`，id 一變就對唔返。
 * 同一 label 重複出現 → 只保留第一個（避免出兩個一樣嘅付款方式按鈕）。
 */
export function normalizeRetailPaymentMethods(raw: unknown): RetailPaymentMethod[] {
  if (!Array.isArray(raw)) return [];
  const out: RetailPaymentMethod[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    let method: RetailPaymentMethod | null = null;

    if (typeof item === "string") {
      const label = item.trim();
      if (!label) continue;
      const kind = guessPaymentKind(label);
      method = {
        id: `legacy:${label}`,
        label,
        kind,
        requiresTendered: kindRequiresTendered(kind),
        openDrawer: kind === "cash",
        integrated: false,
      };
    } else if (item && typeof item === "object") {
      const o = item as Partial<RetailPaymentMethod> & { id?: unknown; label?: unknown };
      const label = typeof o.label === "string" ? o.label.trim() : "";
      if (!label) continue;
      const kind = (o.kind ?? guessPaymentKind(label)) as RetailPaymentMethod["kind"];
      const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : `legacy:${label}`;
      method = {
        id,
        label,
        kind,
        requiresTendered: o.requiresTendered ?? kindRequiresTendered(kind),
        openDrawer: o.openDrawer ?? kind === "cash",
        integrated: o.integrated ?? false,
      };
    }

    if (!method) continue;
    if (seen.has(method.id)) continue;
    seen.add(method.id);
    out.push(method);
  }

  return out;
}

/** 由付款方式建立一筆收款 */
export function buildSplitEntry(
  method: Pick<RetailPaymentMethod, "id" | "label">,
  amount: number,
  tendered?: number,
): SplitPaymentEntry {
  const amt = round2(Math.max(0, num(amount)));
  const entry: SplitPaymentEntry = {
    methodId: method.id,
    label: method.label,
    amount: amt,
  };
  if (tendered != null && Number.isFinite(tendered)) {
    const t = round2(Math.max(0, tendered));
    entry.tendered = t;
    entry.change = round2(Math.max(0, t - amt));
  }
  return entry;
}

/** 已收總額 */
export function splitPaidTotal(entries: readonly SplitPaymentEntry[]): number {
  return round2((entries ?? []).reduce((s, e) => s + Math.max(0, num(e.amount)), 0));
}

/** 尚欠（唔會回負數；多收請用 `splitOverpaid`） */
export function splitRemaining(total: number, entries: readonly SplitPaymentEntry[]): number {
  return round2(Math.max(0, num(total) - splitPaidTotal(entries)));
}

/** 多收金額（正常應該係 0；現金找零唔算多收） */
export function splitOverpaid(total: number, entries: readonly SplitPaymentEntry[]): number {
  return round2(Math.max(0, splitPaidTotal(entries) - num(total)));
}

/**
 * 收款完成判斷（**餘額歸零才可以完結**，docs/124 §R4）。
 * 容差 `MONEY_EPSILON`：避免 FP 誤差令「明明收夠都撳唔到完成」。
 */
export function isSplitSettled(
  total: number,
  entries: readonly SplitPaymentEntry[],
): boolean {
  return splitRemaining(total, entries) < MONEY_EPSILON;
}

/** 現金實收合計（開錢箱 / 交班對帳用） */
export function splitCashReceived(entries: readonly SplitPaymentEntry[]): number {
  return round2(
    (entries ?? []).reduce((s, e) => s + (e.tendered != null ? Math.max(0, num(e.tendered)) : 0), 0),
  );
}

/** 找零合計 */
export function splitChangeDue(entries: readonly SplitPaymentEntry[]): number {
  return round2((entries ?? []).reduce((s, e) => s + Math.max(0, num(e.change)), 0));
}

/** 加入一筆收款（同方法會合併金額，唔會出兩行一樣嘅） */
export function appendSplitEntry(
  entries: readonly SplitPaymentEntry[],
  entry: SplitPaymentEntry,
): SplitPaymentEntry[] {
  const list = [...(entries ?? [])];
  const idx = list.findIndex((e) => e.methodId === entry.methodId && e.tendered == null && entry.tendered == null);
  if (idx >= 0) {
    const merged = round2(list[idx].amount + Math.max(0, num(entry.amount)));
    list[idx] = { ...list[idx], amount: merged };
    return list;
  }
  list.push({ ...entry });
  return list;
}

/** 移除第 N 筆 */
export function removeSplitEntryAt(
  entries: readonly SplitPaymentEntry[],
  index: number,
): SplitPaymentEntry[] {
  const list = [...(entries ?? [])];
  if (index < 0 || index >= list.length) return list;
  list.splice(index, 1);
  return list;
}

/** 改第 N 筆金額（保留 tendered 就順手重算找零） */
export function setSplitEntryAmount(
  entries: readonly SplitPaymentEntry[],
  index: number,
  amount: number,
): SplitPaymentEntry[] {
  const list = [...(entries ?? [])];
  if (index < 0 || index >= list.length) return list;
  const amt = round2(Math.max(0, num(amount)));
  const cur = list[index];
  const next: SplitPaymentEntry = { ...cur, amount: amt };
  if (cur.tendered != null) next.change = round2(Math.max(0, cur.tendered - amt));
  list[index] = next;
  return list;
}

/**
 * 「一鍵補齊」：尚欠幾多，用最後揀嘅付款方式補齊。
 * 方便收銀：撳「現金」就直接把餘額全部入現金。
 */
export function suggestedTopUpAmount(
  total: number,
  entries: readonly SplitPaymentEntry[],
): number {
  return splitRemaining(total, entries);
}

export interface SplitValidation {
  ok: boolean;
  errors: string[];
}

/**
 * 完成收款前嘅驗證。
 *
 * 出事要**明確講原因**，唔可以靜默 disable 個掣（docs/113：狀態唔准靜默）：
 * 尚欠幾多、邊一筆現金唔夠找零，都要寫出嚟。
 */
export function validateSplitPayment(
  total: number,
  entries: readonly SplitPaymentEntry[],
): SplitValidation {
  const errors: string[] = [];
  const list = entries ?? [];

  if (list.length === 0) errors.push("未加入任何收款");

  list.forEach((e, i) => {
    if (num(e.amount) <= 0) errors.push(`第 ${i + 1} 筆「${e.label}」金額係 0`);
    if (e.tendered != null && e.tendered + MONEY_EPSILON < num(e.amount)) {
      errors.push(`第 ${i + 1} 筆「${e.label}」實收少過應收，唔夠找零`);
    }
  });

  const remaining = splitRemaining(total, list);
  if (remaining >= MONEY_EPSILON) errors.push(`尚欠 $${remaining.toFixed(2)}`);

  const over = splitOverpaid(total, list);
  if (over >= MONEY_EPSILON) {
    const anyChange = splitChangeDue(list) > MONEY_EPSILON;
    if (!anyChange) errors.push(`多收 $${over.toFixed(2)}（非現金唔可以多收）`);
  }

  return { ok: errors.length === 0, errors };
}

/** 顯示用摘要：「現金 $300.00 + 澳門通 $149.00」 */
export function describeSplitSummary(entries: readonly SplitPaymentEntry[]): string {
  const list = entries ?? [];
  if (list.length === 0) return "未收款";
  return list.map((e) => `${e.label} $${num(e.amount).toFixed(2)}`).join(" + ");
}
