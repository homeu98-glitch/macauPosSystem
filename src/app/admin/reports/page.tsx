"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { AdminShell } from "@/components/admin-shell";
import { RestaurantDailyReport } from "@/components/restaurant-daily-report";
import { loadAuthSession } from "@/lib/storage";
import type { PosOrder } from "@/lib/types";

/**
 * Admin panel · 營業報表（view-only）。
 *
 * - 商家搜尋 + 即時下拉（取代舊版 <select>；輸入即時顯示匹配商家，例：輸入「表」→ 「表嫂美食」）
 * - 單店模式：RestaurantDailyReport + merchantIdOverride（POS 訂單經
 *   /api/pos/state?storeId= 拉取，Ledger 會員類模塊自動跳過）
 * - 全部模式：allStoresMode + adminOrderFetcher（GET /api/admin/orders 跨店拉單）
 * - 支援 URL ?merchantId= 直接跳到指定商家（admin/dashboard 點擊導航入口）
 * - 無任何列印 / 匯出 / 操作按鈕
 */

type AdminMerchant = { id: string; name: string; status: string };

export default function AdminReportsPage() {
  const [merchants, setMerchants] = useState<AdminMerchant[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 🩺 2026-09-07 修：訂單讀取失敗時嘅具體原因（HTTP status + server code + 查詢區間）。
  // 舊版報表「完全空白」但唔講點解；而家頂部會直接顯示失敗原因，一眼分到
  // 「未授權 / 資料庫未配置 / 查詢失敗 / 真·冇單」。
  const [orderFetchError, setOrderFetchError] = useState<string | null>(null);

  // 商家搜尋 + 選擇狀態（2026-09-06 修）：用 input + 即時下拉取代 <select>，
  // 解決問題 7 嘅搜尋需求。
  const [merchantSearch, setMerchantSearch] = useState("");
  const [merchantDropdownOpen, setMerchantDropdownOpen] = useState(false);
  // 當前選中嘅商家 ID（"all" = 全部商家彙總；其餘為商家 UUID）。
  const [selected, setSelected] = useState<string>("all");

  // 問題 3（2026-09-06 修）：從 URL ?merchantId= 讀取初始選中商家
  // （admin/dashboard 點擊導航嘅入口約定），並雙向同步回 URL。
  // 用 window.location.search 讀 query（同 pos-app.tsx 慣例一致），
  // 避開 useSearchParams 喺 server page 靜態預渲染時嘅 Suspense 要求。
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("merchantId")?.trim() ?? "";
    if (fromUrl) {
      setSelected(fromUrl);
    }
  }, []);

  // 同步 selected → URL（唔覆蓋其他 query）
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (selected === "all") {
      url.searchParams.delete("merchantId");
    } else {
      url.searchParams.set("merchantId", selected);
    }
    // 用 replace 避免每次點選都塞入 history
    window.history.replaceState({}, "", url.toString());
  }, [selected]);

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
      const json = (await res.json()) as {
        ok?: boolean;
        orders?: PosOrder[];
        error?: string;
        code?: string;
        debug?: { start: string | null; end: string | null; count: number };
      };
      if (!res.ok || !json.ok) {
        // 🩺 2026-09-07 修：舊版淨係 throw 一句短 message，前端 catch 咗就靜默當 0 筆，
        // 用戶完全唔知係 401（token 冇 / 過期）、503（Supabase 未配置）定係真·冇單。
        // 而家帶埋 HTTP status + server code + 查詢區間，等報表頁可以顯示具體原因。
        const prefix = res.status === 401 ? "未授權（請重新登入管理後台）" : `HTTP ${res.status}`;
        setOrderFetchError(
          `${prefix}：${json.error ?? "讀取訂單失敗"}` +
            (json.code ? ` [${json.code}]` : "") +
            (json.debug ? `（區間 ${json.debug.start ?? "∞"} → ${json.debug.end ?? "∞"}）` : ""),
        );
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setOrderFetchError(null);
      return json.orders ?? [];
    },
    [],
  );

  const selectedMerchant = merchants.find((m) => m.id === selected) ?? null;

  // 問題 7（2026-09-06 修）：即時過濾商家清單（不區分大小寫、支援中英）。
  // merchantSearch 唔只過濾下拉，亦用作 input 嘅顯示內容。
  const filteredMerchants = useMemo(() => {
    const q = merchantSearch.trim().toLowerCase();
    if (!q) return merchants;
    return merchants.filter(
      (m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
    );
  }, [merchants, merchantSearch]);

  // 顯示喺搜尋框嘅當前文字：未選店家時 = merchantSearch；選中後 = 該店名（保持 user-friendly）。
  const inputValue = useMemo(() => {
    if (selected === "all") return merchantSearch;
    const m = merchants.find((x) => x.id === selected);
    return m?.name ?? merchantSearch;
  }, [selected, merchants, merchantSearch]);

  function pickMerchant(id: string) {
    setSelected(id);
    setMerchantSearch("");
    setMerchantDropdownOpen(false);
  }

  function pickAll() {
    setSelected("all");
    setMerchantSearch("");
    setMerchantDropdownOpen(false);
  }

  return (
    <AdminShell>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
          <h2 className="mr-auto text-sm font-semibold text-slate-900">營業報表</h2>
          {/* 問題 7（2026-09-06 修）：商家搜尋 + 即時下拉。輸入「表」即時顯示「表嫂美食」
              等名稱相關商家。下拉預設顯示全部商家，輸入後即時過濾。
              點擊外部關閉 dropdown（用 blur + timeout）。 */}
          <div className="relative w-72">
            <input
              type="search"
              value={inputValue}
              onChange={(e) => {
                setMerchantSearch(e.target.value);
                setMerchantDropdownOpen(true);
                // 用戶開始輸入 → 自動清除「已選中單店」狀態，回歸「按輸入過濾」模式
                if (selected !== "all") setSelected("all");
              }}
              onFocus={() => setMerchantDropdownOpen(true)}
              onBlur={() => {
                // 延遲關閉，畀 onClick 嘅 <button> 先觸發揀選
                setTimeout(() => setMerchantDropdownOpen(false), 120);
              }}
              placeholder="搜尋商家名稱（例：輸入「表」）"
              className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 outline-none focus:border-blue-500"
              aria-label="搜尋商家"
            />
            {merchantDropdownOpen ? (
              <div className="absolute right-0 left-0 z-30 mt-1 max-h-72 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={pickAll}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-slate-50 ${
                    selected === "all" ? "bg-blue-50 font-semibold text-blue-700" : "text-slate-700"
                  }`}
                >
                  <span>全部商家（彙總所有商家）</span>
                  <span className="text-xs text-slate-400">{merchants.length} 間</span>
                </button>
                <div className="border-t border-slate-100" />
                {filteredMerchants.length === 0 ? (
                  <p className="px-3 py-3 text-xs text-slate-400">搜尋「{merchantSearch}」沒有匹配商家。</p>
                ) : (
                  filteredMerchants.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickMerchant(m.id)}
                      className={`flex w-full items-center justify-between gap-2 border-t border-slate-50 px-3 py-2 text-left text-sm transition-colors hover:bg-slate-50 first:border-t-0 ${
                        selected === m.id ? "bg-blue-50 font-semibold text-blue-700" : "text-slate-700"
                      }`}
                    >
                      <span className="truncate">{m.name}</span>
                      <span className="text-xs text-slate-400">
                        {m.status === "suspended" ? "已停用" : ""}
                      </span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>
        </div>

        {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}

        {orderFetchError && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <p className="font-semibold">⚠️ 訂單數據讀取失敗，報表可能顯示為空</p>
            <p className="mt-1 text-xs">{orderFetchError}</p>
            <p className="mt-1 text-xs text-amber-700">
              排查方向：① 管理後台 token 是否過期（重新登入）；② server 環境變數
              SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 是否配置；③ server log 度 grep{" "}
              <code>[admin/orders]</code> 睇實際查詢區間同筆數。
            </p>
          </div>
        )}

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