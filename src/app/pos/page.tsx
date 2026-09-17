import { PosApp } from "@/components/pos-app";
import { AuthGuard } from "@/components/auth-guard";
import { KioskModeGate } from "@/components/kiosk-mode-gate";

/**
 * 收銀台（堂食 / 快餐）首頁 —— **2026-09-17 由 `/` 搬過嚟**。
 *
 * ## 為何要搬
 *
 * 原設計 `/` 就係收銀台。但商家需要一個**統一入口**：由
 * `https://macau-pos-system.vercel.app/` 入去之後，自己揀呢部機做邊個端別
 * （堂食／快餐／零售／美容／店員手機／自助點餐機／後廚屏／出餐台屏）。
 *
 * 所以 `/` 改為「工作台選擇頁」，收銀台搬到 `/pos`。
 *
 * ⚠️ `homePath` 係**由 `module-catalog.ts` 驅動**（dinein / quick → `/pos`）。
 *    改呢個路由同改 `homePath` **必須同步**，否則登入後會被送去一個唔存在嘅路徑。
 *
 * ## KioskModeGate 為何兩邊都要掛
 *
 * `KioskModeGate` 嘅作用係「呢部機開咗自助點餐模式 ⇒ 唔准 render 收銀台」。
 * 搬完之後 `/` 同 `/pos` 都可以通去收銀台，所以**兩邊都要掛**：
 * - 掛喺 `/`：避免自助機停喺選擇頁（自助機唔應該有人揀工作台）。
 * - 掛喺 `/pos`：防止有人用書籤／深連結繞過 `/` 直接入收銀台。
 *
 * 呢個同搬之前嘅有效行為一致（當時 `/` 有掛，而 `/` 就係唯一入口）。
 */
export default function PosRoute() {
  return (
    <AuthGuard>
      <KioskModeGate>
        <PosApp />
      </KioskModeGate>
    </AuthGuard>
  );
}
