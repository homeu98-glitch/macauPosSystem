"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import {
  loadCustomers,
  saveCustomers,
  loadSalonOrders,
  loadSalonStaff,
  loadSalonPackageTemplates,
  loadSalonCustomerPackages,
  saveSalonCustomerPackages,
  loadServiceItems,
  loadSalonProductSales,
} from "@/lib/salon/storage";
import { getMockLedgerMember, applyMockLedgerBonus } from "@/lib/salon/mock-ledger";
import { MemberTopupPanel } from "@/components/member-topup-panel";
import type {
  SalonCustomerProfile,
  SalonSkinType,
  SalonHairType,
  SalonFormulaRecord,
  SalonPackageTemplate,
  SalonCustomerPackage,
  SalonPaymentMethod,
} from "@/lib/salon/types";

const SKIN_OPTS: Array<{ value: SalonSkinType; label: string }> = [
  { value: "dry", label: "乾性" },
  { value: "oily", label: "油性" },
  { value: "combination", label: "混合性" },
  { value: "sensitive", label: "敏感性" },
];

const HAIR_OPTS: Array<{ value: SalonHairType; label: string }> = [
  { value: "fine", label: "細軟" },
  { value: "coarse", label: "粗硬" },
  { value: "damaged", label: "受損" },
];

const QUICK_TAGS = ["VIP", "敏感肌", "孕婦", "兒童", "SPA愛好者"];

// 付款方式選項（套票購買用；真扣款委託 Ledger P2）
const PAYMENT_OPTS: Array<{ value: SalonPaymentMethod; label: string }> = [
  { value: "cash", label: "現金" },
  { value: "card", label: "卡" },
  { value: "ledger_balance", label: "Ledger 餘額" },
  { value: "external", label: "其他" },
];

export function CustomerProfile() {
  const params = useParams();
  const id = typeof params.id === "string" ? params.id : "";

  const [customer, setCustomer] = useState<SalonCustomerProfile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);

  // 配方歷史「手動新增」表單狀態
  const [formulaService, setFormulaService] = useState("");
  const [formulaText, setFormulaText] = useState("");
  const [formulaStaffId, setFormulaStaffId] = useState("");

  // 新增標籤 / 過敏 的暫存輸入
  const [tagInput, setTagInput] = useState("");
  const [allergyInput, setAllergyInput] = useState("");

  // 套票卡（P1）
  const [packages, setPackages] = useState<SalonCustomerPackage[]>([]);
  const [buyOpen, setBuyOpen] = useState(false);
  const [topupOpen, setTopupOpen] = useState(false);

  useEffect(() => {
    const list = loadCustomers();
    setCustomer(list.find((c) => c.id === id) ?? null);
    setPackages(loadSalonCustomerPackages().filter((p) => p.customerId === id));
    setLoaded(true);
  }, [id]);

  const ledger = useMemo(
    () => (customer ? getMockLedgerMember(customer.phone) : null),
    [customer],
  );

  const staffList = useMemo(() => loadSalonStaff().filter((s) => s.active), []);

  // 推薦人候選：所有客戶（排除自己）
  const customersList = useMemo(() => loadCustomers(), []);
  const referrer = useMemo(
    () => (customer?.referrerId ? customersList.find((c) => c.id === customer.referrerId) ?? null : null),
    [customer, customersList],
  );

  // 套票（P1）：可售模板 + 服務名稱對照
  const packageTemplates = useMemo(() => loadSalonPackageTemplates().filter((t) => t.active), []);
  const serviceItems = useMemo(() => loadServiceItems(), []);
  const serviceName = (sid: string) => serviceItems.find((s) => s.id === sid)?.name ?? sid;

  const productSales = useMemo(
    () =>
      customer
        ? loadSalonProductSales()
            .filter((s) => s.customerId === customer.id)
            .sort((a, b) => (a.soldAt < b.soldAt ? 1 : -1))
        : [],
    [customer],
  );

  const buyPackage = (templateId: string, method: SalonPaymentMethod) => {
    const tpl = packageTemplates.find((t) => t.id === templateId);
    if (!tpl || !customer) return;
    const purchasedAt = new Date().toISOString();
    const expiresAt =
      tpl.validityDays > 0
        ? new Date(Date.now() + tpl.validityDays * 86400000).toISOString()
        : undefined;
    const pkg: SalonCustomerPackage = {
      id: `cpkg-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      customerId: customer.id,
      templateId: tpl.id,
      templateName: tpl.name,
      price: tpl.price,
      purchasedAt,
      expiresAt,
      remaining: tpl.items.map((it) => ({ serviceItemId: it.serviceItemId, sessionsLeft: it.sessions })),
      status: "active",
      paymentMethod: method,
    };
    const next = [...loadSalonCustomerPackages(), pkg];
    saveSalonCustomerPackages(next);
    setPackages(next.filter((p) => p.customerId === customer.id));
    setBuyOpen(false);

    // P2：購買當下贈送積分 / 儲值寫入 Ledger（mock 層本地寫入；真 RPC 到位後只換 applyMockLedgerBonus 實作）
    if ((tpl.bonusPoints > 0 || tpl.bonusBalance > 0) && customer.phone) {
      applyMockLedgerBonus(customer.phone, {
        points: tpl.bonusPoints,
        balance: tpl.bonusBalance,
      });
    }
  };

  if (!loaded) return null;
  if (!customer) {
    return (
      <div className="p-6 text-sm text-slate-400">
        找不到此客戶。
        <Link href="/salon/customers" className="ml-2 text-rose-500 hover:underline">
          返回客戶列表
        </Link>
      </div>
    );
  }

  const persist = (next: SalonCustomerProfile) => {
    const all = loadCustomers().map((c) => (c.id === id ? next : c));
    saveCustomers(all);
    setCustomer(next);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  const toggleTag = (tag: string) => {
    const tags = customer.tags ?? [];
    const next = tags.includes(tag)
      ? tags.filter((t) => t !== tag)
      : [...tags, tag];
    persist({ ...customer, tags: next });
  };

  const addTag = () => {
    const t = tagInput.trim();
    if (!t) return;
    const tags = customer.tags ?? [];
    if (tags.includes(t)) {
      setTagInput("");
      return;
    }
    persist({ ...customer, tags: [...tags, t] });
    setTagInput("");
  };

  const removeTag = (tag: string) =>
    persist({ ...customer, tags: (customer.tags ?? []).filter((t) => t !== tag) });

  const addAllergy = () => {
    const a = allergyInput.trim();
    if (!a) return;
    const list = customer.allergies ?? [];
    if (list.includes(a)) {
      setAllergyInput("");
      return;
    }
    persist({ ...customer, allergies: [...list, a] });
    setAllergyInput("");
  };

  const removeAllergy = (a: string) =>
    persist({ ...customer, allergies: (customer.allergies ?? []).filter((x) => x !== a) });

  const addFormula = () => {
    if (!formulaService.trim() || !formulaText.trim()) return;
    const staff = staffList.find((s) => s.id === formulaStaffId);
    const rec: SalonFormulaRecord = {
      date: new Date().toISOString().slice(0, 10),
      service: formulaService.trim(),
      formula: formulaText.trim(),
      staffId: formulaStaffId || "unknown",
      staffName: staff?.name ?? "—",
    };
    persist({
      ...customer,
      formulaHistory: [...(customer.formulaHistory ?? []), rec],
    });
    setFormulaService("");
    setFormulaText("");
    setFormulaStaffId("");
  };

  // 從已結帳訂單推導配方歷史（Phase 5 產生訂單後自動可用）
  const deriveFromOrders = () => {
    const orders = loadSalonOrders().filter(
      (o) => o.customerId === id && o.status === "settled",
    );
    if (orders.length === 0) {
      window.alert("暫無已結帳訂單可推導（結帳功能上線後自動可用）。");
      return;
    }
    const existing = customer.formulaHistory ?? [];
    const derived: SalonFormulaRecord[] = [];
    for (const o of orders) {
      const day = (o.settledAt ?? o.createdAt).slice(0, 10);
      for (const it of o.items) {
        derived.push({
          date: day,
          service: it.name,
          formula: it.note ?? it.consumableNotes ?? "（由訂單推導）",
          staffId: it.staffId ?? "unknown",
          staffName: it.staffName ?? "—",
        });
      }
    }
    // 合併去重（同 date + service）
    const seen = new Set(existing.map((e) => `${e.date}|${e.service}`));
    const merged = [...existing];
    for (const d of derived) {
      const key = `${d.date}|${d.service}`;
      if (!seen.has(key)) {
        merged.push(d);
        seen.add(key);
      }
    }
    persist({ ...customer, formulaHistory: merged });
  };

  return (
    <div className="mx-auto max-w-4xl p-4 pb-24 md:p-6 md:pb-6">
      <div className="mb-4 flex items-center justify-between">
        <Link href="/salon/customers" className="text-sm text-slate-500 hover:text-rose-500">
          ← 客戶列表
        </Link>
        {saved && <span className="text-xs font-semibold text-emerald-600">已儲存</span>}
      </div>

      <h1 className="mb-1 text-2xl font-bold text-slate-900">{customer.name}</h1>
      <p className="mb-4 text-sm text-slate-400">{customer.phone}</p>

      {/* Ledger 會員資料（read-only） */}
      <section className="mb-4 rounded-2xl border border-slate-200 bg-slate-900 p-4 text-white">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-300">
          Ledger 會員資料（唯讀）
        </div>
        {ledger ? (
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <div className="text-lg font-bold text-emerald-300">
                MOP {ledger.ledgerBalance}
              </div>
              <div className="text-[11px] text-slate-400">餘額</div>
            </div>
            <div>
              <div className="text-lg font-bold text-amber-300">{ledger.ledgerPoints}</div>
              <div className="text-[11px] text-slate-400">積分</div>
            </div>
            <div>
              <div className="text-lg font-bold text-rose-300">{ledger.ledgerTier}</div>
              <div className="text-[11px] text-slate-400">等級</div>
            </div>
          </div>
        ) : (
          <div className="text-sm text-slate-400">尚無 Ledger 會員資料</div>
        )}
        <p className="mt-2 text-[10px] text-slate-500">
          餘額 / 積分 / 等級由 Ledger 主導，POS 只讀取，不在此修改。
        </p>
        <button
          type="button"
          onClick={() => setTopupOpen(true)}
          className="mt-3 w-full rounded-xl bg-rose-500 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-600"
        >
          替會員充值（Ledger）
        </button>
      </section>

      {/* 標籤 */}
      <Section title="標籤">
        <div className="flex flex-wrap gap-2">
          {QUICK_TAGS.map((t) => {
            const active = (customer.tags ?? []).includes(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggleTag(t)}
                className={`rounded-full px-3 py-1.5 text-sm font-semibold transition ${
                  active
                    ? "bg-rose-500 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {t}
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {(customer.tags ?? []).map((t) => (
            <span
              key={t}
              className="flex items-center gap-1 rounded-full bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-600"
            >
              {t}
              <button
                type="button"
                onClick={() => removeTag(t)}
                className="text-rose-400 hover:text-rose-700"
                aria-label={`移除 ${t}`}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addTag()}
            placeholder="自訂標籤"
            className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
          />
          <button
            type="button"
            onClick={addTag}
            className="rounded-xl bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-200"
          >
            加標籤
          </button>
        </div>
      </Section>

      {/* 檔案號碼（F5：free text，供商家與實體文件對照） */}
      <Section title="檔案號碼">
        <input
          type="text"
          value={customer.fileNumber ?? ""}
          placeholder="例如 A-2026-001"
          onChange={(e) => persist({ ...customer, fileNumber: e.target.value.trim() || undefined })}
          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
        />
        <p className="mt-1 text-[11px] text-slate-400">
          自由輸入，用於與實體紙本檔案對照（如會員卡號 / 紙本編號）。
        </p>
      </Section>

      {/* 推薦人（Phase 8） */}
      <Section title="推薦人">
        <div className="mb-1 flex items-center justify-between">
          <div className="text-xs font-medium text-slate-500">由哪位客戶推薦</div>
          {customer.referralRewarded ? (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
              已發獎勵
            </span>
          ) : null}
        </div>
        <select
          value={customer.referrerId ?? ""}
          onChange={(e) => persist({ ...customer, referrerId: e.target.value || undefined })}
          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
        >
          <option value="">（無 / 自行到店）</option>
          {customersList
            .filter((c) => c.id !== customer.id)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}（{c.phone}）
              </option>
            ))}
        </select>
        {referrer ? (
          <div className="mt-2 text-xs text-slate-600">
            推薦人：{referrer.name}（{referrer.phone}）
            {customer.referralRewarded ? " · 首次結帳已發推薦積分" : " · 待其首次結帳發推薦積分"}
          </div>
        ) : null}
        <p className="mt-1 text-[11px] text-slate-400">
          設定後，本客戶首次結帳時，推薦人將獲得「設置 → 會員優惠」中的推薦積分（僅推薦人得分，防刷分）。
        </p>
      </Section>

      {/* 購買產品（F4：雙介面顯示） */}
      <Section title="購買產品">
        {productSales.length === 0 ? (
          <p className="text-xs text-slate-400">尚無產品購買記錄。</p>
        ) : (
          <ul className="grid gap-1.5">
            {productSales.map((s) => (
              <li key={s.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm">
                <div>
                  <div className="font-medium text-slate-800">{s.productName}</div>
                  <div className="text-[11px] text-slate-500">
                    {s.soldAt.slice(0, 10)} · 員工 {s.staffName}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-semibold text-slate-700">MOP {s.price}</div>
                  <div className="text-[11px] text-emerald-600">佣金 MOP {s.commissionAmount}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* 膚質 / 髮質 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Section title="膚質">
          <select
            value={customer.skinType ?? ""}
            onChange={(e) =>
              persist({
                ...customer,
                skinType: (e.target.value || undefined) as SalonSkinType | undefined,
              })
            }
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
          >
            <option value="">未記錄</option>
            {SKIN_OPTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Section>

        <Section title="髮質">
          <select
            value={customer.hairType ?? ""}
            onChange={(e) =>
              persist({
                ...customer,
                hairType: (e.target.value || undefined) as SalonHairType | undefined,
              })
            }
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
          >
            <option value="">未記錄</option>
            {HAIR_OPTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Section>
      </div>

      {/* 過敏 */}
      <Section title="過敏 / 禁忌">
        <div className="flex flex-wrap gap-2">
          {(customer.allergies ?? []).map((a) => (
            <span
              key={a}
              className="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700"
            >
              {a}
              <button
                type="button"
                onClick={() => removeAllergy(a)}
                className="text-amber-500 hover:text-amber-800"
                aria-label={`移除 ${a}`}
              >
                ✕
              </button>
            </span>
          ))}
          {(customer.allergies ?? []).length === 0 && (
            <span className="text-xs text-slate-400">未記錄</span>
          )}
        </div>
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            value={allergyInput}
            onChange={(e) => setAllergyInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addAllergy()}
            placeholder="例如：香料、坚果"
            className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
          />
          <button
            type="button"
            onClick={addAllergy}
            className="rounded-xl bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-200"
          >
            加過敏項
          </button>
        </div>
      </Section>

      {/* 偏好 / 備註 */}
      <Section title="偏好 / 備註">
        <textarea
          value={customer.preferences ?? ""}
          onChange={(e) => persist({ ...customer, preferences: e.target.value })}
          rows={2}
          placeholder="客戶特殊需求、喜好等"
          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
        />
      </Section>

      {/* 配方歷史 */}
      <Section
        title="配方歷史"
        action={
          <button
            type="button"
            onClick={deriveFromOrders}
            className="rounded-lg bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-200"
          >
            從結帳訂單推導
          </button>
        }
      >
        <div className="space-y-2">
          {(customer.formulaHistory ?? []).length === 0 && (
            <p className="text-xs text-slate-400">尚無配方記錄</p>
          )}
          {(customer.formulaHistory ?? []).map((f, i) => (
            <div key={i} className="rounded-xl bg-slate-50 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-800">{f.service}</span>
                <span className="text-[11px] text-slate-400">{f.date}</span>
              </div>
              <div className="text-slate-600">{f.formula}</div>
              <div className="text-[11px] text-slate-400">執行：{f.staffName}</div>
            </div>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <input
            type="text"
            value={formulaService}
            onChange={(e) => setFormulaService(e.target.value)}
            placeholder="服務項目"
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
          />
          <input
            type="text"
            value={formulaText}
            onChange={(e) => setFormulaText(e.target.value)}
            placeholder="配方 / 備註"
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
          />
        </div>
        <div className="mt-2 flex gap-2">
          <select
            value={formulaStaffId}
            onChange={(e) => setFormulaStaffId(e.target.value)}
            className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
          >
            <option value="">執行技師</option>
            {staffList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={addFormula}
            className="rounded-xl bg-rose-500 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-600"
          >
            加配方
          </button>
        </div>
      </Section>

      {/* 到店統計 */}
      <Section title="到店統計">
        <div className="grid grid-cols-3 gap-3 text-center text-sm">
          <div>
            <div className="text-lg font-bold text-slate-800">{customer.visitCount}</div>
            <div className="text-[11px] text-slate-400">到店次數</div>
          </div>
          <div>
            <div className="text-lg font-bold text-slate-800">
              MOP {customer.totalSpent ?? 0}
            </div>
            <div className="text-[11px] text-slate-400">累計消費</div>
          </div>
          <div>
            <div className="text-lg font-bold text-slate-800">
              {customer.lastVisitAt ? customer.lastVisitAt.slice(0, 10) : "—"}
            </div>
            <div className="text-[11px] text-slate-400">最近到店</div>
          </div>
        </div>
      </Section>

      {/* 套票卡（P1） */}
      <Section
        title="套票卡"
        action={
          <button
            type="button"
            onClick={() => setBuyOpen(true)}
            className="rounded-lg bg-rose-100 px-3 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-200"
          >
            賣套票
          </button>
        }
      >
        {packages.length === 0 ? (
          <p className="text-xs text-slate-400">尚未購買套票，點右上角「賣套票」。</p>
        ) : (
          <div className="grid gap-2">
            {packages.map((p) => {
              const expired = p.expiresAt ? new Date(p.expiresAt).getTime() < Date.now() : false;
              const badge =
                p.status === "used_up"
                  ? { label: "已用完", cls: "bg-slate-200 text-slate-500" }
                  : expired
                    ? { label: "已過期", cls: "bg-amber-100 text-amber-700" }
                    : { label: "使用中", cls: "bg-emerald-100 text-emerald-700" };
              return (
                <div key={p.id} className="rounded-xl bg-slate-50 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-slate-800">{p.templateName}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${badge.cls}`}>
                      {badge.label}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    購於 {p.purchasedAt.slice(0, 10)}
                    {p.expiresAt ? ` · 效期至 ${p.expiresAt.slice(0, 10)}` : " · 永久"}
                    {p.paymentMethod ? ` · ${PAYMENT_OPTS.find((o) => o.value === p.paymentMethod)?.label ?? p.paymentMethod}` : ""}
                  </div>
                  <div className="mt-2 grid gap-1">
                    {p.remaining.map((r, i) => (
                      <div key={i} className="flex items-center justify-between text-xs">
                        <span className="text-slate-600">{serviceName(r.serviceItemId)}</span>
                        <span className="font-semibold text-slate-700">剩 {r.sessionsLeft} 次</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* 積分兌換力（P-積分兌換）：顯示客戶現有積分可兌換哪些服務 */}
      <Section title="積分兌換力">
        {ledger ? (
          <>
            <div className="mb-2 text-xs text-slate-500">
              現有 <span className="font-semibold text-amber-700">{ledger.ledgerPoints}</span> 分，
              以下服務可於結帳時以積分兌換（部分積分 + 現金 mix 亦可）。
            </div>
            <div className="grid gap-2">
              {serviceItems
                .filter((s) => (s.pointsPrice ?? 0) > 0 && s.active)
                .map((s) => {
                  const times = Math.floor(ledger.ledgerPoints / (s.pointsPrice ?? 0));
                  return (
                    <div key={s.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
                      <div>
                        <div className="text-sm font-semibold text-slate-800">{s.name}</div>
                        <div className="text-[11px] text-slate-500">
                          MOP {s.price} / {s.pointsPrice} 分
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-bold text-emerald-600">可兌 {times} 次</div>
                        <div className="text-[11px] text-slate-400">全額積分兌換</div>
                      </div>
                    </div>
                  );
                })}
              {serviceItems.filter((s) => (s.pointsPrice ?? 0) > 0 && s.active).length === 0 && (
                <p className="text-xs text-slate-400">尚無服務設定積分價，請到「設置 → 服務項目」填寫。</p>
              )}
            </div>
          </>
        ) : (
          <p className="text-xs text-slate-400">此客戶無 Ledger 會員資料，無法計算兌換力。</p>
        )}
      </Section>

      {buyOpen ? (
        <BuyPackageModal
          templates={packageTemplates}
          serviceName={serviceName}
          onCancel={() => setBuyOpen(false)}
          onConfirm={buyPackage}
        />
      ) : null}

      {topupOpen ? (
        <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/40 p-2 sm:p-6">
          <div className="flex w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h3 className="text-base font-bold text-slate-900">會員充值 · {customer?.name}</h3>
              <button
                type="button"
                className="rounded-xl bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-200"
                onClick={() => setTopupOpen(false)}
              >
                關閉
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <MemberTopupPanel />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold text-slate-700">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────
// 賣套票 Modal（P1）
// 選模板 → 選付款方式 → 生成客戶套票卡（次數額度留本地）。
// 真扣款 / 贈送積分寫入 Ledger 留 P2。
// ────────────────────────────────────────────────────────────────────
function BuyPackageModal({
  templates,
  serviceName,
  onCancel,
  onConfirm,
}: {
  templates: SalonPackageTemplate[];
  serviceName: (id: string) => string;
  onCancel: () => void;
  onConfirm: (templateId: string, method: SalonPaymentMethod) => void;
}) {
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [method, setMethod] = useState<SalonPaymentMethod>("cash");
  const tpl = templates.find((t) => t.id === templateId);

  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-black/40 md:place-items-center" onClick={onCancel}>
      <div
        className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 shadow-xl md:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-base font-bold text-slate-900">賣套票</h3>
        {templates.length === 0 ? (
          <p className="text-sm text-slate-500">尚無可售套票模板，請先到「設置 → 套票模板」建立。</p>
        ) : (
          <div className="grid gap-3">
            <div>
              <div className="mb-1 text-xs font-medium text-slate-500">選擇套票</div>
              <select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
              >
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}（MOP {t.price}）
                  </option>
                ))}
              </select>
            </div>
            {tpl ? (
              <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
                <div className="mb-1 font-semibold text-slate-700">套票內容</div>
                <ul className="grid gap-0.5">
                  {tpl.items.map((it, i) => (
                    <li key={i}>
                      {serviceName(it.serviceItemId)} × {it.sessions} 次
                    </li>
                  ))}
                </ul>
                {tpl.validityDays > 0 ? <div className="mt-1">效期 {tpl.validityDays} 天</div> : null}
                {tpl.bonusPoints > 0 ? <div className="mt-1 text-amber-700">贈 {tpl.bonusPoints} 積分（購買當下寫入 Ledger）</div> : null}
                {tpl.bonusBalance > 0 ? <div className="mt-1 text-emerald-700">贈儲值 MOP {tpl.bonusBalance}（購買當下寫入 Ledger）</div> : null}
              </div>
            ) : null}
            <div>
              <div className="mb-1 text-xs font-medium text-slate-500">付款方式</div>
              <div className="flex flex-wrap gap-1.5">
                {PAYMENT_OPTS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setMethod(o.value)}
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      method === o.value ? "bg-rose-500 text-white" : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-[11px] text-slate-400">
              確認後生成客戶套票卡；贈送積分 / 儲值即時寫入 Ledger（mock 層），結帳時可一鍵抵扣次數。
            </p>
          </div>
        )}
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-200"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!tpl}
            onClick={() => tpl && onConfirm(tpl.id, method)}
            className="flex-1 rounded-xl bg-rose-500 px-4 py-2.5 text-sm font-bold text-white hover:bg-rose-600 disabled:opacity-40"
          >
            確認售出
          </button>
        </div>
      </div>
    </div>
  );
}
