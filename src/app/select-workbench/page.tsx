import { SelectWorkbenchScreen } from "@/components/select-workbench-screen";

/**
 * `/select-workbench` —— 登入之後嘅第一步（見 migration 0037 / docs/127）。
 *
 * 改版之前，工作台（快餐／堂食／美容／自助點餐機／後廚屏／出餐台屏）係喺
 * **登入頁**揀嘅。而家拆開：`/login` 只證明身份，入到嚟呢一頁先揀崗位，
 * 而且只列 Admin 後台已開通嘅模組。
 */
export default function SelectWorkbenchPage() {
  return <SelectWorkbenchScreen />;
}
