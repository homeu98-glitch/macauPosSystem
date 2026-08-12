"use client";

import { AppSidebar } from "@/components/app-sidebar";
import { LocalOrdersPanel } from "@/components/local-orders-panel";
import { OnlineOrders } from "@/components/online-orders";

export function OrdersHub() {
  return (
    <div className="h-[100dvh] overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="flex h-[100dvh] flex-col overflow-hidden md:pl-[72px]">
        <header className="shrink-0 border-b border-slate-200 bg-white px-4 py-4">
          <div className="text-lg font-semibold text-slate-900">訂單</div>
          <div className="mt-1 text-sm text-slate-500">左：會員通線上訂單 · 右：店內線下訂單</div>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 divide-y divide-slate-200 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-slate-50">
            <OnlineOrders embedded />
          </section>
          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-white">
            <LocalOrdersPanel />
          </section>
        </div>
      </div>
    </div>
  );
}
