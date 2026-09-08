// 細粒度打印開關（2026-09-08 引入）。
//
// 商家喺設備設置 → 打印開關設置逐項控制：廚房單 / 飲品標籤單 / 結帳收據 /
// 退菜單 / 返結單 / 自助機小票 / 交班單。**只**影響**自動**流程（落單、加單、
// 結帳、退菜、退桌、返結、線上單接單+取消+完成、自助單補建、自助機小票、closeShift）。
//
// **手動**觸發永遠不查呢個閘門：點餐介面「打印廚房單」/「打印收據」、訂單列
//「重打整單」、打印中心「重打整單」、交班頁「重打交班單」等**手動觸發**嘅入口
// 唔受開關影響，開關熄咗都要照印（手動 = 用戶當下意圖，唔可以偷偷食掉）。
//
// 抽離呢個 file 嘅原因：`print-jobs.ts` 同 `ledger-pos-bridge.ts` 互相 import，
// 為咗避免循環依賴，將「讀設定」嘅純函數獨立一份。
//
// 真源：`PosLocalSettings.printContentToggles`（本機 localStorage，store scope，唔跨店）。

import { loadPosLocalSettings } from "@/lib/storage";
import type { PrintContentKind } from "@/lib/types";

/**
 * 讀取對應 kind 嘅細粒度開關。缺少欄位一律視為 true（向後相容：升級唔會偷偷關閉）。
 *
 * ⚠️ SSR 安全：loadPosLocalSettings 內部已用 `typeof window === "undefined"` 短路，
 * 呢個函數響 server / client 都安全。設計畀 React 渲染同 event handler 用都得。
 */
export function isPrintContentEnabled(kind: PrintContentKind): boolean {
  const settings = loadPosLocalSettings();
  return settings.printContentToggles?.[kind] !== false;
}
