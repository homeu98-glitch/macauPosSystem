import { AuthGuard } from "@/components/auth-guard";
import { SalonWorkbench } from "@/components/salon/workbench";

export default function SalonPage() {
  return (
    <AuthGuard>
      <div className="flex h-screen flex-col">
        <SalonWorkbench />
      </div>
    </AuthGuard>
  );
}
