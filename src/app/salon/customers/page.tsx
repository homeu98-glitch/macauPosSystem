import { AuthGuard } from "@/components/auth-guard";
import { CustomersList } from "@/components/salon/customers-list";
import { SalonSidebar } from "@/components/salon/salon-sidebar";

export default function SalonCustomersPage() {
  return (
    <AuthGuard>
      <div className="flex h-[100dvh] overflow-hidden md:pl-[72px]">
        <SalonSidebar />
        <div className="flex-1 min-h-0 overflow-y-auto pb-24 md:pb-6">
          <CustomersList />
        </div>
      </div>
    </AuthGuard>
  );
}
