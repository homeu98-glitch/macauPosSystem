import { ScanOrderPage } from "@/components/scan-order-page";

/**
 * 堂食掃碼點餐（手機）—— 每張枱一個專屬 QR：
 *   `/menu?tableId=<枱>&store=<店>`
 *
 * ⚠️ 呢條 link **只做堂食**（docs/115）：
 *   - 冇 `tableId` 唔會 fallback 成快餐（會顯示「請掃描枱上 QR」）；
 *   - 快餐係另一條獨立 link `/quick?store=<店>`（`src/app/quick/page.tsx`）。
 *
 * 兩條 link 分開嘅原因：日後改堂食流程（例如加「叫起菜」）唔會誤傷快餐，
 * 反之亦然。真正共用嘅係 `ScanOrderPage` 內嘅中性基礎設施。
 */
export default function MenuPage() {
  return <ScanOrderPage link="dine_in" />;
}
