"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type OrderTypeKey = "all" | "dine_in" | "pickup" | "self_delivery" | "rider_delivery";

type OnlineOrder = {
  id: string;
  type: OrderTypeKey;
  status: string;
  customerName?: string;
  total?: number;
  createdAt?: string;
  items?: Array<{ name: string; qty: number }>;
};

const TABS: Array<{ key: OrderTypeKey; label: string }> = [
  { key: "all", label: "全部" },
  { key: "dine_in", label: "堂食" },
  { key: "pickup", label: "外賣自取" },
  { key: "self_delivery", label: "自送" },
  { key: "rider_delivery", label: "車手送單" },
];

function formatMoney(amount: number) {
  return `MOP ${amount.toFixed(0)}`;
}

export function OnlineOrders() {
  const [activeTab, setActiveTab] = useState<OrderTypeKey>("all");
  const [loading, setLoading] = useState(false);
  const [orders, setOrders] = useState<OnlineOrder[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/online-orders?type=${activeTab}`);
        const payload = (await response.json()) as {
          ok: boolean;
          orders: OnlineOrder[];
          error?: string;
        };

        if (!payload.ok) {
          throw new Error(payload.error ?? "讀取線上訂單失敗");
        }

        if (!cancelled) {
          setOrders(payload.orders ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "讀取失敗");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  const stats = useMemo(() => {
    const total = orders.length;
    const pending = orders.filter((order) => order.status === "new").length;
    return { total, pending };
  }, [orders]);

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
            <div className="flex flex-col items-center gap-2 rounded-2xl bg-orange-500 px-2 py-3 text-xs font-semibold text-white">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10">單</span>
              <span>訂單</span>
            </div>
          </div>
          <div className="grid gap-2">
            <Link
              className="rounded-2xl bg-slate-800 px-2 py-2 text-center text-xs font-semibold text-slate-200"
              href="/settings"
            >
              設置
            </Link>
            <Link
              className="rounded-2xl bg-slate-800 px-2 py-2 text-center text-xs font-semibold text-slate-200"
              href="/reports"
            >
              報表
            </Link>
          </div>
        </aside>

        <main className="flex h-full flex-1 flex-col overflow-hidden">
          <div className="border-b border-slate-200 bg-white px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">線上訂單</div>
                <div className="mt-1 text-sm text-slate-500">
                  類型：{TABS.find((tab) => tab.key === activeTab)?.label} · 共 {stats.total} 張 · 新單{" "}
                  {stats.pending} 張
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {TABS.map((tab) => (
                  <button
                    key={tab.key}
                    className={`rounded-full px-4 py-2 text-sm font-semibold ${
                      tab.key === activeTab
                        ? "bg-orange-500 text-white"
                        : "bg-slate-100 text-slate-700"
                    }`}
                    onClick={() => setActiveTab(tab.key)}
                    type="button"
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-auto p-4">
            {error ? (
              <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                {error}
              </div>
            ) : null}

            {loading ? (
              <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
                正在載入…
              </div>
            ) : null}

            {!loading && orders.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
                目前沒有訂單
              </div>
            ) : null}

            <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
              {orders.map((order) => (
                <article key={order.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">{order.id}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        {order.createdAt ? order.createdAt.replace("T", " ").slice(0, 16) : "--"}
                      </div>
                    </div>
                    <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-semibold text-orange-700">
                      {order.status}
                    </span>
                  </div>
                  <div className="mt-3 text-sm text-slate-700">
                    {order.customerName ? `客戶：${order.customerName}` : "客戶：--"}
                  </div>
                  <div className="mt-2 text-sm font-semibold text-slate-900">
                    {typeof order.total === "number" ? formatMoney(order.total) : "金額：--"}
                  </div>
                  {order.items?.length ? (
                    <div className="mt-3 grid gap-1 text-xs text-slate-600">
                      {order.items.slice(0, 4).map((item) => (
                        <div key={item.name} className="flex items-center justify-between">
                          <span>{item.name}</span>
                          <span>x{item.qty}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <button
                      className="rounded-2xl bg-white px-3 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                      type="button"
                    >
                      查看
                    </button>
                    <button
                      className="rounded-2xl bg-orange-500 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-600"
                      type="button"
                    >
                      接單
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
