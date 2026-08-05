import { AuthGuard } from "@/components/auth-guard";
import { ShiftPage } from "@/components/shift-page";

export default function ShiftRoute() {
  return (
    <AuthGuard>
      <ShiftPage />
    </AuthGuard>
  );
}

