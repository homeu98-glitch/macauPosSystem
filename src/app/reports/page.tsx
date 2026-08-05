import { ReportsDashboard } from "@/components/reports-dashboard";
import { AuthGuard } from "@/components/auth-guard";

export default function ReportsPage() {
  return (
    <AuthGuard>
      <ReportsDashboard />
    </AuthGuard>
  );
}
