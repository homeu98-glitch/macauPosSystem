"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AdminShell } from "@/components/admin-shell";
import { RestaurantDailyReport } from "@/components/restaurant-daily-report";
import type { ReportRangeKey } from "@/lib/ledger/report-period";
import { loadAuthSession } from "@/lib/storage";
import type { PosOrder } from "@/lib/types";

/** 2026-09-10：右上角「重新載入」用到的循環箭頭 icon。
 *  inline SVG —— 唔想為一個 icon 引入整套圖標庫，線條粗細/尺寸對齊頁面既有 xs 按鈕。 */
function RefreshIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20.5 12a8.5 8.5 0 1 1-2.49-6.01" />
      <polyline points="20.5 3.5 20.5 9.5 14.5 9.5" />
    </svg>
  );
}

/**
 * Admin panel · 營業報表（view-only）。
 *
 * - 商家搜尋 + 即時下拉（取代舊版 <select>；輸入即時顯示匹配商家，例：輸入「表」→ 「表嫂美食」）
 * - 單店模式：RestaurantDailyReport + merchantIdOverride（POS 訂單經
 *   /api/pos/state?storeId= 拉取，Ledger 會員類模塊自動跳過）
 * - 全部模式：allStoresMode + adminOrderFetcher（GET /api/admin/orders 跨店拉單）
 * - 支援 URL ?merchantId= 直接跳到指定商家（admin/dashboard 點擊導航入口）
 * - 無任何列印 / 匯出按鈕
 * - 右上角「重新載入」（2026-09-10）：換 key 令 RestaurantDailyReport remount，
 *   商家下拉 + 報表數據 / 圖表 / 統計數字全部重拉；進行中 disabled，失敗有錯誤提示
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

  // 2026-09-10：報表重新載入狀態。
  // 「重新載入」嘅做法係幫 RestaurantDailyReport 換 key → React remount 一個全新 instance，
  // 全部 state（訂單 / Ledger 彙總 / 線上單 / 明細 / useMemo）由零重新拉過，
  // 係最徹底、唔會漏任何一個數據源嘅刷新方式。
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  /** 由報表組件回報：true = 有數據源喺載入中（用嚟 disable 按鈕，防重複點擊）。 */
  const [reportBusy, setReportBusy] = useState(true);
  const busyRef = useRef(true);
  /** 由報表組件回報嘅載入錯誤摘要（冇錯 = null）。 */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 用戶喺報表入面揀嘅範圍：remount 後用 initialRange 還原，唔會彈返「今日」。 */
  const [reportRange, setReportRange] = useState<ReportRangeKey>("today");

  const loadMerchants = useCallback(async () => {
    try {
      const token = loadAuthSession()?.adminSessionToken;
      const res = await fetch("/api/admin/merchants", {
        headers: { Authorization: `Bearer ${token ?? ""}` },
      });
      const json = (await res.json()) as { ok?: boolean; merchants?: AdminMerchant[]; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `載入商家列表失敗（HTTP ${res.status}）`);
        return;
      }
      setError(null);
      setMerchants(json.merchants ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadMerchants();
  }, [loadMerchants]);

  const adminOrderFetcher = useCallback(
    async (params: { storeId?: string; start?: string; end?: string; limit: number; offset: number }) => {
      const token = loadAuthSession()?.adminSessionToken;
      const qs = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) });
      // 帶 storeId = 單店；唔帶 = 全部店（跨店彙總）。
      if (params.storeId) qs.set("storeId", params.storeId);
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

  // 報表組件回調（用 useCallback 保持引用穩定，避免子組件 effect 無限重跑）。
  const handleBusyChange = useCallback((busy: boolean) => {
    busyRef.current = busy;
    setReportBusy(busy);
  }, []);
  const handleLoadError = useCallback((message: string | null) => {
    setLoadError(message);
  }, []);
  const handleRangeChange = useCallback((next: ReportRangeKey) => {
    setReportRange(next);
  }, []);

  /** 業務/NFR：點擊「重新載入」→ 商家列表 + 報表全部數據重新拉取。
   *  進行中禁用按鈕；完成後資料自動同步更新（remount 會重跑所有 effect）。 */
  function handleRefresh() {
    if (refreshing || reportBusy) return;
    setRefreshing(true);
    setLoadError(null);
    setOrderFetchError(null);
    void loadMerchants();
    setRefreshSeq((n) => n + 1);
  }

  /** 報表區（子組件）係咪掛載緊：冇掛載時唔可以留低舊嘅 busy=true，否則按鈕會永久 disabled。 */
  const reportMounted = selected === "all" || Boolean(selectedMerchant);
  useEffect(() => {
    if (reportMounted) return;
    busyRef.current = false;
    setReportBusy(false);
  }, [reportMounted]);

  // 完成偵測：remount 後報表 busy 會 true → false，busy 落返 false 即本輪刷新完成。
  // 用 polling 而唔係單純 transition effect，係因為極端情況（請求快到同一個 render batch
  // 內完成）effect 捕捉唔到 busy 由 true→false 嘅跳變，會令按鈕永久卡喺 loading。
  // 600ms 下限同時避免秒回時按鈕瘋狂閃爍。
  useEffect(() => {
    if (!refreshing) return;
    const startedAt = Date.now();
    const id = setInterval(() => {
      if (busyRef.current) return;
      if (Date.now() - startedAt < 600) return;
      setRefreshing(false);
    }, 300);
    return () => clearInterval(id);
  }, [refreshing]);

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
          {/* 2026-09-10：重新載入 —— 重新拉商家下拉 + 成個報表（數據 / 圖表 / 統計數字）。
              載入中 disabled 防重複點擊；icon 旋轉 + 文案切換做 loading 反饋。 */}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing || reportBusy}
            aria-busy={refreshing}
            title={refreshing ? "正在重新載入報表數據…" : "重新載入報表數據"}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400 disabled:hover:bg-transparent"
          >
            <RefreshIcon className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "載入中…" : "重新載入"}
          </button>
        </div>

        {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}

        {/* orderFetchError 由 adminOrderFetcher（/api/admin/orders）寫入；
            loadError 由報表組件統一回報其他數據源（線上單 / 明細 / Ledger 彙總）嘅失敗。
            兩者去同一張提示卡，避免同一個原因彈兩次。 */}
        {(orderFetchError || loadError) && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <p className="font-semibold">⚠️ 數據載入失敗，報表可能顯示為空</p>
            {orderFetchError ? <p className="mt-1 text-xs">{orderFetchError}</p> : null}
            {loadError && loadError !== orderFetchError ? <p className="mt-1 text-xs">{loadError}</p> : null}
            <p className="mt-1 text-xs text-amber-700">
              排查方向：① 管理後台 token 是否過期（重新登入）；② server 環境變數
              SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 是否配置；③ server log 度 grep{" "}
              <code>[admin/orders]</code> 睇實際查詢區間同筆數；④ 點右上角「重新載入」再試一次。
            </p>
          </div>
        )}

        {selected === "all" ? (
          // key 帶 refreshSeq：點「重新載入」即 remount，所有數據由零重拉；
          // initialRange / onRangeChange 負責保留用戶已揀嘅日期範圍。
          <RestaurantDailyReport
            key={`admin-all-${refreshSeq}`}
            allStoresMode
            storeNameOverride="全部商家"
            adminOrderFetcher={adminOrderFetcher}
            initialRange={reportRange}
            onRangeChange={handleRangeChange}
            onBusyChange={handleBusyChange}
            onLoadError={handleLoadError}
          />
        ) : selectedMerchant ? (
          <RestaurantDailyReport
            key={`${selectedMerchant.id}-${refreshSeq}`}
            merchantIdOverride={selectedMerchant.id}
            storeNameOverride={selectedMerchant.name}
            // 2026-09-10 修：單店**都要**行 admin 通道（/api/admin/orders?storeId=）。
            // 之前唔傳 fetcher → 報表會行 `/api/pos/state?storeId=`，但嗰支 API 自 P0-4 起
            // 要求 POS 終端憑證，admin 裝置冇 → 一選商家就「POS 訂單：HTTP 401」。
            adminOrderFetcher={adminOrderFetcher}
            initialRange={reportRange}
            onRangeChange={handleRangeChange}
            onBusyChange={handleBusyChange}
            onLoadError={handleLoadError}
          />
        ) : (
          <p className="px-1 py-6 text-sm text-slate-500">載入商家列表中…</p>
        )}
      </div>
    </AdminShell>
  );
}