/**
 * POS 店員帳號＋權限 —— **純邏輯模組（零 import）**。
 *
 * ## 為何要呢個模組（2026-10-23）
 *
 * 商家要自己設定「邊個員工、做咩角色、睇得到邊幾頁、做得咩操作」。
 * Ledger 嗰邊只有 `merchant_staff.staff_role`（owner / staff），契約明文
 * 「勿 invent `role` 欄」，RPC 閘亦只有 `is_merchant_staff()` boolean
 * ⇒ **權限一定係 POS 本地嘅事**（見 docs/123 §0.5、docs/160）。
 *
 * ## 三條不變量（改任何一條之前先讀）
 *
 * ① **白名單正規化**：`normalizePosStaffPermissions()` 只認
 *    `POS_STAFF_PAGE_IDS` / `POS_STAFF_ACTION_IDS` 入面嘅 id。加新權限
 *    **一定要**同時加落呢兩個常數，否則 UI 勾咗、存得入 DB、但一讀出嚟
 *    就被靜靜剷走（本專案高頻 bug，見 `.workbuddy/memory/MEMORY.md`）。
 * ② **角色預設 = 缺欄嘅 fallback**：DB 只存「與預設不同」嘅值都安全；
 *    舊 row 冇某個新權限時，用角色預設，而唔係當 false（避免升級後
 *    忽然全店冇權限）。
 * ③ **店主唔入呢張表**：Ledger `staff_role = owner` 嘅人唔受店員權限限制，
 *    亦係唯一見得到「權限控制」頁嘅人。`role` 只准 `manager` / `cashier`。
 *
 * ## 為何零 import
 *
 * `node --test` 直接跑呢個檔（唔經 Next bundler）。契約測試會掃
 * `/^\s*import\s/`，防止將來有人手快加 value import 令整套測試靜默跑唔到。
 */

/** 店員角色。`admin`（店主）刻意唔喺度 —— 店主唔受店員權限層限制。 */
export type PosStaffRole = "manager" | "cashier";

export const POS_STAFF_ROLE_IDS = ["manager", "cashier"] as const;

export const POS_STAFF_ROLE_LABELS: Record<PosStaffRole, string> = {
  manager: "店長",
  cashier: "收銀員",
};

export const POS_STAFF_ROLE_HINTS: Record<PosStaffRole, string> = {
  manager: "可睇報表、退菜退款、改設備設定（預設全開）",
  cashier: "只落單／結帳／補打（預設收緊，可逐項放開）",
};

/**
 * 頁面可見性 —— id 對齊 `src/lib/pos/module-catalog.ts` 嘅 `SidebarModuleId`。
 *
 * ⚠️ 兩邊 id 必須一致：呢度係權限模型，module-catalog 係側欄真源。
 *    契約測試會對照（`staff-core.test.ts`）。
 */
export const POS_STAFF_PAGE_IDS = [
  "order",
  "orders",
  "delivery",
  "members",
  "prints",
  "reports",
  "soldout",
  "shift",
  "inventory",
] as const;

export type PosStaffPageId = (typeof POS_STAFF_PAGE_IDS)[number];

export const POS_STAFF_PAGE_LABELS: Record<PosStaffPageId, string> = {
  order: "點餐",
  orders: "訂單",
  delivery: "外送",
  members: "會員",
  prints: "打印",
  reports: "報表",
  soldout: "沽清",
  shift: "交班",
  inventory: "庫存",
};

/** 操作權限。高風險排前面（UI 亦照此順序顯示）。 */
export const POS_STAFF_ACTION_IDS = [
  "voidItem",
  "refundOrder",
  "reopenOrder",
  "applyDiscount",
  "reprintReceipt",
  "closeShift",
  "deviceSettings",
  // 2026-10-31：外送派單（叫車手）。會產生車手費（真金白銀），
  // 所以要有獨立權限，唔可以靠「有訂單頁權限」就自動有。
  "dispatchDelivery",
] as const;

export type PosStaffActionId = (typeof POS_STAFF_ACTION_IDS)[number];

export const POS_STAFF_ACTION_LABELS: Record<
  PosStaffActionId,
  { label: string; hint: string }
> = {
  voidItem: { label: "退菜（刪單品）", hint: "刪走已落嘅菜；會影響營業額，屬舞弊高風險位" },
  refundOrder: { label: "退款／退單", hint: "整單退款；涉及現金流出" },
  reopenOrder: { label: "返結（重開已結帳單）", hint: "已結帳單再打開改內容；目前任何員工都可返結，預設保持" },
  applyDiscount: { label: "折扣／改價", hint: "手動加折扣或改單品價錢" },
  reprintReceipt: { label: "補打收據", hint: "重印帳單／收據" },
  closeShift: { label: "交班結帳", hint: "結束自己嘅班次並埋數" },
  deviceSettings: { label: "設備／菜單設定", hint: "打印機、菜單、桌台、支付方式等設定頁" },
  dispatchDelivery: {
    label: "外送派單（叫車手）",
    hint: "喺訂單撳「派送」把單交畀車手平台；會產生車手費",
  },
};

/** 單店最多店員數（防止一次過拉爆清單；亦足以覆蓋小店排班）。 */
export const POS_STAFF_MAX_PER_STORE = 40;

/** 連續錯 PIN 幾次就鎖。 */
export const POS_STAFF_MAX_FAILED_ATTEMPTS = 5;

/** 鎖幾耐（毫秒）。 */
export const POS_STAFF_LOCK_MS = 15 * 60 * 1000;

/** 店員權限（DB `permissions` jsonb 嘅形狀）。 */
export type PosStaffPermissions = {
  pages: Record<PosStaffPageId, boolean>;
  actions: Record<PosStaffActionId, boolean>;
};

/** 對外 DTO（**永不包含** pin_hash / pin_salt）。 */
export type PosStaffDto = {
  id: string;
  storeId: string;
  staffNo: string;
  name: string;
  role: PosStaffRole;
  permissions: PosStaffPermissions;
  active: boolean;
  mustChangePin: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * 角色預設權限。
 *
 * 🔴 設計原則：**cashier 嘅預設 = 今日實際行為**，唔可以靜靜收緊咗營運
 *    （例如返結：今日任何員工都做得到，所以 cashier 預設 true；
 *      LEDGER 側 `staff` 映射落 cashier 亦一樣）。
 *    真正要收緊嘅係退菜／退款／折扣／設備設定。
 */
export function defaultPosStaffPermissions(role: PosStaffRole): PosStaffPermissions {
  const manager = role === "manager";
  return {
    pages: {
      order: true,
      orders: true,
      // 外送：收銀日常操作（打電話叫車手係今日已做的事），兩個角色預設都開
      delivery: true,
      members: true,
      prints: true,
      // 報表／沽清／庫存屬管理層資訊；交班係每個收銀都要做
      reports: manager,
      soldout: manager,
      shift: true,
      inventory: manager,
    },
    actions: {
      voidItem: manager,
      refundOrder: manager,
      // ⚠️ 保持現狀：今日任何員工都可返結（只強制填原因）
      reopenOrder: true,
      applyDiscount: manager,
      reprintReceipt: true,
      closeShift: true,
      deviceSettings: manager,
      // 唔收緊：今日任何員工都可以打電話叫車手，收緊 = 靜靜改變營運
      dispatchDelivery: true,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolMap<const K extends readonly string[]>(
  ids: K,
  raw: unknown,
  fallback: Record<K[number], boolean>,
): Record<K[number], boolean> {
  const source = isRecord(raw) ? raw : {};
  const out = {} as Record<K[number], boolean>;
  for (const id of ids) {
    const value = source[id];
    out[id as K[number]] = typeof value === "boolean" ? value : fallback[id as K[number]];
  }
  return out;
}

/**
 * 把任意外來資料（DB jsonb / API body / 舊 localStorage）收斂成合法權限。
 *
 * - 未知 id 靜靜丟棄（唔 throw）—— 舊版 App 存落嘅 id 可能已下架。
 * - 缺欄 → 用角色預設（見不變量 ②）。
 * - 兼容兩種形狀：`{pages, actions}` 同舊式扁平 `{voidItem:true,...}`。
 */
export function normalizePosStaffPermissions(
  raw: unknown,
  role: PosStaffRole,
): PosStaffPermissions {
  const base = defaultPosStaffPermissions(role);
  const source = isRecord(raw) ? raw : {};
  // 舊式扁平：`actions` 缺欄就當成個 object 都係 action map
  const actionsRaw = isRecord(source.actions) ? source.actions : source;
  return {
    pages: readBoolMap(POS_STAFF_PAGE_IDS, source.pages, base.pages),
    actions: readBoolMap(POS_STAFF_ACTION_IDS, actionsRaw, base.actions),
  };
}

/** 店主（Ledger owner）嘅權限 = 全開。 */
export function ownerPermissions(): PosStaffPermissions {
  const pages = {} as Record<PosStaffPageId, boolean>;
  for (const id of POS_STAFF_PAGE_IDS) pages[id] = true;
  const actions = {} as Record<PosStaffActionId, boolean>;
  for (const id of POS_STAFF_ACTION_IDS) actions[id] = true;
  return { pages, actions };
}

/** 單一頁面可唔可見。`permissions` 缺 → false（fail closed）。 */
export function canSeePage(
  permissions: PosStaffPermissions | null | undefined,
  page: string,
): boolean {
  if (!permissions) return false;
  const pages = permissions.pages as Record<string, boolean | undefined>;
  return pages?.[page] === true;
}

/** 單一操作做唔做得。`permissions` 缺 → false（fail closed）。 */
export function canDoAction(
  permissions: PosStaffPermissions | null | undefined,
  action: string,
): boolean {
  if (!permissions) return false;
  const actions = permissions.actions as Record<string, boolean | undefined>;
  return actions?.[action] === true;
}

/** 工號正規化：去前後空白、只准英數／-／_、最長 12。 */
export function normalizeStaffNo(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/\s+/g, "")
    .slice(0, 12);
}

export function isValidStaffNo(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,12}$/.test(value);
}

/**
 * 弱 PIN 攔截。
 *
 * 4 位 PIN 只有 10⁴ 組合 ⇒ 就算有 PBKDF2＋鎖定，`0000` / `1234` 仍然係
 * 第一分鐘就會被試中。建立／改 PIN 一律擋。
 */
const WEAK_PINS: readonly string[] = [
  "0000",
  "1111",
  "2222",
  "3333",
  "4444",
  "5555",
  "6666",
  "7777",
  "8888",
  "9999",
  "1234",
  "4321",
  "1212",
  "2121",
  "1122",
  "1221",
  "0123",
  "3210",
  "2580",
  "2468",
  "1357",
  "9876",
  "6789",
];

export function isWeakPin(pin: string): boolean {
  if (!/^\d{4}$/.test(pin)) return true;
  if (WEAK_PINS.includes(pin)) return true;
  // 連續遞增／遞減（例如 3456 / 6543；7890 亦算）
  const d = pin.split("").map(Number);
  const stepUp = d.every((n, i) => i === 0 || n === (d[i - 1] + 1) % 10);
  const stepDown = d.every((n, i) => i === 0 || n === (d[i - 1] + 9) % 10);
  return stepUp || stepDown;
}

export type PosStaffDraft = {
  staffNo: string;
  name: string;
  role: PosStaffRole;
  /** 建立時必填；編輯時留空 = 不改 PIN。 */
  pin?: string;
  permissions: PosStaffPermissions;
  active: boolean;
  note: string;
};

export type ValidateResult =
  | { ok: true; value: PosStaffDraft }
  | { ok: false; error: string };

/**
 * 驗證新增／編輯店員嘅輸入。**前後端用同一支**（API 唔可以信前端）。
 *
 * `requirePin`：建立時 true（一定要設初始 PIN）；編輯時 false。
 */
export function validatePosStaffDraft(raw: unknown, opts: { requirePin: boolean }): ValidateResult {
  if (!isRecord(raw)) return { ok: false, error: "輸入格式錯誤。" };

  const staffNo = normalizeStaffNo(raw.staffNo);
  if (!staffNo) return { ok: false, error: "請填工號（例如 01）。" };
  if (!isValidStaffNo(staffNo)) {
    return { ok: false, error: "工號只准英文字母、數字、- 或 _，最長 12 位。" };
  }

  const name = String(raw.name ?? "").trim();
  if (!name) return { ok: false, error: "請填員工姓名。" };
  if (name.length > 40) return { ok: false, error: "姓名最多 40 個字。" };

  const roleRaw = String(raw.role ?? "").trim();
  if (!(POS_STAFF_ROLE_IDS as readonly string[]).includes(roleRaw)) {
    return { ok: false, error: "角色只可以係店長或收銀員。" };
  }
  const role = roleRaw as PosStaffRole;

  const pinRaw = raw.pin === undefined || raw.pin === null ? "" : String(raw.pin).trim();
  let pin: string | undefined;
  if (pinRaw) {
    if (!/^\d{4}$/.test(pinRaw)) return { ok: false, error: "PIN 一定要 4 位數字。" };
    if (isWeakPin(pinRaw)) {
      return { ok: false, error: "PIN 太容易估（例如 0000／1234／連續數字），請換一個。" };
    }
    pin = pinRaw;
  } else if (opts.requirePin) {
    return { ok: false, error: "請設定 4 位 PIN。" };
  }

  const note = String(raw.note ?? "").trim().slice(0, 120);

  return {
    ok: true,
    value: {
      staffNo,
      name,
      role,
      pin,
      permissions: normalizePosStaffPermissions(raw.permissions, role),
      active: raw.active === undefined ? true : raw.active === true,
      note,
    },
  };
}

/** 由已登入操作員嘅 DTO 取權限（店主 → 全開）。 */
export function permissionsForOperator(
  operator: { role: PosStaffRole | "owner"; permissions?: unknown } | null | undefined,
): PosStaffPermissions {
  if (!operator) return ownerPermissions();
  if (operator.role === "owner") return ownerPermissions();
  return normalizePosStaffPermissions(operator.permissions, operator.role);
}
