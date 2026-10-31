import { AuthGuard } from "@/components/auth-guard";
import { DeliveryBoard } from "@/components/delivery/delivery-board";

/**
 * 外送（車手派單）總覽頁。
 *
 * 只顯示 `pos_delivery_jobs` 嘅派單進度；訂單本身（價錢、結帳、返結）仍然喺
 * 「訂單」頁處理 —— 呢一點係刻意嘅：派送只係訂單身上「加一層」，
 * 唔會改動任何現有流程（用戶 2026-10-31 明確要求）。
 */
export default function DeliveryPage() {
  return (
    <AuthGuard>
      <DeliveryBoard />
    </AuthGuard>
  );
}
