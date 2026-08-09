import { PropsWithChildren } from "react";

import { AuthGuard } from "@/components/auth-guard";
import { BackofficeShell } from "@/components/backoffice-shell";

export default function BackofficeLayout({ children }: PropsWithChildren) {
  return (
    <AuthGuard allowedRoles={["admin"]}>
      <BackofficeShell>{children}</BackofficeShell>
    </AuthGuard>
  );
}
