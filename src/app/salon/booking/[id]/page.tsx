import { AuthGuard } from "@/components/auth-guard";
import { ServiceRunner } from "@/components/salon/service-runner";
import { SalonSidebar } from "@/components/salon/salon-sidebar";

export default function SalonBookingDetailPage() {
  return (
    <AuthGuard>
      <div className="flex min-h-screen md:pl-[72px]">
        <SalonSidebar />
        <div className="flex-1">
          <ServiceRunner />
        </div>
      </div>
    </AuthGuard>
  );
}
