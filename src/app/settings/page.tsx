import { DeviceSettings } from "@/components/device-settings";
import { AuthGuard } from "@/components/auth-guard";
import { SettingsGate } from "@/components/settings-gate";

export default function SettingsPage() {
  return (
    <AuthGuard>
      {/* 2026-10-23：L2 操作員冇「設備／菜單設定」權限時擋住呢一頁。 */}
      <SettingsGate>
        <DeviceSettings />
      </SettingsGate>
    </AuthGuard>
  );
}
