import { ScanOrderPage } from "@/components/scan-order-page";

/**
 * 快餐掃碼點餐（手機）—— **全店一個** QR，貼喺櫃檯／快餐區：
 *   `/quick?store=<店>`
 *
 * ⚠️ 為何唔係 `/menu?store=`（docs/115）：
 *   舊版 `/menu` 冇 `tableId` 會靜靜當成快餐落單 —— 兩條 link 撈埋一齊，
 *   日後改堂食（逐枱）流程一定誤傷快餐。所以快餐另開一條 link，雙方互不影響。
 *
 * 落單規格（同 kiosk 快餐一致）：
 *   - 冇枱：`tableId = "counter"`、`tableName = "自取"`；
 *   - **每張單獨立**（唔 resume、唔加單）；
 *   - 落單號碼用店內 `pickup` 序號（同 kiosk 共用同一條 → 兩邊唔會撞號）；
 *   - 離線時用明顯非序號嘅短後綴（例：`自取-K7Q2`），唔會同店內序號撞。
 */
export default function QuickOrderPage() {
  return <ScanOrderPage link="quick" />;
}
