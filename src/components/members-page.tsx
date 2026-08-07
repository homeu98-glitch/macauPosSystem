"use client";

import { useEffect, useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { FixedNumberPad } from "@/components/fixed-number-pad";
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
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createPhone, setCreatePhone] = useState("");
  const [createHint, setCreateHint] = useState("");
  const [creatingMember, setCreatingMember] = useState(false);
  const [rechargingMemberId, setRechargingMemberId] = useState<string | null>(null);
  const [padTarget, setPadTarget] = useState<string>("search");

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
    if (rechargingMemberId) return;
    void (async () => {
      setRechargingMemberId(memberId);
      try {
        const response = await fetch("/api/members", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "recharge", memberId, amount }),
        });
        const payload = (await response.json()) as { member?: MemberProfile };
        const nextMembers = members.map((member) => (member.id === memberId ? payload.member ?? member : member));
        setMembers(nextMembers);
        saveMembers(nextMembers);
        setRechargeValues((current) => ({ ...current, [memberId]: "" }));
      } catch {
        const nextMembers = members.map((member) =>
          member.id === memberId ? { ...member, balance: member.balance + amount } : member,
        );
        setMembers(nextMembers);
        saveMembers(nextMembers);
        setRechargeValues((current) => ({ ...current, [memberId]: "" }));
      } finally {
        setRechargingMemberId(null);
      }
    })();
  }

  async function createMember() {
    if (creatingMember) return;
    setCreatingMember(true);
    setCreateHint("");
    const name = createName.trim();
    const phoneValue = createPhone.replace(/\D/g, "").slice(0, 8);
    if (!name || !/^\d{8}$/.test(phoneValue)) {
      setCreateHint("請填寫姓名及 8 位手機號碼。");
      return;
    }

    try {
      const response = await fetch("/api/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name, phone: phoneValue }),
      });
      const payload = (await response.json()) as { ok: boolean; member?: MemberProfile; error?: string };
      if (!payload.ok || !payload.member) {
        throw new Error(payload.error ?? "新增失敗");
      }

      const nextMembers = [payload.member, ...members];
      setMembers(nextMembers);
      saveMembers(nextMembers);
      setCreateName("");
      setCreatePhone("");
      setCreateOpen(false);
    } catch (err) {
      setCreateHint(err instanceof Error ? err.message : "新增會員失敗");
    } finally {
      setCreatingMember(false);
    }
  }

  const selectedMemberForPad =
    padTarget.startsWith("recharge:") ? members.find((member) => member.id === padTarget.replace("recharge:", "")) ?? null : null;

  const padValue =
    padTarget === "search"
      ? phone
      : selectedMemberForPad
        ? rechargeValues[selectedMemberForPad.id] ?? ""
        : "";

  function updatePadValue(value: string) {
    if (padTarget === "search") {
      setPhone(value.replace(/\D/g, "").slice(0, 8));
      return;
    }

    if (selectedMemberForPad) {
      const normalized = value.replace(/[^\d.]/g, "");
      setRechargeValues((current) => ({ ...current, [selectedMemberForPad.id]: normalized }));
    }
  }

  return (
    <div className="h-screen overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="flex h-screen overflow-hidden lg:pl-[128px]">
        <main className="flex h-full flex-1 flex-col overflow-hidden">
          <div className="border-b border-slate-200 bg-white px-4 py-4">
            <div className="text-lg font-semibold text-slate-900">會員</div>
            <div className="mt-1 text-sm text-slate-500">搜尋手機號碼 8 位數字，查看會員餘額、優惠券與充值。</div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                inputMode="numeric"
                maxLength={8}
                onChange={(event) => setPhone(event.target.value.replace(/\D/g, "").slice(0, 8))}
                onFocus={() => setPadTarget("search")}
                placeholder="輸入 8 位手機號碼"
                value={phone}
              />
              <button
                className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white"
                onClick={() => {
                  setCreateHint("");
                  setCreateOpen(true);
                }}
                type="button"
              >
                新增會員
              </button>
            </div>
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
                      onFocus={() => setPadTarget(`recharge:${member.id}`)}
                      placeholder="充值金額"
                      value={rechargeValues[member.id] ?? ""}
                    />
                    <button
                      aria-busy={rechargingMemberId === member.id}
                      className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                      disabled={Boolean(rechargingMemberId)}
                      onClick={() => rechargeMember(member.id)}
                      type="button"
                    >
                      {rechargingMemberId === member.id ? "提交中…" : "充值"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </main>

        <div className="hidden w-[320px] shrink-0 lg:block">
          <FixedNumberPad
            confirmLabel={padTarget === "search" ? "搜尋" : "完成"}
            showDisplay={false}
            subtitle={
              padTarget === "search"
                ? "輸入會員手機號碼"
                : selectedMemberForPad
                  ? `正在輸入：${selectedMemberForPad.name} 充值金額`
                  : "點選左邊輸入框後可使用鍵盤"
            }
            title="數字鍵盤"
            value={padValue}
            onChange={updatePadValue}
            onConfirm={() => {
              if (padTarget.startsWith("recharge:") && selectedMemberForPad) {
                rechargeMember(selectedMemberForPad.id);
              }
            }}
          />
        </div>
      </div>

      {createOpen ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/45 p-4">
          <div className="w-full max-w-md rounded-3xl bg-white p-5 shadow-2xl">
            <div className="text-lg font-semibold text-slate-900">新增會員</div>
            <div className="mt-4 grid gap-3">
              <label className="grid gap-1 text-sm font-semibold text-slate-700">
                <span className="text-xs text-slate-500">姓名</span>
                <input
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  onChange={(event) => setCreateName(event.target.value)}
                  value={createName}
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-700">
                <span className="text-xs text-slate-500">手機號碼（8 位）</span>
                <input
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  inputMode="numeric"
                  maxLength={8}
                  onChange={(event) => setCreatePhone(event.target.value.replace(/\D/g, "").slice(0, 8))}
                  value={createPhone}
                />
              </label>
              {createHint ? <div className="text-sm text-red-600">{createHint}</div> : null}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                disabled={creatingMember}
                onClick={() => setCreateOpen(false)}
                type="button"
              >
                取消
              </button>
              <button
                aria-busy={creatingMember}
                className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                disabled={creatingMember}
                onClick={() => void createMember()}
                type="button"
              >
                {creatingMember ? "提交中…" : "確認新增"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
