import { DeviceSettings } from "@/components/device-settings";
import { AuthGuard } from "@/components/auth-guard";

export default function SettingsPage() {
  return (
    <AuthGuard>
      <DeviceSettings />
    </AuthGuard>
  );
}
