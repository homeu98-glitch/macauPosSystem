import { AuthGuard } from "@/components/auth-guard";
import { CustomersList } from "@/components/salon/customers-list";
import { SalonSidebar } from "@/components/salon/salon-sidebar";

export default function SalonCustomersPage() {
  return (
    <AuthGuard>
      <div className="flex min-h-screen md:pl-[72px]">
        <SalonSidebar />
        <div className="flex-1">
          <CustomersList />
        </div>
      </div>
    </AuthGuard>
  );
}
