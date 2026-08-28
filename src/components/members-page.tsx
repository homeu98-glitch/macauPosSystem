"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { AppSidebar } from "@/components/app-sidebar";
import { FixedNumberPad } from "@/components/fixed-number-pad";
import { MemberTopupPanel } from "@/components/member-topup-panel";
import { PendingDot } from "@/components/pending-dot";
import { ensureCustomer } from "@/lib/ledger/ensure-customer";
import { friendlyLedgerMemberError } from "@/lib/ledger/member-errors";
import { isValidMemberSearch, listMerchantCustomers } from "@/lib/ledger/member-list";
import {
  avosToMop,
  formatGrantExpiry,
  grantStatusLabel,
  grantTypeLabel,
  isGrantActive,
  LedgerCustomerSummary,
  LedgerMemberGrantRecord,
  LedgerMemberProfile,
} from "@/lib/ledger/member-types";
import { applyPosTopup, lookupCustomerWallet } from "@/lib/ledger/members";
import { listCustomerRewardGrants } from "@/lib/ledger/rewards";
import { getLedgerMerchantId } from "@/lib/ledger/session";
import { clearLegacyMembersCache } from "@/lib/storage";
import { useTopupPendingCount } from "@/lib/topup/use-topup-pending-count";
import { useNetworkOnline } from "@/lib/use-network-online";
import { formatMoney } from "@/lib/format";

type MembersTab = "manage" | "topup";

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

function MembersTabButton({
  active,
  label,
  onClick,
  showDot,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  showDot?: boolean;
}) {
  return (
    <button
      className={`relative inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-semibold transition ${
        active ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
      }`}
      onClick={onClick}
      type="button"
    >
      {label}
      {showDot ? <PendingDot className={active ? "ring-2 ring-orange-500" : ""} /> : null}
    </button>
  );
}

export function MembersPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const networkOnline = useNetworkOnline();
  const offlineMode = !networkOnline;
  const initialTab: MembersTab = searchParams.get("tab") === "topup" ? "topup" : "manage";
  const [tab, setTab] = useState<MembersTab>(initialTab);
  const { hasPending, configured: topupConfigured } = useTopupPendingCount({
    fast: tab === "topup",
  });

  const [phone, setPhone] = useState("");
  const [member, setMember] = useState<LedgerMemberProfile | null>(null);
  const [searchHint, setSearchHint] = useState("");
  const [searching, setSearching] = useState(false);
  const [topupAmount, setTopupAmount] = useState("");
  // 未註冊建檔用：會員名稱（可選，契約 §5.7.7 displayName ≤ 50 字）。
  // 只在 unregistered 分支（ensure-customer）提交；已註冊會員唔經呢條。
  const [topupName, setTopupName] = useState("");
  const [topupBusy, setTopupBusy] = useState(false);
  const [topupMsg, setTopupMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const searchTimerRef = useRef<number | null>(null);

  // 會員搜尋列表（契約 v3.2 §5.7 `list_merchant_customers`）
  // 僅記憶體 state，禁止寫入 localStorage / POS DB（PII §7.2）
  const [listQuery, setListQuery] = useState("");
  const [listResults, setListResults] = useState<LedgerCustomerSummary[]>([]);
  const [listBusy, setListBusy] = useState(false);
  const [listMsg, setListMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [listPage, setListPage] = useState(1);
  const [listTotal, setListTotal] = useState(0);
  const [listHasMore, setListHasMore] = useState(false);

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

  useEffect(() => {
    const nextTab: MembersTab = searchParams.get("tab") === "topup" ? "topup" : "manage";
    setTab(nextTab);
  }, [searchParams]);

  function switchTab(nextTab: MembersTab) {
    setTab(nextTab);
    router.replace(nextTab === "topup" ? "/members?tab=topup" : "/members", { scroll: false });
  }

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

  /**
   * 會員搜尋列表（契約 v3.2 §5.7）。
   * 刻意唔傳 merchantId —— 契約規定店員唔好傳 `p_merchant_id`（傳咗會 not admin）。
   */
  async function runListSearch(nextPage: number, overrideQuery?: string) {
    const term = (overrideQuery ?? listQuery).trim();

    if (!isValidMemberSearch(term)) {
      setListMsg({ tone: "err", text: "請輸入至少 2 個字，或完整 8 位電話號碼。" });
      return;
    }
    if (offlineMode) {
      setListMsg({ tone: "err", text: "會員搜尋須連線，請恢復網絡後再試。" });
      return;
    }

    setListBusy(true);
    setListMsg(null);
    try {
      const page = Math.max(1, nextPage);
      const result = await listMerchantCustomers({ search: term, page });
      setListResults((prev) => (page === 1 ? result.customers : [...prev, ...result.customers]));
      setListPage(page);
      setListTotal(result.total);
      setListHasMore(result.hasMore);
      if (result.customers.length === 0) {
        setListMsg({ tone: "err", text: "搵唔到符合嘅會員。" });
      }
    } catch (error) {
      setListResults([]);
      setListMsg({
        tone: "err",
        text: friendlyLedgerMemberError(error instanceof Error ? error.message : String(error)),
      });
    } finally {
      setListBusy(false);
    }
  }

  /** 由搜尋結果揀中一位會員 → 帶入精準 lookup（載錢包 + 券）。 */
  function pickFromList(item: LedgerCustomerSummary) {
    const nextPhone = item.phone.replace(/\D/g, "").slice(0, 8);
    if (nextPhone.length !== 8) return;
    setPhone(nextPhone);
    scheduleLookup(nextPhone);
  }

  /**
   * 充值一個掣 cover 兩個分支（Ledger 契約 v3.2 §5.8 / §5.9）：
   *  - registered=true  → client 直連 `merchant_apply_pos_txn(p_type:"topup")`
   *  - registered=false → POS 伺服器轉發 Ledger `ensure-customer`（建檔 + 首充）
   * 契約明禁 `p_type="add"`。
   */
  async function handleTopup() {
    const mop = Number(topupAmount);
    const avos = Math.round(mop * 100);
    if (!Number.isFinite(avos) || avos <= 0) {
      setTopupMsg({ tone: "err", text: "請輸入大於 0 嘅充值金額（MOP）" });
      return;
    }

    const targetPhone = member?.customerPhone || phone;
    if (targetPhone.length !== 8) {
      setTopupMsg({ tone: "err", text: "請先輸入完整 8 位會員電話號碼。" });
      return;
    }

    const merchantId = getLedgerMerchantId();
    if (!merchantId) {
      setTopupMsg({ tone: "err", text: "無法取得商家 ID，請重新登入。" });
      return;
    }

    setTopupBusy(true);
    setTopupMsg(null);
    try {
      const isRegistered = Boolean(member?.customerId);

      if (isRegistered) {
        await applyPosTopup({
          merchantId,
          phone: targetPhone,
          amountAvos: avos,
          idempotencyKey: `topup-${member?.customerId}-${Date.now()}`,
        });
        setTopupMsg({
          tone: "ok",
          text: `已為 ${member?.displayName ?? "會員"} 充值 ${formatMoney(mop)}`,
        });
      } else {
        await ensureCustomer({
          merchantId,
          phone: targetPhone,
          amountAvos: avos,
          idempotencyKey: `ensure-${targetPhone}-${Date.now()}`,
          displayName: topupName.trim() || undefined,
        });
        setTopupMsg({
          tone: "ok",
          text: `已為 ${targetPhone} 建立會員並充值 ${formatMoney(mop)}；請顧客到會員通 /wallet/login 自設 4 位 PIN。`,
        });
      }

      setTopupAmount("");
      setTopupName("");

      // 刷新錢包餘額與券（建檔後 lookup 應由 registered=false 變 true）
      const wallet = await lookupCustomerWallet(merchantId, targetPhone);
      if (wallet.registered && wallet.customerId) {
        const allGrants = await listCustomerRewardGrants(merchantId, wallet.customerId);
        setMember({ ...wallet, allGrants });
      } else {
        setMember(null);
      }
    } catch (err) {
      setTopupMsg({ tone: "err", text: friendlyLedgerMemberError(err instanceof Error ? err.message : String(err)) });
    } finally {
      setTopupBusy(false);
    }
  }

  const isRegisteredMember = Boolean(member?.customerId);
  const topupLabel = isRegisteredMember ? "充值" : "建檔並充值";

  /** 充值表單：已註冊（topup）同未註冊（ensure-customer 建檔＋首充）共用。 */
  const topupControls = (
    <>
      <div className="mt-3 flex items-end gap-2">
        <div className="flex-1">
          <div className="text-xs text-slate-500">充值金額（MOP）</div>
          <input
            className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
            inputMode="decimal"
            min="0"
            onChange={(e) => setTopupAmount(e.target.value)}
            placeholder="0.00"
            type="number"
            value={topupAmount}
          />
        </div>
        <button
          className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
          disabled={topupBusy}
          onClick={handleTopup}
          type="button"
        >
          {topupBusy ? "處理中…" : topupLabel}
        </button>
      </div>
      {topupMsg ? (
        <div className={`mt-2 text-xs ${topupMsg.tone === "ok" ? "text-emerald-600" : "text-rose-600"}`}>
          {topupMsg.text}
        </div>
      ) : null}
    </>
  );

  return (
    <div className="h-[100dvh] overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="flex h-[100dvh] overflow-hidden md:pl-[72px]">
        <main className="flex h-full flex-1 flex-col overflow-hidden">
          <div className="border-b border-slate-200 bg-white px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">會員</div>
                {tab === "manage" ? (
                  <div className="mt-1 text-sm text-slate-500">
                    輸入 8 位手機號碼查詢 Ledger 會員餘額與獎賞券（須連線；資料不會儲存於本機）。
                  </div>
                ) : (
                  <div className="mt-1 text-sm text-slate-500">審核顧客線上轉帳充值截圖。</div>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <MembersTabButton
                  active={tab === "manage"}
                  label="會員管理"
                  onClick={() => switchTab("manage")}
                />
                <MembersTabButton
                  active={tab === "topup"}
                  label="會員充值"
                  showDot={topupConfigured && hasPending}
                  onClick={() => switchTab("topup")}
                />
              </div>
            </div>

            {tab === "manage" ? (
              <>
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
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    onChange={(event) => setListQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void runListSearch(1);
                    }}
                    placeholder="姓名 / 電話搜尋會員（至少 2 字）"
                    value={listQuery}
                  />
                  <button
                    className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                    disabled={listBusy || !isValidMemberSearch(listQuery)}
                    onClick={() => void runListSearch(1)}
                    type="button"
                  >
                    {listBusy ? "搜尋中…" : "搜尋"}
                  </button>
                  <span className="text-xs text-slate-500">
                    契約 v3.2 §5.7：唔可以無輸入就列出全店會員；要睇全店名單請用會員通 Web
                    <span className="font-mono"> /merchant/reports/users</span>。
                  </span>
                </div>
                {!validSearch ? <div className="mt-2 text-xs text-red-600">只可輸入 8 位數字</div> : null}
                {offlineMode ? (
                  <div className="mt-2 text-xs text-amber-700">目前離線，無法查詢會員。</div>
                ) : null}
                {searching ? <div className="mt-2 text-xs text-slate-500">查詢中…</div> : null}
                {searchHint ? <div className="mt-2 text-xs text-red-600">{searchHint}</div> : null}
                {listMsg ? (
                  <div className={`mt-2 text-xs ${listMsg.tone === "ok" ? "text-emerald-600" : "text-rose-600"}`}>
                    {listMsg.text}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>

          {tab === "manage" ? (
            <div className="flex-1 overflow-auto p-4">
              {listResults.length > 0 ? (
                <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-slate-900">
                      搜尋結果（今次共 {listTotal} 筆）
                      <span className="ml-2 text-xs font-normal text-slate-400">
                        只係今次搜尋筆數，唔係全店總數
                      </span>
                    </div>
                    <button
                      className="text-xs text-slate-500 hover:text-slate-700"
                      onClick={() => {
                        setListResults([]);
                        setListMsg(null);
                      }}
                      type="button"
                    >
                      清除
                    </button>
                  </div>

                  <div className="mt-3 grid gap-2">
                    {listResults.map((item) => (
                      <button
                        className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 px-3 py-3 text-left transition hover:bg-slate-50"
                        key={`${item.walletId ?? "w"}-${item.customerId ?? "c"}-${item.phone}`}
                        onClick={() => pickFromList(item)}
                        type="button"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-900">
                            {item.displayName ?? item.nickName ?? "會員"}
                          </div>
                          <div className="mt-0.5 text-xs text-slate-500">***{item.phone.slice(-4)}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-sm font-semibold text-slate-900">
                            {formatMoney(avosToMop(item.balanceAvos))}
                          </div>
                          <div className="text-[11px] text-slate-400">
                            贈送 {formatMoney(avosToMop(item.giftBalanceAvos))}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>

                  {listHasMore ? (
                    <button
                      className="mt-3 w-full rounded-2xl border border-slate-200 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      disabled={listBusy}
                      onClick={() => void runListSearch(listPage + 1)}
                      type="button"
                    >
                      {listBusy ? "載入中…" : "載入更多"}
                    </button>
                  ) : null}
                </section>
              ) : null}

              {!member && phone.length < 8 ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
                  輸入完整 8 位手機號碼（查單一會員），或用上方搜尋框以姓名／電話搜尋。
                  <div className="mt-3 text-xs text-slate-400">
                    POS 支援已註冊會員現場充值（Ledger
                    <span className="font-mono"> merchant_apply_pos_txn(topup)</span>）；未註冊電話亦可直接
                    「建檔並充值」（Ledger <span className="font-mono">ensure-customer</span>，伺服器代打），
                    顧客事後到會員通自設 PIN。
                    <div className="mt-2">
                      契約 v3.2：唔支援亦唔容許「無輸入列出全店會員」；睇全店名單請用會員通 Web
                      <span className="font-mono"> /merchant/reports/users</span>。
                    </div>
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

                    <section className="rounded-2xl border border-orange-200 bg-orange-50/60 p-4">
                      <div className="text-sm font-semibold text-slate-900">現場充值（已註冊會員）</div>
                      {topupControls}
                      <div className="mt-2 text-[11px] text-slate-400">
                        走 Ledger{" "}
                        <span className="font-mono">{`merchant_apply_pos_txn(p_type:"topup")`}</span>
                        ，冪等鍵防重複；契約明禁{" "}
                        <span className="font-mono">{`p_type="add"`}</span>。
                      </div>
                    </section>
                  </div>
                </div>
              ) : null}

              {!member && phone.length === 8 ? (
                <section className="rounded-2xl border border-orange-200 bg-orange-50/60 p-4">
                  <div className="text-sm font-semibold text-slate-900">{phone} 尚未註冊會員通</div>
                  <div className="mt-1 text-xs text-slate-600">
                    輸入充值金額後撳「建檔並充值」，即會建立會員並完成首充（Ledger v3.2 §5.9
                    <span className="font-mono"> ensure-customer</span>，POS 伺服器代打）。
                    建檔後顧客須自行到會員通
                    <span className="font-mono"> /wallet/login </span>
                    自設 4 位 PIN；POS 唔幫設 PIN。
                  </div>
                  <div className="mt-3">
                    <div className="text-xs text-slate-500">
                      會員名稱（可選，最多 50 字；留空由顧客日後於會員通自行填寫）
                    </div>
                    <input
                      className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                      maxLength={50}
                      onChange={(e) => setTopupName(e.target.value)}
                      placeholder="例如：陳小姐"
                      type="text"
                      value={topupName}
                    />
                  </div>
                  {topupControls}
                </section>
              ) : null}
            </div>
          ) : (
            <MemberTopupPanel />
          )}
        </main>

        {tab === "manage" ? (
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
        ) : null}
      </div>
    </div>
  );
}
