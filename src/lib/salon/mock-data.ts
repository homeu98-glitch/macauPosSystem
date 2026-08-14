// Salon 預設 Bootstrap（seed）— 店家首次啟動時種入
// 對應餐飲 src/lib/mock-data.ts 的 mockBootstrap 模式。

import type {
  SalonBootstrap,
  SalonServiceCategory,
  SalonServiceItem,
  SalonStaff,
  SalonStation,
} from "@/lib/salon/types";

export const DEFAULT_SALON_STORE_ID = "demo-salon-001";

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
    role: "stylist",
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
    role: "therapist",
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
    role: "assistant",
    serviceCategoryIds: ["cat-nails", "cat-massage"],
    phone: "66889012",
    active: true,
    hiredAt: "2025-01-10",
    createdAt: NOW,
    updatedAt: NOW,
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
  calendarSlotMinutes: 30,
  depositEnabled: true,
  defaultServiceDurationMinutes: 60,
  lastUpdatedAt: NOW,
};

// 提供給 storage 在第一次啟動時 seed
export function buildDefaultSalonBootstrap(): SalonBootstrap {
  return {
    ...defaultSalonBootstrap,
    lastUpdatedAt: new Date().toISOString(),
  };
}
