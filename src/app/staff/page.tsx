import { AuthGuard } from "@/components/auth-guard";
import { StaffMobileApp } from "@/components/staff/staff-mobile-app";

/**
 * 店員手機落單（`/staff`，2026-09-16）。
 *
 * ## 呢一頁係乜
 *
 * 店員用手機喺**枱邊**幫客人現場點餐。落單後訂單直接入後台，並由
 * 雲端 `pos_print_jobs` 派工印廚房單（同自助點餐機一致）。
 *
 * ## 三條邊界（唔好越界）
 *
 * 1. **唔直連打印機** —— 手機冇藍牙、冇網段要求，出紙一律經雲端派工。
 *    呢個係刻意嘅：實機上「中繼機同打印機同網段」已經係最常出事嘅一環，
 *    唔應該再喺手機度重演一次。
 * 2. **唔收款結帳** —— 手機只負責落單，埋單由收銀台做。
 * 3. **唔印客人小票** —— 小票由收銀台結帳時出。
 *
 * ## ⚠️ 一定要 `AuthGuard`
 *
 * 店員單**帶 POS 終端憑證**（`authSession.posDeviceToken`），靠佢行
 * `/api/pos/sync` 嘅「已授權」分支 —— 呢個正正係繞過匿名白名單
 * （`ANONYMOUS_ALLOWED_SOURCES = {scan, kiosk}`）嘅唯一正路。
 * 冇登入 = 冇憑證 = 落單被 401 拒。
 */
export default function StaffRoute() {
  return (
    <AuthGuard>
      <StaffMobileApp />
    </AuthGuard>
  );
}
