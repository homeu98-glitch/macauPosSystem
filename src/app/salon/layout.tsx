"use client";

import { useEffect, type ReactNode } from "react";

import { hydrateSalonFromPosDb } from "@/lib/salon/storage";

// Salon 共享 layout：喺所有 /salon/* 頁面掛載時，由 POS DB hydrate 一次。
// 唔改變現有頁面結構（頁面自行渲染 SalonSidebar + 內容）。
// 冪等：module-level started 保證每個頁面載入只 hydrate 一次。

let hydrateStarted = false;

export default function SalonLayout({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (hydrateStarted) return;
    hydrateStarted = true;
    void hydrateSalonFromPosDb();
  }, []);

  return <>{children}</>;
}
