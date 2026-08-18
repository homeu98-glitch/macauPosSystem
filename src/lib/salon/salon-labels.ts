// Salon 中文標籤映射（職位 / 級別 / 狀態），集中管理避免散落各元件。

import type {
  SalonStaffRole,
  SalonStaffLevel,
  SalonStaffStatus,
} from "@/lib/salon/types";

export const SALON_STAFF_ROLE_LABELS: Record<SalonStaffRole, string> = {
  stylist: "造型師",
  colorist: "染燙師",
  therapist: "美容療師",
  assistant: "助理",
  receptionist: "接待",
};

export const SALON_STAFF_ROLE_ORDER: SalonStaffRole[] = [
  "stylist",
  "colorist",
  "therapist",
  "assistant",
  "receptionist",
];

export const SALON_STAFF_LEVEL_LABELS: Record<SalonStaffLevel, string> = {
  junior: "初級",
  senior: "高級",
  master: "首席",
};

export const SALON_STAFF_LEVEL_ORDER: SalonStaffLevel[] = [
  "junior",
  "senior",
  "master",
];

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
