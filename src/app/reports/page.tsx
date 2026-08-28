import { RestaurantDailyReport } from "@/components/restaurant-daily-report";
import { AuthGuard } from "@/components/auth-guard";

export default function ReportsPage() {
  return (
    <AuthGuard>
      <RestaurantDailyReport />
    </AuthGuard>
  );
}
