import { BookFlow } from "@/components/reservation/book-flow";

/**
 * 客人自助訂位（手機 H5）—— `/book?storeId=<店>&from=ledger`
 *
 * ## 點解喺 POS repo 而唔係 Macau-Ledger
 *
 * 訂位資料（配額、菜單現價、會員折扣）全部住喺 POS Supabase。
 * 做喺 POS 呢邊，客人揀時段同預點菜係**零時差**讀到真資料；
 * 做喺 Ledger 就要跨庫同步菜單，沽清／改價一定慢一拍。
 *
 * Macau-Ledger 商家頁只需要加一個「訂位」按鈕跳過嚟
 * （見 `merchant-profile-quick-actions.tsx`）。就算 Ledger 一行 code 都唔改，
 * 呢頁印成 QR 貼門口、放 IG 一樣用得。
 *
 * ⚠️ 匿名頁：**唔好**加 `AppSidebar` / `LangProvider` / POS 登入檢查。
 *    亦唔好加入 `ORDER_ONLY_ALLOWED_PATHS`（嗰個係店員終端白名單）。
 */
export const dynamic = "force-dynamic";

export default function BookPage() {
  return <BookFlow />;
}
