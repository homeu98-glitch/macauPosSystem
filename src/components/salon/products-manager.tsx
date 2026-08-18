"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import type {
  SalonProduct,
  SalonProductSale,
  SalonStaff,
  SalonCustomerProfile,
  SalonPaymentMethod,
} from "@/lib/salon/types";
import {
  loadSalonProducts,
  saveSalonProducts,
  loadSalonProductSales,
  saveSalonProductSales,
  loadSalonStaff,
  loadCustomers,
} from "@/lib/salon/storage";
import { SALON_STAFF_ROLE_LABELS } from "@/lib/salon/salon-labels";

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const PAYMENT_OPTS: { value: SalonPaymentMethod; label: string }[] = [
  { value: "cash", label: "現金" },
  { value: "card", label: "卡" },
  { value: "ledger_balance", label: "會員餘額" },
  { value: "external", label: "其他" },
];

export function ProductsManager() {
  const [products, setProducts] = useState<SalonProduct[]>([]);
  const [sales, setSales] = useState<SalonProductSale[]>([]);
  const [staffList, setStaffList] = useState<SalonStaff[]>([]);
  const [customers, setCustomers] = useState<SalonCustomerProfile[]>([]);

  const [showEdit, setShowEdit] = useState(false);
  const [editing, setEditing] = useState<SalonProduct | null>(null);

  const [sellTarget, setSellTarget] = useState<SalonProduct | null>(null);
  const [sellStaffId, setSellStaffId] = useState("");
  const [sellCustomerId, setSellCustomerId] = useState("");
  const [sellPayment, setSellPayment] = useState<SalonPaymentMethod>("cash");
  const [sellNote, setSellNote] = useState("");

  useEffect(() => {
    setProducts(loadSalonProducts());
    setSales(loadSalonProductSales());
    setStaffList(loadSalonStaff().filter((s) => s.status === "active"));
    setCustomers(loadCustomers());
  }, []);

  const recentSales = useMemo(
    () => [...sales].sort((a, b) => (a.soldAt < b.soldAt ? 1 : -1)).slice(0, 20),
    [sales],
  );

  const openNew = () => {
    setEditing({
      id: genId("prod"),
      name: "",
      price: 0,
      commissionRate: 10,
      active: true,
      sortOrder: products.length + 1,
    });
    setShowEdit(true);
  };

  const openEdit = (p: SalonProduct) => {
    setEditing({ ...p });
    setShowEdit(true);
  };

  const saveProduct = () => {
    if (!editing) return;
    const next = products.some((p) => p.id === editing.id)
      ? products.map((p) => (p.id === editing.id ? editing : p))
      : [...products, editing];
    saveSalonProducts(next);
    setProducts(next);
    setShowEdit(false);
    setEditing(null);
  };

  const deleteProduct = (p: SalonProduct) => {
    if (!confirm(`確定刪除產品「${p.name}」？`)) return;
    const next = products.filter((x) => x.id !== p.id);
    saveSalonProducts(next);
    setProducts(next);
  };

  const openSell = (p: SalonProduct) => {
    setSellTarget(p);
    setSellStaffId(staffList[0]?.id ?? "");
    setSellCustomerId("");
    setSellPayment("cash");
    setSellNote("");
  };

  const submitSell = () => {
    if (!sellTarget) return;
    if (!sellStaffId) {
      alert("請選擇銷售員工");
      return;
    }
    const staff = staffList.find((s) => s.id === sellStaffId);
    const customer = customers.find((c) => c.id === sellCustomerId);
    const price = sellTarget.price;
    const commissionAmount = Math.round((price * sellTarget.commissionRate) / 100);
    const sale: SalonProductSale = {
      id: genId("sale"),
      productId: sellTarget.id,
      productName: sellTarget.name,
      price,
      commissionRate: sellTarget.commissionRate,
      commissionAmount,
      staffId: sellStaffId,
      staffName: staff?.nickname ?? staff?.name ?? "未知",
      customerId: customer?.id,
      customerName: customer?.name ?? "walk-in",
      paymentMethod: sellPayment,
      soldAt: new Date().toISOString(),
      note: sellNote.trim() || undefined,
    };
    const next = [...sales, sale];
    saveSalonProductSales(next);
    setSales(next);
    setSellTarget(null);
  };

  return (
    <div className="mx-auto max-w-5xl p-4 pb-24 md:p-6 md:pb-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">產品</h1>
        <button
          type="button"
          onClick={openNew}
          className="rounded-xl bg-rose-500 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-600"
        >
          + 新增產品
        </button>
      </div>

      {/* 產品目錄 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {products.map((p) => (
          <div key={p.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-base font-bold text-slate-900">{p.name}</span>
                  {p.category ? (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                      {p.category}
                    </span>
                  ) : null}
                  {!p.active && (
                    <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-400">
                      停用
                    </span>
                  )}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  售價 MOP {p.price}
                  {p.cost != null ? ` · 成本 MOP ${p.cost}` : ""}
                </div>
                <div className="text-xs text-slate-500">佣金率 {p.commissionRate}%（約 MOP {Math.round((p.price * p.commissionRate) / 100)}）</div>
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                <button
                  type="button"
                  onClick={() => openSell(p)}
                  className="rounded-lg bg-rose-100 px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-200"
                >
                  賣出
                </button>
                <button
                  type="button"
                  onClick={() => openEdit(p)}
                  className="rounded-lg bg-white px-2 py-1 text-xs text-slate-600 shadow-sm hover:bg-slate-100"
                >
                  ✎
                </button>
                <button
                  type="button"
                  onClick={() => deleteProduct(p)}
                  className="rounded-lg bg-white px-2 py-1 text-xs text-rose-600 shadow-sm hover:bg-rose-50"
                >
                  🗑
                </button>
              </div>
            </div>
          </div>
        ))}
        {products.length === 0 && (
          <p className="py-10 text-center text-sm text-slate-400">尚無產品，點右上角新增。</p>
        )}
      </div>

      {/* 最近銷售 */}
      <h2 className="mb-2 mt-6 text-sm font-bold text-slate-700">最近產品銷售</h2>
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">時間</th>
              <th className="px-3 py-2 text-left">產品</th>
              <th className="px-3 py-2 text-left">員工</th>
              <th className="px-3 py-2 text-left">客人</th>
              <th className="px-3 py-2 text-right">售價</th>
              <th className="px-3 py-2 text-right">佣金</th>
            </tr>
          </thead>
          <tbody>
            {recentSales.map((s) => (
              <tr key={s.id} className="border-t border-slate-100">
                <td className="px-3 py-2 text-xs text-slate-500">{s.soldAt.slice(5, 16).replace("T", " ")}</td>
                <td className="px-3 py-2">{s.productName}</td>
                <td className="px-3 py-2">{s.staffName}</td>
                <td className="px-3 py-2">
                  {s.customerId ? (
                    <Link href={`/salon/customers/${s.customerId}`} className="text-rose-600 hover:underline">
                      {s.customerName}
                    </Link>
                  ) : (
                    s.customerName
                  )}
                </td>
                <td className="px-3 py-2 text-right">MOP {s.price}</td>
                <td className="px-3 py-2 text-right font-semibold text-emerald-600">MOP {s.commissionAmount}</td>
              </tr>
            ))}
            {recentSales.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-xs text-slate-400">
                  尚無產品銷售記錄
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 產品編輯 Modal */}
      {showEdit && editing && (
        <div className="fixed inset-0 z-50 grid place-items-end bg-black/40 md:place-items-center" onClick={() => setShowEdit(false)}>
          <div
            className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 shadow-xl md:rounded-3xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-4 text-base font-bold text-slate-900">產品資料</h3>
            <div className="grid gap-3">
              <div>
                <div className="mb-1 text-xs font-medium text-slate-500">產品名稱</div>
                <input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
                />
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-slate-500">分類（可選）</div>
                <input
                  value={editing.category ?? ""}
                  onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                  placeholder="例如 護膚 / 美甲"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <div className="mb-1 text-xs font-medium text-slate-500">售價 (MOP)</div>
                  <input
                    type="number"
                    value={editing.price}
                    onChange={(e) => setEditing({ ...editing, price: Number(e.target.value) || 0 })}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
                  />
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-slate-500">成本 (MOP)</div>
                  <input
                    type="number"
                    value={editing.cost ?? ""}
                    onChange={(e) => setEditing({ ...editing, cost: e.target.value === "" ? undefined : Number(e.target.value) || 0 })}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
                  />
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-slate-500">佣金率 %</div>
                  <input
                    type="number"
                    value={editing.commissionRate}
                    onChange={(e) => setEditing({ ...editing, commissionRate: Number(e.target.value) || 0 })}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input
                  type="checkbox"
                  checked={editing.active}
                  onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
                />
                啟用（於目錄顯示）
              </label>
            </div>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => setShowEdit(false)}
                className="flex-1 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-200"
              >
                取消
              </button>
              <button
                type="button"
                onClick={saveProduct}
                className="flex-1 rounded-xl bg-rose-500 px-4 py-2.5 text-sm font-bold text-white hover:bg-rose-600"
              >
                儲存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 賣產品 Modal */}
      {sellTarget && (
        <div className="fixed inset-0 z-50 grid place-items-end bg-black/40 md:place-items-center" onClick={() => setSellTarget(null)}>
          <div
            className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 shadow-xl md:rounded-3xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 text-base font-bold text-slate-900">賣出產品</h3>
            <p className="mb-4 text-sm text-slate-500">
              {sellTarget.name} · 售價 MOP {sellTarget.price} · 佣金率 {sellTarget.commissionRate}%
            </p>
            <div className="grid gap-3">
              <div>
                <div className="mb-1 text-xs font-medium text-slate-500">銷售員工 *</div>
                <select
                  value={sellStaffId}
                  onChange={(e) => setSellStaffId(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
                >
                  {staffList.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.nickname ?? s.name}（{SALON_STAFF_ROLE_LABELS[s.role]}）
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-slate-500">客人（可留空 = walk-in）</div>
                <select
                  value={sellCustomerId}
                  onChange={(e) => setSellCustomerId(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
                >
                  <option value="">（walk-in / 非會員）</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}（{c.phone}）
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-slate-500">收錢方式</div>
                <select
                  value={sellPayment}
                  onChange={(e) => setSellPayment(e.target.value as SalonPaymentMethod)}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
                >
                  {PAYMENT_OPTS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-slate-500">備註（可選）</div>
                <input
                  value={sellNote}
                  onChange={(e) => setSellNote(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
                />
              </div>
              <div className="rounded-xl bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">
                員工佣金：MOP {Math.round((sellTarget.price * sellTarget.commissionRate) / 100)}
              </div>
            </div>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => setSellTarget(null)}
                className="flex-1 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-200"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submitSell}
                className="flex-1 rounded-xl bg-rose-500 px-4 py-2.5 text-sm font-bold text-white hover:bg-rose-600"
              >
                確認銷售
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
