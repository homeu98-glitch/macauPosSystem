"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { loadActiveSalonStore, loadCustomers, saveCustomers } from "@/lib/salon/storage";
import { seedMockCustomersIfEmpty } from "@/lib/salon/mock-realtime";
import { getMockLedgerMember } from "@/lib/salon/mock-ledger";
import type { SalonCustomerProfile } from "@/lib/salon/types";

export function CustomersList() {
  const [customers, setCustomers] = useState<SalonCustomerProfile[]>([]);
  const [query, setQuery] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    seedMockCustomersIfEmpty(loadActiveSalonStore());
    setCustomers(loadCustomers());
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.phone.includes(q) ||
        (c.fileNumber ?? "").toLowerCase().includes(q) ||
        (c.tags ?? []).some((t) => t.toLowerCase().includes(q)),
    );
  }, [customers, query]);

  const handleCreate = () => {
    if (!newName.trim()) {
      setErr("請輸入客戶姓名");
      return;
    }
    const phoneNorm = newPhone.replace(/\D/g, "");
    if (!/^\d{8}$/.test(phoneNorm)) {
      setErr("請輸入 8 位數字電話");
      return;
    }
    if (customers.some((c) => c.phone === phoneNorm)) {
      setErr("此電話已存在客戶檔案");
      return;
    }
    const created: SalonCustomerProfile = {
      id: "cust-" + Math.random().toString(36).slice(2, 10),
      name: newName.trim(),
      phone: phoneNorm,
      visitCount: 0,
      ledgerBalance: 0,
      ledgerPoints: 0,
      ledgerTier: "普通會員",
    };
    const next = [...customers, created];
    saveCustomers(next);
    setCustomers(next);
    setShowNew(false);
    setNewName("");
    setNewPhone("");
    setErr("");
  };

  return (
    <div className="mx-auto max-w-5xl p-4 pb-24 md:p-6 md:pb-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">客戶檔案</h1>
        <button
          type="button"
          onClick={() => setShowNew(true)}
          className="rounded-xl bg-rose-500 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-600"
        >
          + 新增客戶
        </button>
      </div>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜尋姓名 / 電話 / 標籤"
        className="mb-4 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
      />

      {showNew && (
        <div className="mb-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="mb-3 text-sm font-bold text-slate-700">新增客戶</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                setErr("");
              }}
              placeholder="姓名"
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
            />
            <input
              type="tel"
              inputMode="numeric"
              maxLength={8}
              value={newPhone}
              onChange={(e) => {
                setNewPhone(e.target.value.replace(/\D/g, "").slice(0, 8));
                setErr("");
              }}
              placeholder="8 位電話"
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
            />
          </div>
          {err && <p className="mt-2 text-xs text-rose-500">{err}</p>}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={handleCreate}
              className="rounded-xl bg-rose-500 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-600"
            >
              建立
            </button>
            <button
              type="button"
              onClick={() => {
                setShowNew(false);
                setErr("");
              }}
              className="rounded-xl bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-200"
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {filtered.map((c) => {
          const ledger = getMockLedgerMember(c.phone);
          return (
            <Link
              key={c.id}
              href={`/salon/customers/${c.id}`}
              className="block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-rose-300"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-base font-bold text-slate-900">{c.name}</span>
                    <span className="text-xs text-slate-400">{c.phone}</span>
                    {c.fileNumber ? (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                        檔 {c.fileNumber}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {(c.tags ?? []).map((t) => (
                      <span
                        key={t}
                        className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-600"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="text-right text-xs">
                  {ledger ? (
                    <>
                      <div className="font-semibold text-slate-700">{ledger.ledgerTier}</div>
                      <div className="text-emerald-600">餘額 MOP {ledger.ledgerBalance}</div>
                      <div className="text-amber-600">{ledger.ledgerPoints} 分</div>
                    </>
                  ) : (
                    <div className="text-slate-400">尚無 Ledger 資料</div>
                  )}
                </div>
              </div>
              <div className="mt-2 flex gap-4 text-[11px] text-slate-500">
                <span>到店 {c.visitCount} 次</span>
                <span>累計 MOP {c.totalSpent ?? 0}</span>
                <span>最近 {c.lastVisitAt ? c.lastVisitAt.slice(0, 10) : "—"}</span>
              </div>
            </Link>
          );
        })}

        {filtered.length === 0 && (
          <p className="py-10 text-center text-sm text-slate-400">沒有符合的客戶</p>
        )}
      </div>
    </div>
  );
}
