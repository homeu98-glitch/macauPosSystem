/**
 * Ledger 商家接單設定 —— `get_merchant_order_config` /
 * `merchant_set_order_enabled` / `merchant_set_auto_accept` 回傳值嘅
 * **防禦性解析**（純函式、零 runtime 依賴）。
 *
 * ── 點解要獨立一個檔 ────────────────────────────────────────────────────
 * 三支 RPC 都係回傳 `jsonb`（一整份 order config），但：
 *   1. 欄位命名 Ledger 未完全鎖死（`merchant_enabled` / `merchantEnabled` 兩種都出現過）；
 *   2. RPC 可能因為 migration 未上而**缺欄**；
 *   3. 解析結果直接決定「鋪頭係開定關」—— 判錯等於收銀睇錯狀態，
 *      甚至以為自己開咗店但客人落唔到單。
 *
 * 所以抽做零依賴純模組，用 `node --test` 直接測（見 `order-config-parse.test.ts`）。
 *
 * ⚠️ 鐵則：`merchantEnabled` **唔可以**喺缺欄時靜靜當 `false` 或者 `true` ——
 * 兩個方向都會講大話（一個話你停業、一個話你營業）。缺欄一律返 `null`，
 * 由 UI 顯示「未接通」並停用開關。
 */

export type MerchantOrderConfig = {
  /** 店家「開啟接單」主開關（`merchants.merchant_enabled`）。`null` = 讀唔到，唔可以亂猜。 */
  merchantEnabled: boolean | null;
  /** 自動接單。缺欄時返 `false`（同 POS 本地 default 一致，向來都係咁）。 */
  autoAccept: boolean;
  /** 平台是否核可訂單系統（`admin_enabled`）。`false` 時店員開接單都收唔到會員通單。 */
  adminEnabled: boolean | null;
  /** 而家係唔係喺接單時段內（`hours_enabled=false` 則全天 true）。 */
  openNow: boolean | null;
  /** 有冇啟用接單時段。`false` = 全天接單。 */
  hoursEnabled: boolean | null;
  /** 餘額扣點付款有冇開。開店失敗最常見原因就係兩種付款都關住。 */
  allowBalanceDeduct: boolean | null;
  /** 到店付款有冇開。 */
  allowPayInStore: boolean | null;
  /** 商家狀態（`active` / `suspended` …）。 */
  status: string | null;
};

/** RPC 回傳缺欄時嘅保守值：**唔**假裝自己知。 */
export const UNKNOWN_ORDER_CONFIG: MerchantOrderConfig = {
  merchantEnabled: null,
  autoAccept: false,
  adminEnabled: null,
  openNow: null,
  hoursEnabled: null,
  allowBalanceDeduct: null,
  allowPayInStore: null,
  status: null,
};

type KeyAliases = readonly string[];

const MERCHANT_ENABLED_KEYS: KeyAliases = ["merchant_enabled", "merchantEnabled"];
const AUTO_ACCEPT_KEYS: KeyAliases = ["auto_accept", "autoAccept"];
const ADMIN_ENABLED_KEYS: KeyAliases = ["admin_enabled", "adminEnabled"];
const OPEN_NOW_KEYS: KeyAliases = ["open_now", "openNow"];
const HOURS_ENABLED_KEYS: KeyAliases = ["hours_enabled", "hoursEnabled"];
const ALLOW_BALANCE_KEYS: KeyAliases = ["allow_balance_deduct", "allowBalanceDeduct"];
const ALLOW_IN_STORE_KEYS: KeyAliases = ["allow_pay_in_store", "allowPayInStore"];
const STATUS_KEYS: KeyAliases = ["status", "merchant_status", "merchantStatus"];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 拆開 `[ {...} ]`（PostgREST 有時當 table RPC 回傳）同 `{ config: {...} }` 包裝。 */
function unwrapConfig(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) {
    for (const entry of data) {
      const row = unwrapConfig(entry);
      if (row) return row;
    }
    return null;
  }

  const record = asRecord(data);
  if (!record) return null;

  // 有啲 RPC 會包一層（`{ config: {...} }` / `{ data: {...} }`）—— 是但一邊有料就用嗰邊。
  const nested = asRecord(record.config) ?? asRecord(record.data) ?? asRecord(record.order_config);
  if (nested && Object.keys(record).length <= 2) return nested;

  return record;
}

function readBool(record: Record<string, unknown>, keys: KeyAliases): boolean | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
    // Ledger 部分欄位用 0/1 或 "true"/"false" 字串落庫（pg jsonb 未必轉型）——
    // 明確轉換，唔好靠 JS truthy（`"false"` 係 truthy，會反轉成「開」）。
    if (value === 0 || value === 1) return value === 1;
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return null;
}

function readString(record: Record<string, unknown>, keys: KeyAliases): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** 解析 RPC 回傳嘅整份 order config。任何缺欄都以 `null` 表示「唔知」。 */
export function parseMerchantOrderConfig(data: unknown): MerchantOrderConfig {
  const record = unwrapConfig(data);
  if (!record) return { ...UNKNOWN_ORDER_CONFIG };

  return {
    merchantEnabled: readBool(record, MERCHANT_ENABLED_KEYS),
    autoAccept: readBool(record, AUTO_ACCEPT_KEYS) ?? false,
    adminEnabled: readBool(record, ADMIN_ENABLED_KEYS),
    openNow: readBool(record, OPEN_NOW_KEYS),
    hoursEnabled: readBool(record, HOURS_ENABLED_KEYS),
    allowBalanceDeduct: readBool(record, ALLOW_BALANCE_KEYS),
    allowPayInStore: readBool(record, ALLOW_IN_STORE_KEYS),
    status: readString(record, STATUS_KEYS),
  };
}

/**
 * PostgREST 揾唔到函式（`PGRST202` / `Could not find the function … in the schema cache`）。
 *
 * 呢個唔係「操作失敗」，係「Ledger 未提供呢支 RPC / 前端接錯 Supabase 專案」。
 * 兩者 UI 反應唔同：前者應該收埋成個開關，唔好畀收銀見一粒撳完冇反應嘅掣。
 */
export function isRpcMissingError(message: string | null | undefined): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes("could not find the function") ||
    lower.includes("schema cache") ||
    lower.includes("pgrst202") ||
    lower.includes("function public.") ||
    (lower.includes("does not exist") && lower.includes("function"))
  );
}

export type OrderConfigBlocker = {
  /** 一句短原因（UI 直接顯示）。 */
  label: string;
  /** 只有 `merchant_enabled` 係店員可以自己解，其餘要搵平台／店主。 */
  fixableByStaff: boolean;
};

/**
 * 列出「會員通而家落唔到新單」嘅所有原因（可能同時幾條）。
 *
 * 用途：開關店掣隔籬顯示「點解開咗都冇單」，避免店員以為 POS 壞。
 * 缺欄（`null`）一律當「無從判斷」→ 唔列，免得亂嚇人。
 */
export function describeOrderConfigBlockers(config: MerchantOrderConfig): OrderConfigBlocker[] {
  const blockers: OrderConfigBlocker[] = [];

  if (config.adminEnabled === false) {
    blockers.push({ label: "平台未核可線上訂單", fixableByStaff: false });
  }
  if (config.status !== null && config.status !== "active") {
    blockers.push({ label: `商家帳號狀態：${config.status}`, fixableByStaff: false });
  }
  if (config.merchantEnabled === false) {
    blockers.push({ label: "已暫停接單", fixableByStaff: true });
  }
  if (config.openNow === false && config.hoursEnabled === true) {
    blockers.push({ label: "非接單時段（休息中）", fixableByStaff: false });
  }

  return blockers;
}

/** 兩種線上付款都關住 → `merchant_set_order_enabled(true)` 一定會被拒。 */
export function hasAnyOnlinePayment(config: MerchantOrderConfig): boolean | null {
  if (config.allowBalanceDeduct === null && config.allowPayInStore === null) return null;
  return config.allowBalanceDeduct === true || config.allowPayInStore === true;
}
