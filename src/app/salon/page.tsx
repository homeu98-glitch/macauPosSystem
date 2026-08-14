import { AuthGuard } from "@/components/auth-guard";
import { SalonWorkbench } from "@/components/salon/workbench";

export default function SalonPage() {
  return (
    <AuthGuard>
      <SalonWorkbench />
    </AuthGuard>
  );
}
