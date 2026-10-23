"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { AdminShell } from "@/components/admin-shell";
import { StaffPermissionPanel } from "@/components/staff-permission-panel";
import { loadAuthSession } from "@/lib/storage";

/**
 * Admin · 權限控制（2026-10-23）。
 *
 * 店主喺後台揀店 → 管理該店員工嘅角色／可見頁面／操作權限。
 *
 * ## 為何要喺後台都有（POS 設定頁已經有）
 *
 * 兩個入口嘅使用場景唔同：
 * - **POS 設定頁**：老闆就喺收銀機前面，順手改，零跳轉；
 * - **後台 `/admin/staff`**：老闆喺屋企／手機睇多店，唔使開 POS 終端。
 *
 * 兩邊共用同一個 `StaffPermissionPanel`，只係憑證唔同
 * （POS 用 Ledger token、後台用 `adminSessionToken`）—— 邏輯只有一份。
 *
 * ⚠️ 平台帳號（scope.all）都入得呢頁：支援時要幫客店設定。
 *    店主帳號只會見到自己綁定嘅店（`/api/admin/merchants` 已按 scope 過濾）。
 */

type Merchant = { id: string; name: string };

export default function AdminStaffPage() {
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [storeId, setStoreId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const token = typeof window === "undefined" ? "" : (loadAuthSession()?.adminSessionToken ?? "");
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/merchants", { headers: authHeaders });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        merchants?: Merchant[];
      };
      if (!response.ok || !payload.ok) {
        setError(payload.error ?? `載入店舖清單失敗（HTTP ${response.status}）`);
        return;
      }
      const list = (payload.merchants ?? []).map((m) => ({ id: m.id, name: m.name }));
      setMerchants(list);
      setStoreId((prev) => prev || list[0]?.id || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "網絡錯誤，請稍後再試。");
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = merchants.find((m) => m.id === storeId);

  return (
    <AdminShell>
      <div className="grid gap-4">
        <section className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <div className="text-lg font-semibold text-slate-900">權限控制</div>
              <div className="mt-1 text-sm text-slate-500">
                設定每間店嘅員工角色、可見頁面同操作權限。員工用「工號 + PIN」喺收銀台簽到，
                <span className="font-medium text-slate-700">唔需要 Ledger 戶口</span>。
              </div>
            </div>
            <label className="grid gap-1">
              <span className="text-xs text-slate-500">店舖</span>
              <select
                className="min-h-[44px] min-w-[220px] rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900"
                disabled={loading || merchants.length === 0}
                onChange={(e) => setStoreId(e.target.value)}
                value={storeId}
              >
                {merchants.length === 0 ? <option value="">（冇可見店舖）</option> : null}
                {merchants.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {error ? (
            <div className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          ) : null}
          {!loading && merchants.length === 0 && !error ? (
            <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
              你嘅帳號未綁定任何店舖，所以冇嘢可以設定。請聯絡平台管理員綁店。
            </div>
          ) : null}
        </section>

        {storeId ? (
          <StaffPermissionPanel
            adminToken={token}
            storeId={storeId}
            storeName={selected?.name}
          />
        ) : null}

        <p className="px-1 text-xs leading-relaxed text-slate-500">
          註：店主（Ledger owner）自己唔受呢度限制，永遠全開；呢度只管「店長」同「收銀員」。
          權限改動下一個簽到即刻生效（已簽到嘅人要重新簽到）。
        </p>
      </div>
    </AdminShell>
  );
}
