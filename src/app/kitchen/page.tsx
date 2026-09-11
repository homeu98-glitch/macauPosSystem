"use client";

import { KitchenScreen } from "@/components/kds/kitchen-screen";

/**
 * 後廚屏 `/kitchen`（docs/116 §7.1）。
 *
 * 呢個係**裝置角色頁**，同收銀台完全分家：
 *   - 唔行 outbox（後廚屏冇本機訂單副本，見 docs/116 §3.1）
 *   - 唔碰 `pos_orders.status`（結帳狀態機）
 *   - 崗位鎖死喺設備綁定度，屏內冇切換掣
 *
 * ⚠️ 掛喺牆上嘅 iPad，**唔會有響應式斷點**：目標形狀就係 iPad 橫向。
 */
export default function KitchenPage() {
  return <KitchenScreen />;
}
