import { AuthGuard } from "@/components/auth-guard";
import { SalonSidebar } from "@/components/salon/salon-sidebar";
import { Settings } from "@/components/salon/settings";

export default function SalonSettingsPage() {
  return (
    <AuthGuard>
      <div className="flex min-h-screen md:pl-[72px]">
        <SalonSidebar />
        <div className="flex-1">
          <Settings />
        </div>
      </div>
    </AuthGuard>
  );
}
