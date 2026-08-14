import { AuthGuard } from "@/components/auth-guard";
import { CustomerProfile } from "@/components/salon/customer-profile";
import { SalonSidebar } from "@/components/salon/salon-sidebar";

export default function SalonCustomerDetailPage() {
  return (
    <AuthGuard>
      <div className="flex min-h-screen md:pl-[72px]">
        <SalonSidebar />
        <div className="flex-1">
          <CustomerProfile />
        </div>
      </div>
    </AuthGuard>
  );
}
