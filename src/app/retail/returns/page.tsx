import { AuthGuard } from "@/components/auth-guard";
import { RetailReturns } from "@/components/retail/retail-returns";

/**
 * 零售退換貨（`/retail/returns`）：按單號 / 序號 / 條碼反查原單 → 行級退貨 → 退款 + 回補庫存。
 *
 * ⚠️ 呢頁只做**退貨**；換貨走「退貨 + 開新單」兩步（金額差額由收銀台找補），
 * 唔喺呢頁一次過完成（避免繞過正常結帳路徑 → 出票 / 上雲都可能漏）。
 */
export default function RetailReturnsPage() {
  return (
    <AuthGuard>
      <RetailReturns />
    </AuthGuard>
  );
}
