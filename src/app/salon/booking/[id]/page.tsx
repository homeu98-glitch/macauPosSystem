import { AuthGuard } from "@/components/auth-guard";
import { ServiceRunner } from "@/components/salon/service-runner";

export default function SalonBookingDetailPage() {
  return (
    <AuthGuard>
      <ServiceRunner />
    </AuthGuard>
  );
}
