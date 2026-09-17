import { SelectWorkbenchScreen } from "@/components/select-workbench-screen";

/**
 * `/select-workbench` —— 工作台選擇頁（見 migration 0037 / docs/127）。
 *
 * 改版之前，工作台（快餐／堂食／美容／自助點餐機／後廚屏／出餐台屏）係喺
 * **登入頁**揀嘅。而家拆開：`/login` 只證明身份，入到嚟呢一頁先揀崗位，
 * 而且只列 Admin 後台已開通嘅模組。
 *
 * ## ⚠️ 2026-09-17：`/` 已經係統一入口，呢條路徑係**相容別名**
 *
 * `/`（`src/app/page.tsx`）render **同一個元件**，而且係對外唯一入口
 * （PWA `start_url`、登入後導向、側欄「工作台」掣全部用 `/`）。
 *
 * 保留呢條路徑嘅兩個實際理由：
 *
 * 1. **舊書籤／文件／截圖**繼續有效，唔會 404。
 * 2. **落單專用終端嘅逃生門** —— 佢喺 `order-only-terminal.ts` 嘅白名單入面，
 *    而 `/` **唔喺**（落單專用終端去 `/` 會被導向 `/staff`）。
 *    所以店員手機嘅「工作台」掣**必須**指呢條路徑，指 `/` 會無限跳轉。
 *
 * ⚠️ 刻意**唔**包 `AuthGuard`：呢一頁係最小逃生門，只靠
 * `SelectWorkbenchScreen` 自己「冇 session 就彈返 `/login`」嘅檢查。
 * 包多層閘只會多一個失效點（例如落單專用終端被 `AuthGuard` 攔住就冇得逃生）。
 */
export default function SelectWorkbenchPage() {
  return <SelectWorkbenchScreen />;
}
