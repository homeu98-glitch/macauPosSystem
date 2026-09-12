import { AuthGuard } from "@/components/auth-guard";
import { RetailProducts } from "@/components/retail/retail-products";

/** 零售商品管理（`/retail/products`）：新增 / 編輯 / 停售 / 刪除 / CSV 批量匯入。 */
export default function RetailProductsPage() {
  return (
    <AuthGuard>
      <RetailProducts />
    </AuthGuard>
  );
}
