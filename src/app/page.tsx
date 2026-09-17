import { AuthGuard } from "@/components/auth-guard";
import { KioskModeGate } from "@/components/kiosk-mode-gate";
import { SelectWorkbenchScreen } from "@/components/select-workbench-screen";

/**
 * **統一入口**（2026-09-17）。
 *
 * ## 呢一頁做咩
 *
 * 商家由 `https://macau-pos-system.vercel.app/` 入嚟，喺呢度**揀呢部機做邊個端別**：
 * 堂食收銀台／快餐收銀台／零售收銀台／美容管理／店員手機／自助點餐機／後廚屏／出餐台屏。
 *
 * 每個端別嘅首頁由 `module-catalog.ts` 嘅 `homePath` 決定（單一真源）：
 *
 * | 端別 | 首頁 |
 * |---|---|
 * | 堂食／快餐／零售 | `/pos` · `/retail` |
 * | 店員手機 | `/staff` |
 * | 自助點餐機 | `/order` |
 * | 後廚屏／出餐台屏 | `/kitchen` · `/expo` |
 *
 * ## 搬遷歷史（唔好搞錯）
 *
 * 2026-09-17 之前 `/` **就係收銀台**。改為統一入口之後收銀台搬去 `/pos`。
 * 兩個位置**必須同步**（`homePath` ↔ `src/app/pos/page.tsx`），
 * 否則登入後會被送去一個唔存在嘅路徑。
 *
 * ## 三層閘（順序有意義）
 *
 * 1. `AuthGuard` —— 冇 session ⇒ `/login`；**落單專用終端**（店員手機）會被導向 `/staff`。
 * 2. `KioskModeGate` —— 呢部機開咗自助點餐模式 ⇒ 直接跳 `/order`，
 *    唔會停喺選擇頁（自助機前面冇人負責揀工作台）。
 * 3. `SelectWorkbenchScreen` —— 列出**Admin 已開通**嘅端別；未開通嘅灰住顯示（唔隱藏）。
 *
 * ## `/select-workbench` 點解仍然存在
 *
 * 佢同呢一頁 render **同一個元件**，保留原因有二：
 * ① 舊書籤／文件／側欄入口（`device-settings` 同側欄都用佢）唔會爛；
 * ② 佢係落單專用終端嘅**逃生門**（`order-only-terminal.ts` 白名單），
 *    冇咗就換唔返工作台。
 */
export default function Entry() {
  return (
    <AuthGuard>
      <KioskModeGate>
        <SelectWorkbenchScreen />
      </KioskModeGate>
    </AuthGuard>
  );
}
