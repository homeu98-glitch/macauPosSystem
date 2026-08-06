import { AuthGuard } from "@/components/auth-guard";
import { PrintCenter } from "@/components/print-center";

export default function PrintsPage() {
  return (
    <AuthGuard>
      <PrintCenter />
    </AuthGuard>
  );
}

