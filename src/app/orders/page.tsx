import { OrdersHub } from "@/components/orders-hub";
import { AuthGuard } from "@/components/auth-guard";

export default function OrdersPage() {
  return (
    <AuthGuard>
      <OrdersHub />
    </AuthGuard>
  );
}
