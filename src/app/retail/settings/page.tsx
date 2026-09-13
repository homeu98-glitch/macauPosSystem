import { AuthGuard } from "@/components/auth-guard";
import { RetailSettings } from "@/components/retail/retail-settings";

/**
 * 零售設定（`/retail/settings`）：掃碼槍自動學習、付款方式檢視、折扣 / 改價授權門檻。
 *
 * ⚠️ 打印機設定仍然喺既有「設備設置」頁（同餐飲共用），呢頁唔重複。
 */
export default function RetailSettingsPage() {
  return (
    <AuthGuard>
      <RetailSettings />
    </AuthGuard>
  );
}
