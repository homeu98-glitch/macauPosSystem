import { AuthGuard } from "@/components/auth-guard";
import { StaffDetail } from "@/components/salon/staff-detail";
import { SalonSidebar } from "@/components/salon/salon-sidebar";

export default function SalonStaffDetailPage() {
  return (
    <AuthGuard>
      <div className="flex h-[100dvh] overflow-hidden md:pl-[72px]">
        <SalonSidebar />
        <div className="flex-1 min-h-0 overflow-y-auto pb-24 md:pb-6">
          <StaffDetail />
        </div>
      </div>
    </AuthGuard>
  );
}
