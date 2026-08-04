"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { loadOrders } from "@/lib/storage";

function formatMoney(amount: number) {
  return `MOP ${amount.toFixed(0)}`;
}

export function ReportsDashboard() {
  const [range, setRange] = useState<"today" | "30d">("today");
  const orders = loadOrders();

  const summary = useMemo(() => {
    const now = new Date();
    const filtered = orders.filter((order) => {
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
    });

    return {
      total: filtered.reduce((sum, order) => sum + order.total, 0),
      count: filtered.length,
      settled: filtered.filter((order) => order.status === "settled").length,
    };
  }, [orders, range]);

  return (
    <div className="h-screen overflow-hidden bg-slate-100">
      <div className="flex h-screen overflow-hidden">
        <aside className="hidden w-[72px] shrink-0 flex-col justify-between bg-slate-900 px-2 py-3 text-white lg:flex">
          <div className="grid gap-2">
            <Link
              className="flex flex-col items-center gap-2 rounded-2xl bg-slate-800 px-2 py-3 text-xs font-semibold text-slate-200"
              href="/"
            >
              <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10">點</span>
              <span>點餐</span>
            </Link>
            <Link
              className="flex flex-col items-center gap-2 rounded-2xl bg-slate-800 px-2 py-3 text-xs font-semibold text-slate-200"
              href="/orders"
            >
              <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10">單</span>
              <span>訂單</span>
            </Link>
            <div className="flex flex-col items-center gap-2 rounded-2xl bg-orange-500 px-2 py-3 text-xs font-semibold text-white">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10">報</span>
              <span>報表</span>
            </div>
          </div>
          <Link
            className="rounded-2xl bg-slate-800 px-2 py-2 text-center text-xs font-semibold text-slate-200"
            href="/settings"
          >
            設置
          </Link>
        </aside>

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
          </div>
        </main>
      </div>
    </div>
  );
}

