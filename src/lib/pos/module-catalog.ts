/**
 * 商戶模組目錄 —— **唯一真源**。
 *
 * ## 為什麼要有呢個檔
 *
 * 「登入後揀咩工作台」「側欄顯示邊幾個」「Admin 後台開關邊幾個」—— 呢三件事
 * 必須睇同一份清單。如果各自寫一份，就會出現「Admin 開通咗但 POS 冇得揀」
 * 或者「POS 揀咗但路由唔存在」呢類唔會 throw、只會靜靜唔見咗嘅 bug。
 *
 * 所以：**任何新模組一律先加落呢度**，其他所有地方（選擇工作台頁、側欄、
 * Admin 授權頁、`normalizeMerchantGrants()`）都由此生成。
 *
 * ## 兩層模組
 *
 * - `Workbench`（工作台）：**登入之後第一步揀嘅嘢**，決定「呢部機做邊個崗位」，
 *   亦決定店級掃碼點餐模式（quick → 全店一碼；dinein → 每枱一碼）。
 * - `SidebarModule`（側欄模組）：入到收銀台之後，左邊側欄顯示邊幾個功能頁。
 *
 * ⚠️ 呢個檔**零 runtime 依賴**（只 `import type`），可以被 `node --test` 直接覆蓋。
 * 詳見 `docs/127-login-workbench-permission-plan.md`。
 */

/** 工作台 id。注意：`retail` 係新增嘅（舊 `LoginMode` 冇）。 */
export type WorkbenchId = "dinein" | "quick" | "retail" | "salon" | "kiosk" | "kitchen" | "expo";

/** 側欄模組 id（對應 `app-sidebar.tsx` 嘅 baseNavItems）。 */
export type SidebarModuleId =
  | "order"
  | "orders"
  | "members"
  | "prints"
  | "reports"
  | "soldout"
  | "shift"
  | "inventory";

/** 工作台卡片嘅分組：收銀台 vs 裝置角色。 */
export type WorkbenchGroup = "counter" | "device";

export type WorkbenchDef = {
  id: WorkbenchId;
  label: string;
  /** 卡片左邊圓形徽章嘅單字（跟側欄嘅視覺慣例，唔用 emoji）。 */
  short: string;
  /** 卡片副標：一句講清楚呢個工作台做咩。 */
  desc: string;
  /** 揀完之後跳去邊。 */
  homePath: string;
  group: WorkbenchGroup;
  /**
   * 裝置角色 —— 即「呢部機開機做乜」，**唔係**「全店客人點樣落單」。
   *
   * 🔴 呢個 flag 有實際作用：`scanModeForWorkbench()` 對裝置角色一律回 `null`
   * （唔改店級掃碼設定），否則自助點餐機綁店會同收銀台嘅堂食登入互相覆蓋，
   * 令設定頁顯示嘅 QR 每次登入都唔同（見 `scan-mode-from-login.ts` 嘅長註解）。
   */
  deviceRole: boolean;
  /** 產品 UI 嘅強調色（Tailwind 色名，對齊 `login-screen` 原有配色）。 */
  accent: "orange" | "emerald" | "sky" | "rose";
};

export const WORKBENCHES: readonly WorkbenchDef[] = [
  {
    id: "dinein",
    label: "堂食收銀台",
    short: "堂",
    desc: "每張桌台各自一碼，客人掃碼落單綁定枱號",
    homePath: "/",
    group: "counter",
    deviceRole: false,
    accent: "orange",
  },
  {
    id: "quick",
    label: "快餐收銀台",
    short: "快",
    desc: "全店一個碼貼櫃檯，客人自助落單、冇枱號",
    homePath: "/",
    group: "counter",
    deviceRole: false,
    accent: "orange",
  },
  {
    id: "retail",
    label: "零售收銀台",
    short: "售",
    desc: "掃碼／逐件計，無枱號、無廚房單",
    homePath: "/retail",
    group: "counter",
    deviceRole: false,
    accent: "orange",
  },
  {
    id: "salon",
    label: "美容管理",
    short: "美",
    desc: "預約、服務、員工排班（美容行業模組）",
    homePath: "/salon",
    group: "counter",
    deviceRole: false,
    accent: "rose",
  },
  {
    id: "kiosk",
    label: "自助點餐機",
    short: "機",
    desc: "客人喺呢部機直接落單",
    homePath: "/order",
    group: "device",
    deviceRole: true,
    accent: "emerald",
  },
  {
    id: "kitchen",
    label: "後廚屏",
    short: "廚",
    desc: "逐件菜撳 ✓（入去先揀分區）",
    homePath: "/kitchen",
    group: "device",
    deviceRole: true,
    accent: "emerald",
  },
  {
    id: "expo",
    label: "出餐台屏",
    short: "台",
    desc: "核對整單出餐",
    homePath: "/expo",
    group: "device",
    deviceRole: true,
    accent: "sky",
  },
];

export type SidebarModuleDef = {
  id: SidebarModuleId;
  label: string;
  short: string;
  href: string;
};

/** ⚠️ 順序 = 側欄顯示順序，唔好隨便調（商家已經記熟位置）。 */
export const SIDEBAR_MODULES: readonly SidebarModuleDef[] = [
  { id: "order", label: "點餐", short: "點", href: "/" },
  { id: "orders", label: "訂單", short: "單", href: "/orders" },
  { id: "members", label: "會員", short: "會", href: "/members" },
  { id: "prints", label: "打印", short: "印", href: "/prints" },
  { id: "reports", label: "報表", short: "報", href: "/reports" },
  { id: "soldout", label: "沽清", short: "沽", href: "/soldout" },
  { id: "shift", label: "交班", short: "班", href: "/shift" },
  { id: "inventory", label: "庫存", short: "庫", href: "/inventory" },
];

export const WORKBENCH_IDS: readonly WorkbenchId[] = WORKBENCHES.map((w) => w.id);
export const SIDEBAR_MODULE_IDS: readonly SidebarModuleId[] = SIDEBAR_MODULES.map((m) => m.id);

/**
 * 商戶已開通嘅模組。
 *
 * ⚠️ `store_id` 係 **Ledger merchant UUID**（同 `pos_orders.store_id` 口徑一致）。
 */
export type MerchantModuleGrants = {
  workbenches: WorkbenchId[];
  sidebarModules: SidebarModuleId[];
};

/** 全部開通 —— 新商戶嘅預設，亦係「DB 冇記錄」時嘅 fallback。 */
export function defaultMerchantGrants(): MerchantModuleGrants {
  return {
    workbenches: [...WORKBENCH_IDS],
    sidebarModules: [...SIDEBAR_MODULE_IDS],
  };
}

function toIdArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

/**
 * 把任意外來資料（DB jsonb / API body / 舊 localStorage）收斂成合法授權。
 *
 * 規則：
 * - 未知 id 一律**靜靜丟棄**（唔 throw）—— 舊版 App 存落嘅 id 可能已經改名／下架，
 *   為咗一個唔識嘅 id 就令整間舖登入唔到，代價太大。
 * - 去重 + 按目錄順序重排（令 UI 穩定，唔會因為 DB 寫入次序唔同而跳位）。
 * - ⚠️ 刻意**唔**在這裡處理「空陣列 vs 缺欄」嘅語意分別 ——
 *   「空陣列」= Admin 明確全部閂；「DB 完全冇記錄」= 全部開通。
 *   呢個判斷喺 `merchant-modules-server.ts` 嘅 `loadMerchantGrants()` 做。
 */
export function normalizeMerchantGrants(raw: unknown): MerchantModuleGrants {
  const source = (raw ?? {}) as { workbenches?: unknown; sidebarModules?: unknown; sidebar_modules?: unknown };
  const rawWorkbenches = toIdArray(source.workbenches);
  const rawSidebar = toIdArray(source.sidebarModules ?? source.sidebar_modules);

  const keep = <T extends string>(allowed: readonly T[], values: string[]): T[] => {
    const set = new Set(values);
    return allowed.filter((id) => set.has(id));
  };

  return {
    workbenches: keep(WORKBENCH_IDS, rawWorkbenches),
    sidebarModules: keep(SIDEBAR_MODULE_IDS, rawSidebar),
  };
}

export function findWorkbench(id: string): WorkbenchDef | undefined {
  return WORKBENCHES.find((w) => w.id === id);
}

/**
 * 呢個工作台應該寫入邊個店級掃碼模式？
 *
 * - 收銀台（dinein / quick / retail / salon）→ 交返 `scan-mode-from-login` 嘅映射。
 *   `retail` / `salon` 唔涉掃碼點餐，回 `null`。
 * - 裝置角色（kiosk / kitchen / expo）→ **一律 `null`**，唔可以改店級設定。
 */
export function isWorkbenchGranted(grants: MerchantModuleGrants, id: WorkbenchId): boolean {
  return grants.workbenches.includes(id);
}

export function isSidebarModuleGranted(grants: MerchantModuleGrants, id: SidebarModuleId): boolean {
  return grants.sidebarModules.includes(id);
}

/** 分組標題（選擇工作台頁 / Admin 授權頁共用）。 */
export const WORKBENCH_GROUP_LABEL: Record<WorkbenchGroup, string> = {
  counter: "收銀工作台",
  device: "呢部機專用 · 廚房／出餐屏",
};

/** 預設工作台（未揀過、又冇「上次使用」記錄時，游標落喺邊）。 */
export const DEFAULT_WORKBENCH_ID: WorkbenchId = "dinein";
