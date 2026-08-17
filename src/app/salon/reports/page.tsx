import { AuthGuard } from "@/components/auth-guard";
import { SalonSidebar } from "@/components/salon/salon-sidebar";
import { Reports } from "@/components/salon/reports";

export default function SalonReportsPage() {
  return (
    <AuthGuard>
      <div className="flex h-[100dvh] overflow-hidden md:pl-[72px]">
        <SalonSidebar />
        <div className="flex-1 min-h-0 overflow-y-auto pb-24 md:pb-6">
          <Reports />
        </div>
      </div>
    </AuthGuard>
  );
}
