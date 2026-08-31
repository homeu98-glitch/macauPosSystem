import { PosApp } from "@/components/pos-app";
import { AuthGuard } from "@/components/auth-guard";
import { KioskModeGate } from "@/components/kiosk-mode-gate";

export default function Home() {
  return (
    <AuthGuard>
      <KioskModeGate>
        <PosApp />
      </KioskModeGate>
    </AuthGuard>
  );
}
