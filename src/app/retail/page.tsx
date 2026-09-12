import { AuthGuard } from "@/components/auth-guard";
import { RetailCounter } from "@/components/retail/retail-counter";

/**
 * 零售收銀台（`/retail`）。
 *
 * 業態係**完全獨立分支**（商家定案「零售就係零售」）—— 呢條路由唔會出現
 * 桌台 / 廚房 / 出餐概念，亦唔會同餐飲 `PosApp` 共用狀態。
 */
export default function RetailPage() {
  return (
    <AuthGuard>
      <RetailCounter />
    </AuthGuard>
  );
}
