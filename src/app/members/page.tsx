import { MembersPage } from "@/components/members-page";
import { AuthGuard } from "@/components/auth-guard";

export default function MembersRoute() {
  return (
    <AuthGuard>
      <MembersPage />
    </AuthGuard>
  );
}
