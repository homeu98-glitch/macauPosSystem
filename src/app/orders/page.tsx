import { OnlineOrders } from "@/components/online-orders";
import { AuthGuard } from "@/components/auth-guard";

export default function OrdersPage() {
  return (
    <AuthGuard>
      <OnlineOrders />
    </AuthGuard>
  );
}
