"use client";

import { useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { LocalOrdersPanel } from "@/components/local-orders-panel";
import { OnlineOrders } from "@/components/online-orders";
import { LEDGER_ORDER_DATE_FILTERS, LedgerOrderDateFilter } from "@/lib/ledger/order-date-filter";

export function OrdersHub() {
  const [dateFilter, setDateFilter] = useState<LedgerOrderDateFilter>("today");

  return (
    <div className="h-[100dvh] overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="flex h-[100dvh] flex-col overflow-hidden md:pl-[72px]">
        <header className="shrink-0 border-b border-slate-200 bg-white px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-lg font-semibold text-slate-900">訂單</div>
              <div className="mt-0.5 text-sm text-slate-500">左：會員通線上訂單 · 右：店內線下訂單</div>
            </div>
            <div className="flex flex-wrap gap-1 rounded-full bg-slate-100 p-1">
              {LEDGER_ORDER_DATE_FILTERS.map((filter) => (
                <button
                  key={filter.key}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                    filter.key === dateFilter ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"
                  }`}
                  onClick={() => setDateFilter(filter.key)}
                  type="button"
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 divide-y divide-slate-200 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-slate-50">
            <OnlineOrders dateFilter={dateFilter} embedded onDateFilterChange={setDateFilter} />
          </section>
          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-white">
            <LocalOrdersPanel dateFilter={dateFilter} />
          </section>
        </div>
      </div>
    </div>
  );
}
