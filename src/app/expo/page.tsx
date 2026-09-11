"use client";

import { ExpoScreen } from "@/components/kds/expo-screen";

/**
 * 出餐台屏 `/expo`（docs/116 §7.2）。
 *
 * 同後廚屏（`/kitchen`）相反嘅視角：
 *   - 後廚屏：只睇**自己分區**、逐件菜撳 ✓
 *   - 出餐台屏：睇**整單齊唔齊**、一撳「確認出餐」
 *
 * 兩者都係**裝置角色頁**：唔行 outbox、唔碰 `pos_orders.status`、冇響應式斷點。
 */
export default function ExpoPage() {
  return <ExpoScreen />;
}
