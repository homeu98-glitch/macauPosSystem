import { AuthGuard } from "@/components/auth-guard";
import { ReservationAccessGuard } from "@/components/reservation/reservation-access-guard";
import { ReservationBoard } from "@/components/reservation/reservation-board";

/**
 * 訂位台頁。
 *
 * 同「外送」頁同一寫法：`AuthGuard` 包住，實際內容全部喺 client component。
 * 路由本身唔做資料讀取 —— 訂位一定要帶 storeId 同裝置憑證，
 * 喺 server component 讀只會多一層失敗路徑。
 *
 * 2026-11-07：再加一層 `ReservationAccessGuard` —— 平台未喺 Admin panel
 * 為呢間店開通「訂位」時，側欄唔會出掣，直接打 URL 亦只會見提示頁。
 */
export default function ReservationsPage() {
  return (
    <AuthGuard>
      <ReservationAccessGuard>
        <ReservationBoard />
      </ReservationAccessGuard>
    </AuthGuard>
  );
}
