import { AuthGuard } from "@/components/auth-guard";
import { MemberTopupPage } from "@/components/member-topup-page";

export default function TopupRoute() {
  return (
    <AuthGuard>
      <MemberTopupPage />
    </AuthGuard>
  );
}
