import { AuthGuard } from "@/components/auth-guard";
import { SalonSidebar } from "@/components/salon/salon-sidebar";
import { Reports } from "@/components/salon/reports";

export default function SalonReportsPage() {
  return (
    <AuthGuard>
      <div className="flex min-h-screen md:pl-[72px]">
        <SalonSidebar />
        <div className="flex-1">
          <Reports />
        </div>
      </div>
    </AuthGuard>
  );
}
