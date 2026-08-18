// Salon 工錢計算（F1 + F3）
// 該次工錢 = 服務細項.wages[執行員工職位] × 員工級別倍率（取整）。
// 無該職位工錢 → 0。

import type {
  SalonServiceItem,
  SalonStaff,
  SalonBootstrap,
  SalonOrderItem,
} from "@/lib/salon/types";

/** 級別倍率預設值（bootstrap.staffLevelMultipliers 缺省時用） */
export const DEFAULT_STAFF_LEVEL_MULTIPLIERS: Record<
  "junior" | "senior" | "master",
  number
> = {
  junior: 1,
  senior: 1.3,
  master: 1.6,
};

/**
 * 計算單次服務工錢。
 * @returns 處理後的工錢（MOP，Math.round 取整）；無對應職位工錢則 0。
 */
export function computeStaffWage(
  serviceItem: SalonServiceItem | undefined,
  staff: SalonStaff | undefined,
  bootstrap: SalonBootstrap | null,
): number {
  if (!serviceItem || !staff) return 0;
  // 多選角色：取第一個有設定工錢嘅角色；否則取第一個角色
  const role =
    staff.roles.find((r) => serviceItem.wages?.[r] != null) ?? staff.roles[0];
  const base = role ? serviceItem.wages?.[role] : undefined;
  if (base == null || base <= 0) return 0;
  const multipliers =
    bootstrap?.staffLevelMultipliers ?? DEFAULT_STAFF_LEVEL_MULTIPLIERS;
  const mult = multipliers[staff.level] ?? DEFAULT_STAFF_LEVEL_MULTIPLIERS[staff.level] ?? 1;
  return Math.round(base * mult);
}

/**
 * 由 order item 計算工錢（checkout 組裝訂單時用）。
 * 需傳入完整 serviceItems / staff / bootstrap 以解析。
 */
export function computeOrderItemWage(
  item: SalonOrderItem,
  serviceItems: SalonServiceItem[],
  staff: SalonStaff[],
  bootstrap: SalonBootstrap | null,
): number {
  if (item.kind !== "service" || !item.staffId) return 0;
  const serviceItem = serviceItems.find((s) => s.id === item.serviceItemId);
  const staffMember = staff.find((m) => m.id === item.staffId);
  return computeStaffWage(serviceItem, staffMember, bootstrap);
}
