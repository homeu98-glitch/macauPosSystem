import { OperatorSignInScreen } from "@/components/operator-signin-screen";

/**
 * `/operator` —— 店員簽到（L2）。
 *
 * 唔用 `AuthGuard`：呢一頁自己判斷「有冇 L1 session」，冇就顯示「請先登入」
 * 而唔係即刻踢去 `/login`（店員可能只係手快開錯，唔應該打斷流程）。
 */
export default function OperatorPage() {
  return <OperatorSignInScreen />;
}
