import { AuthGuard } from "@/components/auth-guard";
import { SalonSidebar } from "@/components/salon/salon-sidebar";
import { PrintsList } from "@/components/salon/prints-list";

export default function SalonPrintsPage() {
  return (
    <AuthGuard>
      <div className="flex min-h-screen md:pl-[72px]">
        <SalonSidebar />
        <div className="flex-1">
          <PrintsList />
        </div>
      </div>
    </AuthGuard>
  );
}
