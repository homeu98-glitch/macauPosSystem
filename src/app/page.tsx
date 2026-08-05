import { PosApp } from "@/components/pos-app";
import { AuthGuard } from "@/components/auth-guard";

export default function Home() {
  return (
    <AuthGuard>
      <PosApp />
    </AuthGuard>
  );
}
