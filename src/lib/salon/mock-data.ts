// Salon 預設 Bootstrap（seed）— 店家首次啟動時種入
// 對應餐飲 src/lib/mock-data.ts 的 mockBootstrap 模式。

import type {
  SalonBootstrap,
  SalonServiceCategory,
  SalonServiceItem,
  SalonStaff,
  SalonStation,
  SalonCustomerProfile,
  SalonPackageTemplate,
  SalonLoyaltySettings,
  SalonProduct,
} from "@/lib/salon/types";
import {
  DEFAULT_SALON_STAFF_ROLE_TYPES,
  DEFAULT_SALON_STAFF_LEVEL_TYPES,
} from "@/lib/salon/salon-labels";

export const DEFAULT_SALON_STORE_ID = "demo-salon-001";

// ────────────────────────────────────────────────────────────────────
// 預設會員忠誠度設定（Phase 8 示範資料）
// 對應 docs/30-salon-loyalty-referral-birthday.md：
// - pointsPerDollar=1（1 元 1 分，每店可改）
// - 推薦獎勵開啟，被推薦人首次結帳發 100 分給推薦人
// - 生日優惠開啟，當月生日享 9 折 + 雙倍積分（各自獨立，可填 0 關閉）
// ────────────────────────────────────────────────────────────────────

export const DEFAULT_SALON_LOYALTY: SalonLoyaltySettings = {
  pointsPerDollar: 1,
  referralEnabled: true,
  referralPoints: 100,
  birthdayEnabled: true,
  birthdayWindow: "month",
  birthdayDiscountPercent: 10,
  birthdayPointsMultiplier: 2,
};

const NOW = new Date().toISOString();

// ────────────────────────────────────────────────────────────────────
// 服務類目（8 大類）
// ────────────────────────────────────────────────────────────────────

const categories: SalonServiceCategory[] = [
  {
    id: "cat-face",
    name: "臉部護理",
    printerGroup: "station_face",
    sortOrder: 1,
    color: "#fda4af",
    active: true,
  },
  {
    id: "cat-body",
    name: "身體護理",
    printerGroup: "station_body",
    sortOrder: 2,
    color: "#fbbf24",
    active: true,
  },
  {
    id: "cat-spa",
    name: "SPA",
    printerGroup: "station_body",
    sortOrder: 3,
    color: "#a78bfa",
    active: true,
  },
  {
    id: "cat-nails",
    name: "美甲",
    printerGroup: "station_nails",
    sortOrder: 4,
    color: "#f472b6",
    active: true,
  },
  {
    id: "cat-lashes",
    name: "美睫",
    printerGroup: "station_lashes",
    sortOrder: 5,
    color: "#60a5fa",
    active: true,
  },
  {
    id: "cat-hair-removal",
    name: "脫毛",
    printerGroup: "station_face",
    sortOrder: 6,
    color: "#34d399",
    active: true,
  },
  {
    id: "cat-massage",
    name: "按摩",
    printerGroup: "station_body",
    sortOrder: 7,
    color: "#fb923c",
    active: true,
  },
  {
    id: "cat-slimming",
    name: "瘦身",
    printerGroup: "station_body",
    sortOrder: 8,
    color: "#94a3b8",
    active: true,
  },
];

// ────────────────────────────────────────────────────────────────────
// 服務項目（每類 1-2 個示例）
// ────────────────────────────────────────────────────────────────────

const items: SalonServiceItem[] = [
  // 臉部
  {
    id: "srv-hydrating-facial",
    categoryId: "cat-face",
    name: "保濕臉部護理",
    description: "深層清潔 + 保濕面膜",
    price: 480,
    durationMinutes: 60,
    stationTypes: ["bed"],
    staffRoles: ["therapist"],
    active: true,
    sortOrder: 1,
  },
  {
    id: "srv-anti-aging-facial",
    categoryId: "cat-face",
    name: "抗老臉部護理",
    price: 880,
    durationMinutes: 90,
    stationTypes: ["bed"],
    staffRoles: ["therapist"],
    active: true,
    sortOrder: 2,
  },
  // 身體
  {
    id: "srv-body-scrub",
    categoryId: "cat-body",
    name: "身體磨砂",
    price: 580,
    durationMinutes: 60,
    stationTypes: ["bed", "room"],
    staffRoles: ["therapist"],
    active: true,
    sortOrder: 1,
  },
  // SPA
  {
    id: "srv-aroma-spa",
    categoryId: "cat-spa",
    name: "香薰 SPA 90 分",
    price: 980,
    durationMinutes: 90,
    stationTypes: ["bed", "room"],
    staffRoles: ["therapist"],
    active: true,
    sortOrder: 1,
  },
  // 美甲
  {
    id: "srv-manicure",
    categoryId: "cat-nails",
    name: "基礎手部美甲",
    price: 180,
    durationMinutes: 45,
    stationTypes: ["nail_table"],
    staffRoles: ["stylist", "assistant"],
    active: true,
    sortOrder: 1,
  },
  {
    id: "srv-gel-manicure",
    categoryId: "cat-nails",
    name: "凝膠美甲",
    price: 380,
    durationMinutes: 75,
    stationTypes: ["nail_table"],
    staffRoles: ["stylist"],
    active: true,
    sortOrder: 2,
  },
  // 美睫
  {
    id: "srv-lash-extension",
    categoryId: "cat-lashes",
    name: "美睫嫁接",
    price: 580,
    durationMinutes: 90,
    stationTypes: ["chair"],
    staffRoles: ["stylist"],
    active: true,
    sortOrder: 1,
  },
  // 脫毛
  {
    id: "srv-underarm-wax",
    categoryId: "cat-hair-removal",
    name: "腋下脫毛",
    price: 180,
    durationMinutes: 20,
    stationTypes: ["bed"],
    staffRoles: ["therapist"],
    active: true,
    sortOrder: 1,
  },
  // 按摩
  {
    id: "srv-shoulder-massage",
    categoryId: "cat-massage",
    name: "肩頸按摩 30 分",
    price: 280,
    durationMinutes: 30,
    stationTypes: ["chair"],
    staffRoles: ["therapist"],
    active: true,
    sortOrder: 1,
  },
  // 瘦身
  {
    id: "srv-body-contour",
    categoryId: "cat-slimming",
    name: "瘦身塑型 60 分",
    price: 880,
    durationMinutes: 60,
    stationTypes: ["bed"],
    staffRoles: ["therapist"],
    active: true,
    sortOrder: 1,
  },
];

// ────────────────────────────────────────────────────────────────────
// 員工（3 位示範）
// ────────────────────────────────────────────────────────────────────

const staff: SalonStaff[] = [
  {
    id: "staff-001",
    name: "小美",
    nickname: "美姐",
    roles: ["stylist"],
    level: "senior",
    status: "active",
    serviceCategoryIds: ["cat-nails", "cat-lashes"],
    phone: "66881234",
    active: true,
    hiredAt: "2024-03-01",
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: "staff-002",
    name: "阿龍",
    nickname: "龍哥",
    roles: ["therapist"],
    level: "master",
    status: "active",
    serviceCategoryIds: [
      "cat-face",
      "cat-body",
      "cat-spa",
      "cat-massage",
      "cat-slimming",
      "cat-hair-removal",
    ],
    phone: "66885678",
    active: true,
    hiredAt: "2023-08-15",
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: "staff-003",
    name: "小玲",
    nickname: "玲玲",
    roles: ["assistant"],
    level: "junior",
    status: "active",
    serviceCategoryIds: ["cat-nails", "cat-massage"],
    phone: "66889012",
    active: true,
    hiredAt: "2025-01-10",
    createdAt: NOW,
    updatedAt: NOW,
  },
];

// ────────────────────────────────────────────────────────────────────
// 產品目錄（F4 示範資料，無庫存，每項指定 commissionRate%）
// ────────────────────────────────────────────────────────────────────

export const DEFAULT_SALON_PRODUCTS: SalonProduct[] = [
  {
    id: "prod-moisturizer",
    name: "保濕精華 30ml",
    category: "護膚",
    price: 320,
    cost: 120,
    commissionRate: 10,
    active: true,
    sortOrder: 1,
  },
  {
    id: "prod-serum",
    name: "抗老血清 15ml",
    category: "護膚",
    price: 580,
    cost: 220,
    commissionRate: 12,
    active: true,
    sortOrder: 2,
  },
  {
    id: "prod-nail-oil",
    name: "指甲營養油",
    category: "美甲",
    price: 90,
    cost: 30,
    commissionRate: 8,
    active: true,
    sortOrder: 3,
  },
  {
    id: "prod-lash-care",
    name: "睫毛養護液",
    category: "美睫",
    price: 150,
    cost: 55,
    commissionRate: 10,
    active: true,
    sortOrder: 4,
  },
];

// ────────────────────────────────────────────────────────────────────
// 房型 / 椅
// ────────────────────────────────────────────────────────────────────

const stations: SalonStation[] = [
  {
    id: "station-chair-1",
    name: "美甲椅 1",
    type: "nail_table",
    capacity: 1,
    location: "1 樓 美甲區",
    active: true,
    sortOrder: 1,
  },
  {
    id: "station-bed-1",
    name: "臉部護理床 1",
    type: "bed",
    capacity: 1,
    location: "1 樓 護理區",
    active: true,
    sortOrder: 2,
  },
  {
    id: "station-bed-2",
    name: "身體護理床 1",
    type: "bed",
    capacity: 1,
    location: "1 樓 SPA 房",
    active: true,
    sortOrder: 3,
  },
  {
    id: "station-room-vip",
    name: "VIP 房",
    type: "room",
    capacity: 1,
    location: "2 樓",
    active: true,
    sortOrder: 4,
  },
];

// ────────────────────────────────────────────────────────────────────
// 預設 Bootstrap
// ────────────────────────────────────────────────────────────────────

export const defaultSalonBootstrap: SalonBootstrap = {
  sourceVersion: 1,
  storeId: DEFAULT_SALON_STORE_ID,
  storeName: "示範美容院",
  currency: "MOP",
  serviceCategories: categories,
  serviceItems: items,
  staff,
  stations,
  products: DEFAULT_SALON_PRODUCTS,
  calendarSlotMinutes: 30,
  depositEnabled: true,
  defaultServiceDurationMinutes: 60,
  loyalty: DEFAULT_SALON_LOYALTY,
  staffRoleTypes: DEFAULT_SALON_STAFF_ROLE_TYPES,
  staffLevelTypes: DEFAULT_SALON_STAFF_LEVEL_TYPES,
  lastUpdatedAt: NOW,
};

// 提供給 storage 在第一次啟動時 seed
export function buildDefaultSalonBootstrap(): SalonBootstrap {
  return {
    ...defaultSalonBootstrap,
    lastUpdatedAt: new Date().toISOString(),
  };
}

/**
 * 真實 Ledger 商戶（非 demo）首次進入 salon、而該店從未開過 salon 時，
 * 返回全空 bootstrap（唔種 demo 資料）。店家可於設置內自行建立服務 / 員工 / 產品。
 */
export function buildEmptySalonBootstrap(storeId: string): SalonBootstrap {
  return {
    sourceVersion: 1,
    storeId,
    storeName: "",
    currency: "MOP",
    serviceCategories: [],
    serviceItems: [],
    staff: [],
    stations: [],
    products: [],
    calendarSlotMinutes: 30,
    depositEnabled: false,
    defaultServiceDurationMinutes: 60,
    loyalty: DEFAULT_SALON_LOYALTY,
    staffRoleTypes: DEFAULT_SALON_STAFF_ROLE_TYPES,
    staffLevelTypes: DEFAULT_SALON_STAFF_LEVEL_TYPES,
    lastUpdatedAt: new Date().toISOString(),
  };
}

// ────────────────────────────────────────────────────────────────────
// 預設客戶（Phase 4 示範資料）
// 電話與 seedMockBookingsIfEmpty 的示範預約對齊，方便從預約連回客戶檔案。
// ledgerBalance / ledgerPoints / ledgerTier 為 Ledger 會員資料（mock 階段種入；
// 真實 Ledger 到位後由 getMockLedgerMember 改讀 RPC，POS 永不寫入）。
// ────────────────────────────────────────────────────────────────────

export const defaultSalonCustomers: SalonCustomerProfile[] = [
  {
    id: "cust-001",
    name: "林小姐",
    phone: "66883333",
    ledgerBalance: 1200,
    ledgerPoints: 3400,
    ledgerTier: "金卡會員",
    birthday: "1990-05-12",
    gender: "female",
    tags: ["VIP", "敏感肌"],
    skinType: "sensitive",
    hairType: "fine",
    allergies: ["香料", "酒精"],
    preferences: "喜歡安靜環境，怕癢",
    formulaHistory: [
      {
        date: "2026-06-15",
        service: "保濕臉部護理",
        formula: "溫和保濕精華 + 蘆薈",
        staffId: "staff-002",
        staffName: "阿龍",
      },
      {
        date: "2026-07-20",
        service: "抗老臉部護理",
        formula: "視黃醇 0.3% + 神經醯胺",
        staffId: "staff-002",
        staffName: "阿龍",
      },
    ],
    visitCount: 12,
    lastVisitAt: "2026-08-10",
    totalSpent: 8650,
  },
  {
    id: "cust-002",
    name: "王小姐",
    phone: "66881111",
    ledgerBalance: 300,
    ledgerPoints: 1200,
    ledgerTier: "銀卡會員",
    gender: "female",
    tags: ["美甲常客"],
    skinType: "combination",
    allergies: [],
    formulaHistory: [],
    visitCount: 5,
    lastVisitAt: "2026-08-14",
    totalSpent: 2400,
  },
  {
    id: "cust-003",
    name: "張小姐",
    phone: "66884444",
    ledgerBalance: 0,
    ledgerPoints: 800,
    ledgerTier: "普通會員",
    gender: "female",
    tags: [],
    hairType: "damaged",
    formulaHistory: [],
    visitCount: 3,
    lastVisitAt: "2026-08-14",
    totalSpent: 1740,
  },
  {
    id: "cust-004",
    name: "陳先生",
    phone: "66882222",
    ledgerBalance: 500,
    ledgerPoints: 2100,
    ledgerTier: "銀卡會員",
    gender: "male",
    tags: ["SPA愛好者"],
    preferences: "力度要重一點",
    formulaHistory: [],
    visitCount: 8,
    lastVisitAt: "2026-08-14",
    totalSpent: 7840,
  },
  {
    id: "cust-005",
    name: "黃先生",
    phone: "66885555",
    ledgerBalance: 0,
    ledgerPoints: 150,
    ledgerTier: "普通會員",
    gender: "male",
    tags: [],
    formulaHistory: [],
    visitCount: 1,
    lastVisitAt: "2026-08-14",
    totalSpent: 280,
  },
];

// ────────────────────────────────────────────────────────────────────
// 預設套票模板（P1 示範資料）
// 次數額度引用上面服務項目 id；贈送積分 / 儲值委託 Ledger（P2 才寫入）。
// ────────────────────────────────────────────────────────────────────

const NOW_PKG = new Date().toISOString();

export const defaultSalonPackageTemplates: SalonPackageTemplate[] = [
  {
    id: "pkg-facial-10",
    name: "面部 10 次豪華套票",
    price: 6800,
    validityDays: 180,
    items: [
      { serviceItemId: "srv-hydrating-facial", sessions: 10 },
      { serviceItemId: "srv-shoulder-massage", sessions: 2 },
    ],
    bonusPoints: 500,
    bonusBalance: 0,
    note: "含 2 次肩頸按摩 + 贈 500 積分",
    active: true,
    createdAt: NOW_PKG,
    updatedAt: NOW_PKG,
  },
  {
    id: "pkg-gel-5",
    name: "凝膠美甲 5 次套票",
    price: 1500,
    validityDays: 90,
    items: [{ serviceItemId: "srv-gel-manicure", sessions: 5 }],
    bonusPoints: 100,
    bonusBalance: 0,
    note: "效期 90 天",
    active: true,
    createdAt: NOW_PKG,
    updatedAt: NOW_PKG,
  },
];
