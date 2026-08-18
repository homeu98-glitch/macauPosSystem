// Salon 中文標籤映射（職位 / 級別 / 狀態），集中管理避免散落各元件。
//
// 角色與級別現為「商家可配置」：具體清單由 SalonBootstrap.staffRoleTypes /
// staffLevelTypes 定義（設置 → 角色與級別 可增刪）。本檔提供預設清單與
// 「依 bootstrap 衍生標籤」的輔助函式；顯示層一律優先取 bootstrap 設定，
// 取不到時回退到預設（DEFAULT_*），再不行就直接顯示機讀 id，避免空白。

import type {
  SalonBootstrap,
  SalonStaffRole,
  SalonStaffLevel,
  SalonStaffStatus,
  SalonConfigRoleType,
  SalonConfigLevelType,
} from "@/lib/salon/types";

// ────────────────────────────────────────────────────────────────────
// 預設角色 / 級別（舊硬編碼 5 角色 + 3 級別；作為回退與首次種子）
// ────────────────────────────────────────────────────────────────────

export const DEFAULT_SALON_STAFF_ROLE_TYPES: SalonConfigRoleType[] = [
  { id: "stylist", label: "造型師" },
  { id: "colorist", label: "染燙師" },
  { id: "therapist", label: "美容療師" },
  { id: "assistant", label: "助理" },
  { id: "receptionist", label: "接待" },
];

export const DEFAULT_SALON_STAFF_LEVEL_TYPES: SalonConfigLevelType[] = [
  { id: "junior", label: "初級", multiplier: 1 },
  { id: "senior", label: "高級", multiplier: 1.3 },
  { id: "master", label: "首席", multiplier: 1.6 },
];

// ────────────────────────────────────────────────────────────────────
// 回退用靜態映射（無 bootstrap 時用；鍵改為 string 以配合可配置角色）
// ────────────────────────────────────────────────────────────────────

export const SALON_STAFF_ROLE_LABELS: Record<string, string> = Object.fromEntries(
  DEFAULT_SALON_STAFF_ROLE_TYPES.map((t) => [t.id, t.label]),
);

export const SALON_STAFF_ROLE_ORDER: string[] = DEFAULT_SALON_STAFF_ROLE_TYPES.map(
  (t) => t.id,
);

export const SALON_STAFF_LEVEL_LABELS: Record<string, string> = Object.fromEntries(
  DEFAULT_SALON_STAFF_LEVEL_TYPES.map((t) => [t.id, t.label]),
);

export const SALON_STAFF_LEVEL_ORDER: string[] = DEFAULT_SALON_STAFF_LEVEL_TYPES.map(
  (t) => t.id,
);

// ────────────────────────────────────────────────────────────────────
// 依 bootstrap 衍生（商家可配置來源）
// ────────────────────────────────────────────────────────────────────

/** 取得生效的角色類型清單（bootstrap 有設定且非空 → 用 bootstrap；否則預設） */
export function getSalonStaffRoleTypes(
  bootstrap?: SalonBootstrap | null,
): SalonConfigRoleType[] {
  if (bootstrap?.staffRoleTypes && bootstrap.staffRoleTypes.length > 0) {
    return bootstrap.staffRoleTypes;
  }
  return DEFAULT_SALON_STAFF_ROLE_TYPES;
}

/** 取得生效的級別類型清單（bootstrap 有設定且非空 → 用 bootstrap；否則預設） */
export function getSalonStaffLevelTypes(
  bootstrap?: SalonBootstrap | null,
): SalonConfigLevelType[] {
  if (bootstrap?.staffLevelTypes && bootstrap.staffLevelTypes.length > 0) {
    return bootstrap.staffLevelTypes;
  }
  return DEFAULT_SALON_STAFF_LEVEL_TYPES;
}

/** 角色 id → 顯示名稱映射（依 bootstrap） */
export function getSalonStaffRoleLabels(
  bootstrap?: SalonBootstrap | null,
): Record<string, string> {
  return Object.fromEntries(getSalonStaffRoleTypes(bootstrap).map((t) => [t.id, t.label]));
}

/** 級別 id → 顯示名稱映射（依 bootstrap） */
export function getSalonStaffLevelLabels(
  bootstrap?: SalonBootstrap | null,
): Record<string, string> {
  return Object.fromEntries(getSalonStaffLevelTypes(bootstrap).map((t) => [t.id, t.label]));
}

/** 角色 id → 顯示名稱（取不到回退到預設，再不行顯示 id 本身） */
export function salonRoleLabel(
  id: SalonStaffRole | string,
  bootstrap?: SalonBootstrap | null,
): string {
  return getSalonStaffRoleLabels(bootstrap)[id] ?? SALON_STAFF_ROLE_LABELS[id] ?? id;
}

/** 級別 id → 顯示名稱（取不到回退到預設，再不行顯示 id 本身） */
export function salonLevelLabel(
  id: SalonStaffLevel | string,
  bootstrap?: SalonBootstrap | null,
): string {
  return getSalonStaffLevelLabels(bootstrap)[id] ?? SALON_STAFF_LEVEL_LABELS[id] ?? id;
}

/** 級別 id → 工錢倍率映射（依 bootstrap；工錢計算用） */
export function getStaffLevelMultipliers(
  bootstrap?: SalonBootstrap | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of getSalonStaffLevelTypes(bootstrap)) out[t.id] = t.multiplier;
  return out;
}

// ────────────────────────────────────────────────────────────────────
// 狀態（仍為固定列舉）
// ────────────────────────────────────────────────────────────────────

export const SALON_STAFF_STATUS_LABELS: Record<SalonStaffStatus, string> = {
  active: "在職",
  on_leave: "放假",
  terminated: "離職",
};

export const SALON_STAFF_STATUS_ORDER: SalonStaffStatus[] = [
  "active",
  "on_leave",
  "terminated",
];

/** 狀態徽章配色（Tailwind class），供列表 / 詳情顯示用 */
export const SALON_STAFF_STATUS_BADGE: Record<SalonStaffStatus, string> = {
  active: "bg-emerald-100 text-emerald-700",
  on_leave: "bg-amber-100 text-amber-700",
  terminated: "bg-slate-200 text-slate-500",
};
