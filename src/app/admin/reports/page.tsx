"use client";

import { useCallback, useEffect, useState } from "react";

import { AdminShell } from "@/components/admin-shell";
import { RestaurantDailyReport } from "@/components/restaurant-daily-report";
import { loadAuthSession } from "@/lib/storage";
import type { PosOrder } from "@/lib/types";

/**
 * Admin panel · 營業報表（view-only）。
 *
 * - 商家下拉篩選（含「全部」彙總選項）
 * - 單店模式：RestaurantDailyReport + merchantIdOverride（POS 訂單經
 *   /api/pos/state?storeId= 拉取，Ledger 會員類模塊自動跳過）
 * - 全部模式：allStoresMode + adminOrderFetcher（GET /api/admin/orders 跨店拉單）
 * - 無任何列印 / 匯出 / 操作按鈕
 */

type AdminMerchant = { id: string; name: string; status: string };

export default function AdminReportsPage() {
  const [merchants, setMerchants] = useState<AdminMerchant[]>([]);
  const [selected, setSelected] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const token = loadAuthSession()?.adminSessionToken;
        const res = await fetch("/api/admin/merchants", {
          headers: { Authorization: `Bearer ${token ?? ""}` },
        });
        const json = (await res.json()) as { ok?: boolean; merchants?: AdminMerchant[]; error?: string };
        if (cancelled) return;
        if (!res.ok || !json.ok) {
          setError(json.error ?? `載入商家列表失敗（HTTP ${res.status}）`);
          return;
        }
        setMerchants(json.merchants ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const adminOrderFetcher = useCallback(
    async (params: { start?: string; end?: string; limit: number; offset: number }) => {
      const token = loadAuthSession()?.adminSessionToken;
      const qs = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) });
      if (params.start) qs.set("start", params.start);
      if (params.end) qs.set("end", params.end);
      const res = await fetch(`/api/admin/orders?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token ?? ""}` },
      });
      const json = (await res.json()) as { ok?: boolean; orders?: PosOrder[]; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      return json.orders ?? [];
    },
    [],
  );

  const selectedMerchant = merchants.find((m) => m.id === selected) ?? null;

  return (
    <AdminShell>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
          <h2 className="mr-auto text-sm font-semibold text-slate-900">營業報表</h2>
          <label className="flex items-center gap-2 text-xs text-slate-500">
            商家
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900"
            >
              <option value="all">全部（彙總所有商家）</option>
              {merchants.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.status === "suspended" ? "（已停用）" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}

        {selected === "all" ? (
          <RestaurantDailyReport
            key="admin-all"
            allStoresMode
            storeNameOverride="全部商家"
            adminOrderFetcher={adminOrderFetcher}
          />
        ) : selectedMerchant ? (
          <RestaurantDailyReport
            key={selectedMerchant.id}
            merchantIdOverride={selectedMerchant.id}
            storeNameOverride={selectedMerchant.name}
          />
        ) : (
          <p className="px-1 py-6 text-sm text-slate-500">載入商家列表中…</p>
        )}
      </div>
    </AdminShell>
  );
}
