"use client";

import { useEffect, useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { PosOrder } from "@/lib/types";

function formatMoney(amount: number) {
  return `MOP ${amount.toFixed(0)}`;
}

export function ReportsDashboard() {
  const [range, setRange] = useState<"all" | "yesterday" | "7d" | "30d">("30d");
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
    const settled = orders.filter((order) => order.status === "settled");
    if (range === "all") {
      return settled.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    }

    const now = new Date();
    if (range === "yesterday") {
      const start = new Date(now);
      start.setDate(now.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setHours(23, 59, 59, 999);
      return settled
        .filter((order) => {
          const t = Date.parse(order.updatedAt);
          return t >= start.getTime() && t <= end.getTime();
        })
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    }

    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    if (range === "7d") start.setDate(now.getDate() - 7);
    if (range === "30d") start.setDate(now.getDate() - 30);
    return settled
      .filter((order) => Date.parse(order.updatedAt) >= start.getTime())
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

  const detailTitle =
    range === "all"
      ? "全部訂單明細"
      : range === "yesterday"
        ? "昨天訂單明細"
        : range === "7d"
          ? "最近 7 天訂單明細"
          : "最近 30 天訂單明細";

  function exportCsv() {
    const rows: Array<Record<string, string | number>> = filteredOrders.map((order) => ({
      單號: order.localOrderNo,
      桌號: order.tableName,
      狀態: order.status,
      金額: order.total,
      折扣: order.discountAmount,
      支付方式: order.paymentMethod ?? "",
      更新時間: order.updatedAt,
    }));

    const headers = Object.keys(rows[0] ?? { 單號: "" });
    const csvLines = [
      headers.join(","),
      ...rows.map((row) =>
        headers
          .map((key) => `"${String(row[key] ?? "").replace(/"/g, '""')}"`)
          .join(","),
      ),
    ];
    const content = "\uFEFF" + csvLines.join("\n");
    const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `報表_${range}_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

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
                {[
                  ["all", "全部"],
                  ["yesterday", "昨天"],
                  ["7d", "最近 7 天"],
                  ["30d", "最近 30 天"],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    className={`rounded-full px-4 py-2 text-sm font-semibold ${
                      range === key ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
                    }`}
                    onClick={() => setRange(key as typeof range)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
                <button
                  className="rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                  onClick={exportCsv}
                  type="button"
                >
                  導出 CSV
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
