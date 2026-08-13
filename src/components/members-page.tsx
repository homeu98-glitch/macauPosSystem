"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { FixedNumberPad } from "@/components/fixed-number-pad";
import { friendlyLedgerMemberError } from "@/lib/ledger/member-errors";
import {
  avosToMop,
  formatGrantExpiry,
  grantStatusLabel,
  grantTypeLabel,
  isGrantActive,
  LedgerMemberGrantRecord,
  LedgerMemberProfile,
} from "@/lib/ledger/member-types";
import { lookupCustomerWallet } from "@/lib/ledger/members";
import { listCustomerRewardGrants } from "@/lib/ledger/rewards";
import { getLedgerMerchantId } from "@/lib/ledger/session";
import { clearLegacyMembersCache } from "@/lib/storage";
import { useNetworkOnline } from "@/lib/use-network-online";

function formatMoney(amount: number) {
  return `MOP ${amount.toFixed(0)}`;
}

function grantSections(grants: LedgerMemberGrantRecord[]) {
  const active = grants.filter(isGrantActive);
  const inactive = grants.filter((grant) => !isGrantActive(grant));
  return { active, inactive };
}

function GrantList({
  emptyLabel,
  grants,
}: {
  emptyLabel: string;
  grants: LedgerMemberGrantRecord[];
}) {
  if (grants.length === 0) {
    return <div className="text-sm text-slate-500">{emptyLabel}</div>;
  }

  return (
    <div className="grid gap-2">
      {grants.map((grant) => (
        <div
          key={grant.grantId}
          className="flex items-start justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3"
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-slate-900">{grant.title}</div>
            <div className="mt-1 text-xs text-slate-500">
              {grantTypeLabel(grant.prizeType)}
              {grant.prizeType === "money_voucher"
                ? ` · ${formatMoney(avosToMop(grant.rewardAmountAvos))}`
                : null}
              {" · "}
              到期 {formatGrantExpiry(grant.expiresAt)}
            </div>
          </div>
          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
            {grantStatusLabel(grant.status)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function MembersPage() {
  const networkOnline = useNetworkOnline();
  const offlineMode = !networkOnline;
  const [phone, setPhone] = useState("");
  const [member, setMember] = useState<LedgerMemberProfile | null>(null);
  const [searchHint, setSearchHint] = useState("");
  const [searching, setSearching] = useState(false);
  const searchTimerRef = useRef<number | null>(null);

  const validSearch = useMemo(() => phone.length === 0 || /^\d{0,8}$/.test(phone), [phone]);
  const grantGroups = useMemo(
    () => (member ? grantSections(member.allGrants) : { active: [], inactive: [] }),
    [member],
  );
  const paidBalanceAvos = member ? Math.max(0, member.balanceAvos - member.giftBalanceAvos) : 0;

  useEffect(() => {
    clearLegacyMembersCache();
    return () => {
      if (searchTimerRef.current) {
        window.clearTimeout(searchTimerRef.current);
      }
    };
  }, []);

  function scheduleLookup(nextPhone: string) {
    if (searchTimerRef.current) {
      window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }

    if (nextPhone.length !== 8) {
      setSearching(false);
      setMember(null);
      setSearchHint("");
      return;
    }

    searchTimerRef.current = window.setTimeout(() => {
      void (async () => {
        if (offlineMode) {
          setMember(null);
          setSearchHint("會員查詢須連線，請恢復網絡後再試。");
          return;
        }

        const merchantId = getLedgerMerchantId();
        if (!merchantId) {
          setMember(null);
          setSearchHint("無法取得商家 ID，請重新登入。");
          return;
        }

        setSearching(true);
        setSearchHint("");
        try {
          const wallet = await lookupCustomerWallet(merchantId, nextPhone);
          if (!wallet.registered || !wallet.customerId) {
            setMember(null);
            setSearchHint("此電話尚未註冊會員通，請顧客先登入會員通或聯絡店主。");
            return;
          }

          const allGrants = await listCustomerRewardGrants(merchantId, wallet.customerId);
          setMember({ ...wallet, allGrants });
        } catch (error) {
          setMember(null);
          setSearchHint(friendlyLedgerMemberError(error instanceof Error ? error.message : String(error)));
        } finally {
          setSearching(false);
        }
      })();
    }, 300);
  }

  function handlePhoneChange(value: string) {
    const normalized = value.replace(/\D/g, "").slice(0, 8);
    setPhone(normalized);
    scheduleLookup(normalized);
  }

  return (
    <div className="h-[100dvh] overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="flex h-[100dvh] overflow-hidden md:pl-[72px]">
        <main className="flex h-full flex-1 flex-col overflow-hidden">
          <div className="border-b border-slate-200 bg-white px-4 py-4">
            <div className="text-lg font-semibold text-slate-900">會員</div>
            <div className="mt-1 text-sm text-slate-500">
              輸入 8 位手機號碼查詢 Ledger 會員餘額與獎賞券（須連線；資料不會儲存於本機）。
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                inputMode="numeric"
                maxLength={8}
                onChange={(event) => handlePhoneChange(event.target.value)}
                placeholder="輸入 8 位手機號碼"
                value={phone}
              />
            </div>
            {!validSearch ? <div className="mt-2 text-xs text-red-600">只可輸入 8 位數字</div> : null}
            {offlineMode ? (
              <div className="mt-2 text-xs text-amber-700">目前離線，無法查詢會員。</div>
            ) : null}
            {searching ? <div className="mt-2 text-xs text-slate-500">查詢中…</div> : null}
            {searchHint ? <div className="mt-2 text-xs text-red-600">{searchHint}</div> : null}
          </div>

          <div className="flex-1 overflow-auto p-4">
            {!member && phone.length < 8 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
                輸入完整 8 位手機號碼後，將顯示該會員的錢包與獎賞券。
                <div className="mt-3 text-xs text-slate-400">
                  Phase 1 不支援 POS 代建帳號或現場充值；新會員請透過會員通 App 或 Ledger Web 註冊。
                </div>
              </div>
            ) : null}

            {member ? (
              <div className="grid gap-4 xl:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
                <article className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div>
                    <div className="text-base font-semibold text-slate-900">
                      {member.displayName ?? "會員"}
                    </div>
                    <div className="mt-1 text-sm text-slate-500">{member.customerPhone}</div>
                  </div>

                  <div className="mt-4 grid gap-3">
                    <div className="rounded-2xl bg-slate-50 p-3">
                      <div className="text-xs text-slate-500">錢包合計</div>
                      <div className="mt-1 text-lg font-semibold text-slate-900">
                        {formatMoney(avosToMop(member.balanceAvos))}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div className="rounded-2xl bg-slate-50 p-3">
                        <div className="text-xs text-slate-500">充值餘額</div>
                        <div className="mt-1 font-semibold text-slate-900">
                          {formatMoney(avosToMop(paidBalanceAvos))}
                        </div>
                      </div>
                      <div className="rounded-2xl bg-slate-50 p-3">
                        <div className="text-xs text-slate-500">贈送餘額</div>
                        <div className="mt-1 font-semibold text-slate-900">
                          {formatMoney(avosToMop(member.giftBalanceAvos))}
                        </div>
                      </div>
                    </div>
                    <div className="rounded-2xl bg-orange-50 p-3 text-sm text-orange-900">
                      可核銷 {grantGroups.active.length} 張 · 共 {member.allGrants.length} 張獎賞券
                    </div>
                  </div>
                </article>

                <div className="grid gap-4">
                  <section className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="text-sm font-semibold text-slate-900">可核銷獎賞券</div>
                    <div className="mt-3">
                      <GrantList emptyLabel="目前沒有可核銷獎賞券" grants={grantGroups.active} />
                    </div>
                  </section>

                  <section className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="text-sm font-semibold text-slate-900">已失效獎賞券</div>
                    <div className="mt-3">
                      <GrantList emptyLabel="沒有已兌換或過期的獎賞券" grants={grantGroups.inactive} />
                    </div>
                  </section>
                </div>
              </div>
            ) : null}
          </div>
        </main>

        <div className="hidden w-[280px] shrink-0 md:block lg:w-[320px]">
          <FixedNumberPad
            confirmLabel="搜尋"
            showDisplay={false}
            subtitle="輸入會員手機號碼"
            title="數字鍵盤"
            value={phone}
            onChange={handlePhoneChange}
            onConfirm={() => scheduleLookup(phone)}
          />
        </div>
      </div>
    </div>
  );
}
