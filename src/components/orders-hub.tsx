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
              <div className="mt-0.5 text-sm text-slate-500">上：會員通線上訂單 · 下：店內線下訂單</div>
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
        {/*
          列表版面（2026-09-10）：由左右分欄改為上下分區、每區全寬。
          原因：訂單列表每個 8 欄（單號／餐台／時間／菜品／金額／狀態／來源·支付／操作），
          半欄寬度會逼爆欄位；全寬先可以做到金額右對齊 + 操作釘右。
          響應式（2026-09-10 修）：兩個表都改用「`table-fixed` + 百分比欄寬」自適應容器闊度，
          所以正常 iPad／桌面闊度下唔會再出現橫向滾動，亦唔會剪走「操作」欄；
          只有容器窄過表格下限（<860px，例如手機）先由各表自己橫向滾動。
        */}
        <div className="grid min-h-0 flex-1 grid-rows-2 divide-y divide-slate-200">
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
