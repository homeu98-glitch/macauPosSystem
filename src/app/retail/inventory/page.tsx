import { AuthGuard } from "@/components/auth-guard";
import { RetailInventory } from "@/components/retail/retail-inventory";

/**
 * 零售庫存管理（`/retail/inventory`）：缺貨 / 低庫存清單、盤點改量、一鍵補貨、匯出盤點表。
 *
 * ⚠️ 呢頁只做**庫存數量**；改價格 / 條碼 / 變體仍然去「商品」頁。
 */
export default function RetailInventoryPage() {
  return (
    <AuthGuard>
      <RetailInventory />
    </AuthGuard>
  );
}
