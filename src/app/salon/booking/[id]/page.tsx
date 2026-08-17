import { AuthGuard } from "@/components/auth-guard";
import { ServiceRunner } from "@/components/salon/service-runner";
import { SalonSidebar } from "@/components/salon/salon-sidebar";

export default function SalonBookingDetailPage() {
  return (
    <AuthGuard>
      <div className="flex h-[100dvh] overflow-hidden md:pl-[72px]">
        <SalonSidebar />
        <div className="flex-1 min-h-0 overflow-y-auto pb-24 md:pb-6">
          <ServiceRunner />
        </div>
      </div>
    </AuthGuard>
  );
}
