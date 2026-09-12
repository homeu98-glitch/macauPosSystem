"use client";

import { useEffect, type ReactNode } from "react";

import { RetailSidebar } from "@/components/retail/retail-sidebar";
import { tryAutoPairCompanion } from "@/lib/print-bridge/auto-pair-companion";

/**
 * 零售共享 layout（`/retail/*`）。
 *
 * 同 salon 嘅分別：**側欄放喺 layout 而唔係逐頁 render** ——
 * salon 係「頁面自行渲染側欄」，但零售得幾個頁，放 layout 少一層重複、
 * 亦保證導航一致性（唔會有一頁漏咗側欄）。
 *
 * 只做一次開機動作（module-level flag 保證唔會每次轉頁都跑）：
 * 自動配對 Companion（打印通道）。
 *
 * ⚠️ 唔喺呢度讀商品主檔 —— 商品係**頁面級**資料（商品頁要 mutation），
 * 放 layout 會令兩個頁各自持有唔同 copy 而打架。
 */

let bootstrapped = false;

export default function RetailLayout({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (bootstrapped) return;
    bootstrapped = true;
    tryAutoPairCompanion();
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <RetailSidebar />
      {/* 底部留位畀 mobile 導航條 */}
      <main className="pb-20 md:pb-0 md:pl-[72px]">{children}</main>
    </div>
  );
}
