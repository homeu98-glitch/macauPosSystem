import { AuthGuard } from "@/components/auth-guard";
import { SoldOutPage } from "@/components/soldout-page";

export default function SoldOutRoute() {
  return (
    <AuthGuard>
      <SoldOutPage />
    </AuthGuard>
  );
}

