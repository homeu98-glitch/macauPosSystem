import { AdminAccountsPage } from "@/components/admin-accounts-page";
import { AuthGuard } from "@/components/auth-guard";

export default function AdminPage() {
  return (
    <AuthGuard allowedRoles={["admin"]}>
      <AdminAccountsPage />
    </AuthGuard>
  );
}
