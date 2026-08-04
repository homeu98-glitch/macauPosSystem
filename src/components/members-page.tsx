"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { loadMembers, saveMembers } from "@/lib/storage";
import { MemberCoupon, MemberProfile } from "@/lib/types";

function formatMoney(amount: number) {
  return `MOP ${amount.toFixed(0)}`;
}

function couponSummary(coupons: MemberCoupon[]) {
  const now = Date.now();
  const available = coupons.filter((coupon) => !coupon.usedAt && (!coupon.expiresAt || Date.parse(coupon.expiresAt) > now));
  const used = coupons.filter((coupon) => Boolean(coupon.usedAt));
  return { available: available.length, used: used.length, total: coupons.length };
}

export function MembersPage() {
  const [phone, setPhone] = useState("");
  const [members, setMembers] = useState<MemberProfile[]>(() => loadMembers());
  const [rechargeValues, setRechargeValues] = useState<Record<string, string>>({});

  useEffect(() => {
    async function load() {
      const response = await fetch(`/api/members${phone ? `?phone=${phone}` : ""}`);
      const payload = (await response.json()) as { members: MemberProfile[] };
      setMembers(payload.members ?? []);
      if (!phone) {
        saveMembers(payload.members ?? []);
      }
    }

    void load();
  }, [phone]);

  const validSearch = useMemo(() => phone.length === 0 || /^\d{0,8}$/.test(phone), [phone]);

  function rechargeMember(memberId: string) {
    const amount = Number(rechargeValues[memberId] ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) return;

    const nextMembers = members.map((member) =>
      member.id === memberId ? { ...member, balance: member.balance + amount } : member,
    );
    setMembers(nextMembers);
    saveMembers(nextMembers);
    setRechargeValues((current) => ({ ...current, [memberId]: "" }));
  }

  return (
    <div className="h-screen overflow-hidden bg-slate-100">
      <div className="flex h-screen overflow-hidden">
        <aside className="hidden w-[72px] shrink-0 flex-col justify-between bg-slate-900 px-2 py-3 text-white lg:flex">
          <div className="grid gap-2">
            <Link className="flex flex-col items-center gap-2 rounded-2xl bg-slate-800 px-2 py-3 text-xs font-semibold text-slate-200" href="/">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10">點</span>
              <span>點餐</span>
            </Link>
            <div className="flex flex-col items-center gap-2 rounded-2xl bg-orange-500 px-2 py-3 text-xs font-semibold text-white">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10">會</span>
              <span>會員</span>
            </div>
            <Link className="flex flex-col items-center gap-2 rounded-2xl bg-slate-800 px-2 py-3 text-xs font-semibold text-slate-200" href="/orders">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10">單</span>
              <span>訂單</span>
            </Link>
            <Link className="flex flex-col items-center gap-2 rounded-2xl bg-slate-800 px-2 py-3 text-xs font-semibold text-slate-200" href="/reports">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10">報</span>
              <span>報表</span>
            </Link>
          </div>
          <Link className="rounded-2xl bg-slate-800 px-2 py-2 text-center text-xs font-semibold text-slate-200" href="/settings">
            設置
          </Link>
        </aside>

        <main className="flex h-full flex-1 flex-col overflow-hidden">
          <div className="border-b border-slate-200 bg-white px-4 py-4">
            <div className="text-lg font-semibold text-slate-900">會員</div>
            <div className="mt-1 text-sm text-slate-500">搜尋手機號碼 8 位數字，查看會員餘額、優惠券與充值。</div>
            <input
              className="mt-3 w-full max-w-sm rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
              inputMode="numeric"
              maxLength={8}
              onChange={(event) => setPhone(event.target.value.replace(/\D/g, "").slice(0, 8))}
              placeholder="輸入 8 位手機號碼"
              value={phone}
            />
            {!validSearch ? <div className="mt-2 text-xs text-red-600">只可輸入 8 位數字</div> : null}
          </div>

          <div className="flex-1 overflow-auto p-4">
            <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
              {members.map((member) => (
                <article key={member.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-base font-semibold text-slate-900">{member.name}</div>
                      <div className="mt-1 text-sm text-slate-500">{member.phone}</div>
                    </div>
                    <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-semibold text-orange-700">
                      {member.level ?? "普通"}
                    </span>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-2xl bg-slate-50 p-3">
                      <div className="text-xs text-slate-500">充值額度</div>
                      <div className="mt-1 font-semibold text-slate-900">{formatMoney(member.balance)}</div>
                    </div>
                    <div className="rounded-2xl bg-slate-50 p-3">
                      <div className="text-xs text-slate-500">優惠券</div>
                      <div className="mt-1 font-semibold text-slate-900">
                        {couponSummary(member.coupons).available} 可用 · {couponSummary(member.coupons).total} 張
                      </div>
                    </div>
                  </div>
                  {member.coupons.length ? (
                    <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-3">
                      <div className="text-xs font-semibold text-slate-500">券列表（前 3 張）</div>
                      <div className="mt-2 grid gap-1 text-sm text-slate-700">
                        {member.coupons.slice(0, 3).map((coupon) => (
                          <div key={coupon.id} className="flex items-center justify-between gap-3">
                            <span className="truncate">{coupon.title}</span>
                            <span className="text-xs text-slate-500">{coupon.usedAt ? "已用" : "可用"}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <div className="mt-4 flex gap-2">
                    <input
                      className="flex-1 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                      inputMode="decimal"
                      onChange={(event) =>
                        setRechargeValues((current) => ({ ...current, [member.id]: event.target.value }))
                      }
                      placeholder="充值金額"
                      value={rechargeValues[member.id] ?? ""}
                    />
                    <button
                      className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white"
                      onClick={() => rechargeMember(member.id)}
                      type="button"
                    >
                      充值
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
