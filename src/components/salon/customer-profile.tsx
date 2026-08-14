"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import {
  loadCustomers,
  saveCustomers,
  loadSalonOrders,
  loadSalonStaff,
} from "@/lib/salon/storage";
import { getMockLedgerMember } from "@/lib/salon/mock-ledger";
import type {
  SalonCustomerProfile,
  SalonSkinType,
  SalonHairType,
  SalonFormulaRecord,
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

  useEffect(() => {
    const list = loadCustomers();
    setCustomer(list.find((c) => c.id === id) ?? null);
    setLoaded(true);
  }, [id]);

  const ledger = useMemo(
    () => (customer ? getMockLedgerMember(customer.phone) : null),
    [customer],
  );

  const staffList = useMemo(() => loadSalonStaff().filter((s) => s.active), []);

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
