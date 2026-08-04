"use client";

import { useEffect, useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { PosOrder } from "@/lib/types";

function formatMoney(amount: number) {
  return `MOP ${amount.toFixed(0)}`;
}

export function ReportsDashboard() {
  const [range, setRange] = useState<"today" | "30d">("today");
  const [orders, setOrders] = useState<PosOrder[]>([]);

  useEffect(() => {
    async function loadOrdersFromApi() {
      try {
        const response = await fetch("/api/pos/orders");
        const payload = (await response.json()) as { orders?: PosOrder[] };
        setOrders(payload.orders ?? []);
      } catch {
        setOrders([]);
      }
    }

    void loadOrdersFromApi();
  }, []);

  const filteredOrders = useMemo(() => {
    const now = new Date();
    return orders
      .filter((order) => {
        if (order.status !== "settled") return false;
        const date = new Date(order.updatedAt);
        if (range === "today") {
          return (
            date.getFullYear() === now.getFullYear() &&
            date.getMonth() === now.getMonth() &&
            date.getDate() === now.getDate()
          );
        }
        const diff = now.getTime() - date.getTime();
        return diff <= 30 * 24 * 60 * 60 * 1000;
      })
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }, [orders, range]);

  const summary = useMemo(() => {
    const total = filteredOrders.reduce((sum, order) => sum + order.total, 0);
    return {
      total,
      count: filteredOrders.length,
      settled: filteredOrders.filter((order) => order.status === "settled").length,
    };
  }, [filteredOrders]);

  const orderRows = useMemo(() => {
    return filteredOrders.map((order) => ({
      id: order.localOrderNo,
      table: order.tableName,
      status: order.status,
      total: order.total,
      payment: order.paymentMethod ?? "--",
      time: order.updatedAt.replace("T", " ").slice(0, 16),
      items: order.items.reduce((sum, item) => sum + item.quantity, 0),
    }));
  }, [filteredOrders]);

  const detailTitle = range === "today" ? "今日訂單明細" : "最近 30 天訂單明細";

  return (
    <div className="h-screen overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="flex h-screen overflow-hidden lg:pl-[72px]">
        <main className="flex h-full flex-1 flex-col overflow-hidden">
          <div className="border-b border-slate-200 bg-white px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">報表</div>
                <div className="mt-1 text-sm text-slate-500">讓商家查看今天或最近 30 天營業額。</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className={`rounded-full px-4 py-2 text-sm font-semibold ${
                    range === "today" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
                  }`}
                  onClick={() => setRange("today")}
                  type="button"
                >
                  今日
                </button>
                <button
                  className={`rounded-full px-4 py-2 text-sm font-semibold ${
                    range === "30d" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
                  }`}
                  onClick={() => setRange("30d")}
                  type="button"
                >
                  最近 30 天
                </button>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-auto p-4">
            <div className="grid gap-3 md:grid-cols-3">
              <article className="rounded-2xl border border-slate-200 bg-white p-5">
                <div className="text-sm text-slate-500">營業額</div>
                <div className="mt-2 text-3xl font-semibold text-slate-900">{formatMoney(summary.total)}</div>
              </article>
              <article className="rounded-2xl border border-slate-200 bg-white p-5">
                <div className="text-sm text-slate-500">訂單數</div>
                <div className="mt-2 text-3xl font-semibold text-slate-900">{summary.count}</div>
              </article>
              <article className="rounded-2xl border border-slate-200 bg-white p-5">
                <div className="text-sm text-slate-500">已結帳</div>
                <div className="mt-2 text-3xl font-semibold text-slate-900">{summary.settled}</div>
              </article>
            </div>

            <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <div className="text-base font-semibold text-slate-900">{detailTitle}</div>
                <div className="text-xs text-slate-500">共 {orderRows.length} 筆</div>
              </div>

              <div className="mt-3 overflow-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="text-left text-xs font-semibold text-slate-500">
                      <th className="border-b border-slate-200 py-2 pr-3">單號</th>
                      <th className="border-b border-slate-200 py-2 pr-3">桌號</th>
                      <th className="border-b border-slate-200 py-2 pr-3">狀態</th>
                      <th className="border-b border-slate-200 py-2 pr-3">品項數</th>
                      <th className="border-b border-slate-200 py-2 pr-3">支付</th>
                      <th className="border-b border-slate-200 py-2 pr-3">金額</th>
                      <th className="border-b border-slate-200 py-2">時間</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orderRows.length === 0 ? (
                      <tr>
                        <td className="py-6 text-slate-500" colSpan={7}>
                          這段時間內沒有訂單
                        </td>
                      </tr>
                    ) : (
                      orderRows.map((row) => (
                        <tr key={row.id} className="text-slate-700">
                          <td className="border-b border-slate-100 py-2 pr-3 font-semibold text-slate-900">
                            {row.id}
                          </td>
                          <td className="border-b border-slate-100 py-2 pr-3">{row.table}</td>
                          <td className="border-b border-slate-100 py-2 pr-3">{row.status}</td>
                          <td className="border-b border-slate-100 py-2 pr-3">{row.items}</td>
                          <td className="border-b border-slate-100 py-2 pr-3">{row.payment}</td>
                          <td className="border-b border-slate-100 py-2 pr-3 font-semibold text-slate-900">
                            {formatMoney(row.total)}
                          </td>
                          <td className="border-b border-slate-100 py-2">{row.time}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
