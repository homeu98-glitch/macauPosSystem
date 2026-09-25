"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { ensureLedgerSession } from "@/lib/ledger/session";
import { loadAuthSession } from "@/lib/storage";
import { formatMoney } from "@/lib/format";
import { useNetworkOnline } from "@/lib/use-network-online";

/**
 * 會員充值審核面板（原生 React，取代 iframe）。
 *
 * 設計：不再嵌 topup 嘅 owner.html，改為直連 macau-pos 新增嘅
 * `/api/topup/owner/*` server-side proxy（該 route 簽 Site A owner JWT、Bearer 轉發去
 * topup 嘅 /api/owner/*）。所有資料、操作都喺呢度用 macau-pos 設計語言渲染，
 * 解決 iframe UI 唔一致、auto-trigger 唔自然嘅問題。
 *
 * 功能覆蓋（對齊 topup public/owner.js）：
 *  - dashboard 統計卡
 *  - 待審核 / 歷史 分頁 + 客戶號碼搜尋 + 每頁筆數 + 分頁
 *  - 單筆 明細 / 核准 / 拒絕 / 撤回 + 批次核准（checkbox）
 *  - 明細 dialog（可編輯金額 → 儲存 / 儲存並核准）
 *  - 自動核准設定 dialog（間隔 / 可自動核准狀態 / 單筆上限 / 冷卻秒數）
 *    + 三個 risky 狀態啟用時彈 10 秒風險確認
 *  - 即時模式（live polling）+ 自動核准 server sweep countdown
 *  - 保留「在新分頁開啟」作 fallback（call 原本嘅 /api/topup/owner-embed）
 */

type TopupItem = {
  previewUrl?: string | null;
  selectedAmount?: number | string | null;
  manualAmount?: number | string | null;
  extracted?: {
    amount?: number | string | null;
    merchantName?: string | null;
    transactionOrderNo?: string | null;
    allDetectedOrderNos?: string[] | null;
    paymentMethod?: string | null;
    transactionTime?: string | null;
    orderStatus?: string | null;
  } | null;
  verificationStatus?: string | null;
  verificationBackofficeAmount?: number | string | null;
  verificationMatchedOrderNo?: string | null;
  verificationAmountMatched?: boolean | null;
  validation?: { isShopMismatch?: boolean; isAbnormal?: boolean; missingKeys?: string[] | null } | null;
};

type TopupTransaction = {
  id: string;
  customer_code: string;
  submitted_at: string;
  item_count: number;
  total_amount: number | string;
  status: "pending" | "approved" | "rejected";
  verificationStatus: string | null;
  items?: TopupItem[];
};

type DashboardStats = {
  uploadCount: number;
  customerCount: number;
  totalAmount: string;
  approvedCount: number;
  approvedAmount: string;
  rejectedCount: number;
};

type AutoApproveSettings = {
  allowed_statuses: string[];
  max_amount: number;
  cooldown_seconds: number;
};

type OwnerSettings = {
  auto_approve_enabled: boolean;
  auto_approve_interval_minutes: number;
  auto_approve_settings: AutoApproveSettings;
};

type PanelStatus = "loading" | "ready" | "error";

const RISKY_STATUSES = ["no_match", "no_order_id", "ai_skipped"] as const;
const RISK_CONFIRM_DURATION = 10;
const RISK_CONFIRM_COPY: Record<string, { title: string; body: string }> = {
  no_match: {
    title: "確認啟用『單號不匹配』自動核准",
    body: "客戶可能拿別家商店的真實交易單號，或修改圖片讓單號無法被你核對。勾選啟用後，系統只要看到對應狀態的交易就會自動入帳，不再核對單號是否屬於你的商家。",
  },
  no_order_id: {
    title: "確認啟用『找不到交易單號』自動核准",
    body: "客戶上傳的圖可能根本不是交易截圖（例如空白、截到別的畫面、相片）。勾選啟用後，系統在畫面讀不到單號也會自動入帳，你之後無法靠單號追溯交易。",
  },
  ai_skipped: {
    title: "確認啟用『AI 未辨識』自動核准",
    body: "本次 AI 因額度滿或管線被跳過而沒讀圖。勾選啟用後，即使系統沒讀過內容，只要狀態對得上也會自動入帳，你完全依賴客戶自己聲稱的金額。",
  },
};

function getTopupBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_TOPUP_BASE_URL || "https://top-up-automation.vercel.app").replace(/\/$/, "");
}

function normalizePreviewUrl(url?: string | null): string {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return `${getTopupBaseUrl()}${url.startsWith("/") ? "" : "/"}${url}`;
}

function formatCurrency(value: number | string | null | undefined): string {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return "MOP 0";
  return formatMoney(num);
}

function formatDateTime(value?: string | null): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("zh-Hant");
}

function getVerificationMeta(status: string | null | undefined): {
  label: string;
  shortLabel: string;
  pillClass: string;
  ringClass: string;
} | null {
  switch (status) {
    case "verified_amount_and_id":
      return {
        label: "單號及金額已核實",
        shortLabel: "已核實",
        pillClass: "bg-emerald-50 text-emerald-700 border-emerald-200",
        ringClass: "ring-emerald-200",
      };
    case "verified_id_only":
      return {
        label: "僅單號已核實（需人工核對金額）",
        shortLabel: "僅核實單號",
        pillClass: "bg-amber-50 text-amber-700 border-amber-200",
        ringClass: "ring-amber-200",
      };
    case "no_match":
      return {
        label: "單號不匹配",
        shortLabel: "不匹配",
        pillClass: "bg-rose-50 text-rose-700 border-rose-200",
        ringClass: "ring-rose-200",
      };
    case "no_order_id":
      return {
        label: "找不到交易單號，可能不是交易截圖",
        shortLabel: "無單號",
        pillClass: "bg-rose-50 text-rose-700 border-rose-200",
        ringClass: "ring-rose-200",
      };
    case "ai_skipped":
      return {
        label: "AI 未辨識，需人工核對",
        shortLabel: "AI 未辨識",
        pillClass: "bg-violet-50 text-violet-700 border-violet-200",
        ringClass: "ring-violet-200",
      };
    default:
      return null;
  }
}

async function getTopupAuthContext(): Promise<{
  accessToken: string;
  staffAccount: string;
  refreshToken: string;
}> {
  const session = loadAuthSession();
  const refreshed = await ensureLedgerSession();
  const latest = loadAuthSession();
  const accessToken = refreshed ?? latest?.ledgerAccessToken ?? session?.ledgerAccessToken;
  if (!accessToken) throw new Error("Ledger 登入已過期，請重新登入 POS。");
  return {
    accessToken,
    staffAccount: latest?.account ?? session?.account ?? "",
    refreshToken: latest?.ledgerRefreshToken ?? session?.ledgerRefreshToken ?? "",
  };
}

function buildProxyUrl(path: string, extra?: Record<string, string>): string {
  const [base, existingQuery] = path.split("?");
  const params = new URLSearchParams(existingQuery);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v) params.set(k, v);
    }
  }
  const qs = params.toString();
  return `/api/topup/owner${base}${qs ? `?${qs}` : ""}`;
}

async function topupProxy<T = unknown>(
  path: string,
  options: { method?: "GET" | "POST"; body?: Record<string, unknown> } = {},
): Promise<T> {
  const { accessToken, staffAccount, refreshToken } = await getTopupAuthContext();
  const method = options.method ?? "GET";
  const url =
    method === "GET"
      ? buildProxyUrl(path, { staffAccount, refreshToken })
      : buildProxyUrl(path);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body
      ? JSON.stringify({ ...options.body, staffAccount, refreshToken })
      : undefined,
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error((payload.error as string) || "請求失敗");
  }
  return payload as T;
}

export function MemberTopupPanel() {
  const networkOnline = useNetworkOnline();
  const [status, setStatus] = useState<PanelStatus>("loading");
  const [errorMsg, setErrorMsg] = useState("");

  const [dashboard, setDashboard] = useState<DashboardStats | null>(null);
  const [transactions, setTransactions] = useState<TopupTransaction[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [pageSize, setPageSize] = useState("20");
  const [mode, setMode] = useState<"pending" | "history">("pending");
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pendingCount, setPendingCount] = useState(0);
  const [busy, setBusy] = useState(false);

  const [settings, setSettings] = useState<OwnerSettings | null>(null);

  const [liveMode, setLiveMode] = useState(false);
  const [liveInterval, setLiveInterval] = useState(15);
  const [autoApproveRemaining, setAutoApproveRemaining] = useState(0);

  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [detailTx, setDetailTx] = useState<TopupTransaction | null>(null);
  const [autoApproveOpen, setAutoApproveOpen] = useState(false);
  const [riskConfirm, setRiskConfirm] = useState<{ status: string } | null>(null);
  const [riskAccepted, setRiskAccepted] = useState<Set<string>>(new Set());

  const busyRef = useRef(false);
  const loadDataRef = useRef<(refreshMeta?: boolean) => Promise<void>>(async () => {});
  const remainingRef = useRef(0);

  const loadData = useCallback(async (refreshMeta = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setErrorMsg("");
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize,
        mode: search ? "all" : mode,
      });
      if (search) params.set("customerCode", search);

      const txTask = topupProxy<{
        rows: TopupTransaction[];
        total: number;
        page: number;
        pageCount: number;
      }>(`/transactions?${params.toString()}`);
      const pendingTask = topupProxy<{ total: number }>(`/transactions?countOnly=1&mode=pending`);
      const dashTask = search
        ? Promise.resolve(null)
        : topupProxy<{ stats: DashboardStats }>(`/dashboard`);
      const settingsTask =
        refreshMeta || !settings
          ? topupProxy<{ settings: OwnerSettings }>(`/settings`)
          : Promise.resolve(null);

      const [tx, pending, dash, setRes] = await Promise.all([
        txTask,
        pendingTask,
        dashTask,
        settingsTask,
      ]);

      setTransactions(tx.rows || []);
      setTotal(tx.total || 0);
      setPageCount(tx.pageCount || 1);
      setPendingCount(pending.total || 0);
      if (dash?.stats) setDashboard(dash.stats);
      if (setRes?.settings) setSettings(setRes.settings);
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : "讀取資料失敗");
      setStatus("error");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [page, pageSize, mode, search, settings]);

  loadDataRef.current = loadData;

  const init = useCallback(async () => {
    if (!networkOnline) {
      setErrorMsg("充值審核須連線，請恢復網絡後再試。");
      setStatus("error");
      return;
    }
    try {
      await getTopupAuthContext();
      setStatus("ready");
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : "初始化失敗");
      setStatus("error");
    }
  }, [networkOnline]);

  useEffect(() => {
    void init();
  }, [init]);

  // 當面板 ready 或分頁狀態改變時重載資料。
  useEffect(() => {
    if (status !== "ready") return;
    void loadDataRef.current(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, mode, search, status]);

  // 即時模式：定時重載。
  useEffect(() => {
    if (!liveMode || status !== "ready") return;
    const id = window.setInterval(() => {
      void loadDataRef.current(false);
    }, Math.max(5, liveInterval) * 1000);
    return () => window.clearInterval(id);
  }, [liveMode, liveInterval, status]);

  // 自動核准 countdown + server sweep（對齊 topup owner.js 行為）。
  const runSweep = useCallback(async () => {
    try {
      await topupProxy(`/auto-approve-sweep`, { method: "POST", body: {} });
      await loadDataRef.current(true);
    } catch {
      // 失敗唔阻擋 countdown
    }
  }, []);

  useEffect(() => {
    if (!settings?.auto_approve_enabled) {
      remainingRef.current = 0;
      setAutoApproveRemaining(0);
      return;
    }
    const intervalSec = Math.max(1, Number(settings.auto_approve_interval_minutes) || 300);
    remainingRef.current = intervalSec;
    setAutoApproveRemaining(intervalSec);
    const id = window.setInterval(() => {
      remainingRef.current -= 1;
      if (remainingRef.current <= 0) {
        remainingRef.current = intervalSec;
        void runSweep();
      }
      setAutoApproveRemaining(remainingRef.current);
    }, 1000);
    return () => window.clearInterval(id);
  }, [settings?.auto_approve_enabled, settings?.auto_approve_interval_minutes, runSweep]);

  const switchMode = useCallback((next: "pending" | "history") => {
    setMode(next);
    setPage(1);
    setSelectedIds(new Set());
  }, []);

  const runSearch = useCallback((term: string) => {
    setSearch(term.trim());
    setPage(1);
    setSelectedIds(new Set());
  }, []);

  const toggleSelect = useCallback((id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const approveOne = useCallback(async (id: string) => {
    try {
      await topupProxy(`/approve`, { method: "POST", body: { transactionId: id } });
      await loadDataRef.current(true);
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : "核准失敗");
    }
  }, []);

  const rejectOne = useCallback(async (id: string) => {
    try {
      await topupProxy(`/reject`, { method: "POST", body: { transactionId: id } });
      await loadDataRef.current(true);
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : "拒絕失敗");
    }
  }, []);

  const revokeOne = useCallback(async (id: string) => {
    try {
      await topupProxy(`/revoke`, { method: "POST", body: { transactionId: id } });
      await loadDataRef.current(true);
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : "撤回失敗");
    }
  }, []);

  const batchApprove = useCallback(async () => {
    if (!selectedIds.size) return;
    try {
      await topupProxy(`/batch-approve`, {
        method: "POST",
        body: { transactionIds: [...selectedIds] },
      });
      setSelectedIds(new Set());
      await loadDataRef.current(true);
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : "批次核准失敗");
    }
  }, [selectedIds]);

  const openInNewTab = useCallback(async () => {
    try {
      const { accessToken, staffAccount, refreshToken } = await getTopupAuthContext();
      const res = await fetch("/api/topup/owner-embed", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ staffAccount, refreshToken }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        embedUrl?: string;
        error?: string;
      };
      if (payload.embedUrl) {
        window.open(payload.embedUrl, "_blank", "noopener,noreferrer");
      } else {
        setErrorMsg(payload.error || "無法取得充值審核入口");
      }
    } catch {
      setErrorMsg("開啟新分頁失敗");
    }
  }, []);

  const allPendingSelected =
    transactions.length > 0 &&
    transactions.every((tx) => tx.status !== "pending" || selectedIds.has(tx.id));

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (allPendingSelected) {
        const next = new Set(prev);
        transactions.forEach((tx) => {
          if (tx.status === "pending") next.delete(tx.id);
        });
        return next;
      }
      const next = new Set(prev);
      transactions.forEach((tx) => {
        if (tx.status === "pending") next.add(tx.id);
      });
      return next;
    });
  }, [allPendingSelected, transactions]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-500">會員充值審核</span>
          {pendingCount > 0 ? (
            <span className="inline-flex min-h-[24px] items-center rounded-full bg-rose-500 px-2 text-xs font-semibold text-white">
              {pendingCount} 待審
            </span>
          ) : null}
          {settings?.auto_approve_enabled ? (
            <span className="inline-flex min-h-[24px] items-center rounded-full bg-emerald-50 px-2 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
              自動核准中（剩 {autoApproveRemaining} 秒）
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="min-h-[40px] rounded-2xl bg-white px-4 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
            onClick={() => setAutoApproveOpen(true)}
            type="button"
          >
            設定自動核准
          </button>
          <button
            className={`min-h-[40px] rounded-2xl px-4 text-sm font-semibold ring-1 ${
              liveMode
                ? "bg-slate-900 text-white ring-slate-900"
                : "bg-white text-slate-900 ring-slate-200 hover:bg-slate-50"
            }`}
            onClick={() => setLiveMode((v) => !v)}
            type="button"
          >
            即時模式：{liveMode ? "開" : "關"}
          </button>
          <button
            className="min-h-[40px] rounded-2xl bg-white px-4 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
            onClick={openInNewTab}
            type="button"
          >
            在新分頁開啟
          </button>
          <button
            className="min-h-[40px] rounded-2xl bg-orange-500 px-4 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
            disabled={busy}
            onClick={() => void loadDataRef.current(true)}
            type="button"
          >
            重新整理
          </button>
        </div>
      </div>

      {errorMsg ? (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{errorMsg}</div>
      ) : null}

      {status === "loading" ? (
        <div className="grid flex-1 place-items-center text-sm text-slate-500">
          正在載入充值審核資料…
        </div>
      ) : null}

      {status === "error" ? (
        <div className="grid flex-1 place-items-center">
          <div className="rounded-2xl border border-red-200 bg-white p-6 text-center">
            <div className="text-sm font-semibold text-red-700">{errorMsg}</div>
            <button
              className="mt-4 min-h-[40px] rounded-2xl bg-orange-500 px-4 text-sm font-semibold text-white"
              onClick={() => {
                setStatus("loading");
                setErrorMsg("");
                void init();
              }}
              type="button"
            >
              重試
            </button>
          </div>
        </div>
      ) : null}

      {status === "ready" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="overflow-auto p-3 md:p-4">
            {dashboard ? (
              <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                <StatCard label="上傳筆數" value={String(dashboard.uploadCount)} />
                <StatCard label="上傳客戶數" value={String(dashboard.customerCount)} />
                <StatCard label="充值總額" value={formatCurrency(dashboard.totalAmount)} />
                <StatCard label="已核准總額" value={formatCurrency(dashboard.approvedAmount)} />
                <StatCard label="已拒絕筆數" value={String(dashboard.rejectedCount)} />
              </div>
            ) : null}

            <div className="mt-4 rounded-2xl border border-slate-200 bg-white">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-3">
                <div className="flex flex-wrap gap-2">
                  <button
                    className={`min-h-[40px] rounded-2xl px-4 text-sm font-semibold ${
                      mode === "pending" && !search
                        ? "bg-orange-500 text-white"
                        : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                    }`}
                    onClick={() => {
                      if (search) runSearch("");
                      else switchMode("pending");
                    }}
                    type="button"
                  >
                    待審核
                  </button>
                  <button
                    className={`min-h-[40px] rounded-2xl px-4 text-sm font-semibold ${
                      mode === "history" && !search
                        ? "bg-orange-500 text-white"
                        : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                    }`}
                    onClick={() => switchMode("history")}
                    type="button"
                  >
                    歷史記錄
                  </button>
                  {selectedIds.size > 0 ? (
                    <button
                      className="min-h-[40px] rounded-2xl bg-orange-500 px-4 text-sm font-semibold text-white hover:bg-orange-600"
                      onClick={batchApprove}
                      type="button"
                    >
                      批次核准（{selectedIds.size}）
                    </button>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className="min-h-[40px] w-40 rounded-2xl border border-slate-200 bg-white px-3 text-sm"
                    inputMode="numeric"
                    placeholder="搜尋客戶號碼"
                    value={search}
                    onChange={(e) => runSearch(e.target.value)}
                  />
                  <select
                    className="min-h-[40px] rounded-2xl border border-slate-200 bg-white px-2 text-sm"
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(e.target.value);
                      setPage(1);
                      setSelectedIds(new Set());
                    }}
                  >
                    <option value="20">每頁 20</option>
                    <option value="50">每頁 50</option>
                    <option value="100">每頁 100</option>
                    <option value="all">全部</option>
                  </select>
                </div>
              </div>

              {/* 桌面：表格 */}
              <div className="hidden md:block">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-slate-100 text-xs text-slate-500">
                    <tr>
                      <th className="px-3 py-2">
                        <input
                          className="h-4 w-4"
                          type="checkbox"
                          checked={allPendingSelected}
                          disabled={!transactions.some((t) => t.status === "pending")}
                          onChange={toggleSelectAll}
                        />
                      </th>
                      <th className="px-3 py-2">提交時間</th>
                      <th className="px-3 py-2">會員編號</th>
                      <th className="px-3 py-2">圖片</th>
                      <th className="px-3 py-2">圖片數</th>
                      <th className="px-3 py-2">總額</th>
                      <th className="px-3 py-2">狀態</th>
                      <th className="px-3 py-2">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.length === 0 ? (
                      <tr>
                        <td className="px-3 py-8 text-center text-slate-400" colSpan={8}>
                          目前沒有{search ? "搜尋" : mode === "pending" ? "待審核" : "歷史"}資料。
                        </td>
                      </tr>
                    ) : (
                      transactions.map((tx) => (
                        <TransactionRow
                          key={tx.id}
                          tx={tx}
                          selected={selectedIds.has(tx.id)}
                          onToggleSelect={toggleSelect}
                          onPreview={setPreviewImage}
                          onDetail={setDetailTx}
                          onApprove={approveOne}
                          onReject={rejectOne}
                          onRevoke={revokeOne}
                        />
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* 手機：卡片 */}
              <div className="grid gap-2 p-2 md:hidden">
                {transactions.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-400">
                    目前沒有{search ? "搜尋" : mode === "pending" ? "待審核" : "歷史"}資料。
                  </div>
                ) : (
                  transactions.map((tx) => (
                    <TransactionCard
                      key={tx.id}
                      tx={tx}
                      selected={selectedIds.has(tx.id)}
                      onToggleSelect={toggleSelect}
                      onPreview={setPreviewImage}
                      onDetail={setDetailTx}
                      onApprove={approveOne}
                      onReject={rejectOne}
                      onRevoke={revokeOne}
                    />
                  ))
                )}
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-slate-100 p-3 text-sm text-slate-500">
                <button
                  className="min-h-[40px] rounded-2xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  disabled={page <= 1 || pageSize === "all"}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  type="button"
                >
                  上一頁
                </button>
                <span>
                  {pageSize === "all" ? `共 ${total} 筆` : `第 ${page} / ${pageCount} 頁，共 ${total} 筆`}
                </span>
                <button
                  className="min-h-[40px] rounded-2xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  disabled={page >= pageCount || pageSize === "all"}
                  onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                  type="button"
                >
                  下一頁
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {previewImage ? (
        <Modal onClose={() => setPreviewImage(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt="交易圖片預覽"
            className="max-h-[70vh] w-auto rounded-2xl"
            src={normalizePreviewUrl(previewImage)}
          />
        </Modal>
      ) : null}

      {detailTx ? (
        <DetailDialog
          tx={detailTx}
          onClose={() => setDetailTx(null)}
          onSaved={() => {
            setDetailTx(null);
            void loadDataRef.current(true);
          }}
        />
      ) : null}

      {autoApproveOpen ? (
        <AutoApproveDialog
          settings={settings}
          riskAccepted={riskAccepted}
          onClose={() => setAutoApproveOpen(false)}
          onNeedRiskConfirm={(statusKey) => setRiskConfirm({ status: statusKey })}
          onSaved={(s) => {
            setSettings(s);
            setAutoApproveOpen(false);
          }}
        />
      ) : null}

      {riskConfirm ? (
        <RiskConfirmDialog
          status={riskConfirm.status}
          onAccept={() => {
            setRiskAccepted((prev) => new Set(prev).add(riskConfirm.status));
            setRiskConfirm(null);
          }}
          onCancel={() => setRiskConfirm(null)}
        />
      ) : null}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-slate-50 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-base font-semibold text-slate-900">{value}</div>
    </div>
  );
}

function StatusPills({ tx }: { tx: TopupTransaction }) {
  const verification = getVerificationMeta(tx.verificationStatus);
  const statusLabel =
    tx.status === "approved" ? "已核准" : tx.status === "rejected" ? "已拒絕" : "待審核";
  const statusClass =
    tx.status === "approved"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : tx.status === "rejected"
        ? "bg-slate-100 text-slate-600 border-slate-200"
        : "bg-orange-50 text-orange-700 border-orange-200";
  const hasAbnormal = (tx.items || []).some((i) => i.validation?.isAbnormal);
  return (
    <div className="flex flex-wrap gap-1">
      <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${statusClass}`}>
        {statusLabel}
      </span>
      {verification ? (
        <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${verification.pillClass}`}>
          {verification.shortLabel}
        </span>
      ) : null}
      {hasAbnormal ? (
        <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-600">異常</span>
      ) : null}
    </div>
  );
}

function TransactionRow({
  tx,
  selected,
  onToggleSelect,
  onPreview,
  onDetail,
  onApprove,
  onReject,
  onRevoke,
}: {
  tx: TopupTransaction;
  selected: boolean;
  onToggleSelect: (id: string, checked: boolean) => void;
  onPreview: (url: string) => void;
  onDetail: (tx: TopupTransaction) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onRevoke: (id: string) => void;
}) {
  return (
    <tr className="border-b border-slate-100">
      <td className="px-3 py-2 align-top">
        {tx.status === "pending" ? (
          <input
            className="h-4 w-4"
            type="checkbox"
            checked={selected}
            onChange={(e) => onToggleSelect(tx.id, e.target.checked)}
          />
        ) : null}
      </td>
      <td className="px-3 py-2 align-top text-slate-600">{formatDateTime(tx.submitted_at)}</td>
      <td className="px-3 py-2 align-top font-medium text-slate-900">{tx.customer_code}</td>
      <td className="px-3 py-2 align-top">
        <div className="flex flex-wrap gap-1">
          {(tx.items || []).map((item, idx) => {
            const meta = getVerificationMeta(item.verificationStatus);
            return (
              <button
                key={idx}
                className={`h-12 w-12 overflow-hidden rounded-xl border bg-slate-100 ${meta?.ringClass || ""}`}
                onClick={() => item.previewUrl && onPreview(item.previewUrl)}
                type="button"
              >
                {item.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    alt={`明細 ${idx + 1}`}
                    className="h-full w-full object-cover"
                    src={normalizePreviewUrl(item.previewUrl)}
                  />
                ) : (
                  <span className="grid h-full w-full place-items-center text-[10px] text-slate-400">無圖</span>
                )}
              </button>
            );
          })}
        </div>
      </td>
      <td className="px-3 py-2 align-top text-slate-600">{tx.item_count}</td>
      <td className="px-3 py-2 align-top font-semibold text-slate-900">{formatCurrency(tx.total_amount)}</td>
      <td className="px-3 py-2 align-top">
        <StatusPills tx={tx} />
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex flex-wrap gap-1">
          <button
            className="min-h-[36px] rounded-xl bg-white px-3 text-xs font-semibold text-slate-900 ring-1 ring-slate-200 hover:bg-slate-50"
            onClick={() => onDetail(tx)}
            type="button"
          >
            明細
          </button>
          {tx.status === "pending" ? (
            <>
              <button
                className="min-h-[36px] rounded-xl bg-orange-500 px-3 text-xs font-semibold text-white hover:bg-orange-600"
                onClick={() => onApprove(tx.id)}
                type="button"
              >
                核准
              </button>
              <button
                className="min-h-[36px] rounded-xl bg-white px-3 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
                onClick={() => onReject(tx.id)}
                type="button"
              >
                拒絕
              </button>
            </>
          ) : null}
          {tx.status === "rejected" ? (
            <button
              className="min-h-[36px] rounded-xl bg-white px-3 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
              onClick={() => onRevoke(tx.id)}
              type="button"
            >
              撤回
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function TransactionCard({
  tx,
  selected,
  onToggleSelect,
  onPreview,
  onDetail,
  onApprove,
  onReject,
  onRevoke,
}: {
  tx: TopupTransaction;
  selected: boolean;
  onToggleSelect: (id: string, checked: boolean) => void;
  onPreview: (url: string) => void;
  onDetail: (tx: TopupTransaction) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onRevoke: (id: string) => void;
}) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-slate-500">提交時間</div>
          <div className="text-sm text-slate-900">{formatDateTime(tx.submitted_at)}</div>
        </div>
        <StatusPills tx={tx} />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
        <div className="rounded-xl bg-slate-50 p-2">
          <div className="text-[11px] text-slate-500">會員編號</div>
          <div className="font-semibold text-slate-900">{tx.customer_code}</div>
        </div>
        <div className="rounded-xl bg-slate-50 p-2">
          <div className="text-[11px] text-slate-500">圖片數</div>
          <div className="font-semibold text-slate-900">{tx.item_count}</div>
        </div>
        <div className="rounded-xl bg-slate-50 p-2">
          <div className="text-[11px] text-slate-500">總額</div>
          <div className="font-semibold text-slate-900">{formatCurrency(tx.total_amount)}</div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {(tx.items || []).map((item, idx) => {
          const meta = getVerificationMeta(item.verificationStatus);
          return (
            <button
              key={idx}
              className={`h-14 w-14 overflow-hidden rounded-xl border bg-slate-100 ${meta?.ringClass || ""}`}
              onClick={() => item.previewUrl && onPreview(item.previewUrl)}
              type="button"
            >
              {item.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  alt={`明細 ${idx + 1}`}
                  className="h-full w-full object-cover"
                  src={normalizePreviewUrl(item.previewUrl)}
                />
              ) : (
                <span className="grid h-full w-full place-items-center text-[10px] text-slate-400">無圖</span>
              )}
            </button>
          );
        })}
      </div>
      {tx.status === "pending" ? (
        <label className="mt-2 flex items-center gap-2 text-sm text-slate-600">
          <input
            className="h-4 w-4"
            type="checkbox"
            checked={selected}
            onChange={(e) => onToggleSelect(tx.id, e.target.checked)}
          />
          批次選取
        </label>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          className="min-h-[40px] flex-1 rounded-xl bg-white px-3 text-sm font-semibold text-slate-900 ring-1 ring-slate-200 hover:bg-slate-50"
          onClick={() => onDetail(tx)}
          type="button"
        >
          明細
        </button>
        {tx.status === "pending" ? (
          <>
            <button
              className="min-h-[40px] flex-1 rounded-xl bg-orange-500 px-3 text-sm font-semibold text-white hover:bg-orange-600"
              onClick={() => onApprove(tx.id)}
              type="button"
            >
              核准
            </button>
            <button
              className="min-h-[40px] flex-1 rounded-xl bg-white px-3 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
              onClick={() => onReject(tx.id)}
              type="button"
            >
              拒絕
            </button>
          </>
        ) : null}
        {tx.status === "rejected" ? (
          <button
            className="min-h-[40px] flex-1 rounded-xl bg-white px-3 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
            onClick={() => onRevoke(tx.id)}
            type="button"
          >
            撤回
          </button>
        ) : null}
      </div>
    </article>
  );
}

function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div className="relative" onClick={(e) => e.stopPropagation()}>
        <button
          className="absolute -right-2 -top-2 z-10 grid h-9 w-9 place-items-center rounded-full bg-white text-slate-700 shadow ring-1 ring-slate-200"
          onClick={onClose}
          type="button"
        >
          ✕
        </button>
        {children}
      </div>
    </div>
  );
}

function DetailDialog({
  tx,
  onClose,
  onSaved,
}: {
  tx: TopupTransaction;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [itemAmounts, setItemAmounts] = useState<string[]>(
    (tx.items || []).map((i) => String(Number(i.extracted?.amount || 0).toFixed(2))),
  );
  const [totalInput, setTotalInput] = useState<string>(String(Number(tx.total_amount || 0).toFixed(2)));
  const [manualTotal, setManualTotal] = useState(false);
  const [saving, setSaving] = useState(false);

  const hasMissingAmount = (tx.items || []).some(
    (i) => !Number(i.extracted?.amount || 0) || Number(i.extracted?.amount || 0) <= 0,
  );

  const recomputeTotal = (amounts: string[]) => {
    if (manualTotal) return;
    const sum = amounts.reduce((acc, v) => acc + (Number(v) || 0), 0);
    setTotalInput(sum.toFixed(2));
  };

  const save = async (approveAfter: boolean) => {
    setSaving(true);
    try {
      await topupProxy(`/update-transaction`, {
        method: "POST",
        body: {
          transactionId: tx.id,
          totalAmount: totalInput,
          itemAmounts,
        },
      });
      if (approveAfter) {
        await topupProxy(`/approve`, { method: "POST", body: { transactionId: tx.id } });
      }
      onSaved();
    } catch (error) {
      setSaving(false);
      alert(error instanceof Error ? error.message : "儲存失敗");
    }
  };

  return (
    <Modal onClose={onClose}>
      <div className="max-h-[80vh] w-[92vw] max-w-md overflow-auto rounded-2xl bg-white p-4">
        <div className="flex items-center justify-between">
          <div className="text-base font-semibold text-slate-900">交易明細</div>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
            {tx.customer_code}
          </span>
        </div>
        {(() => {
          const meta = getVerificationMeta(tx.verificationStatus);
          return meta ? (
            <div className={`mt-2 rounded-xl border px-3 py-2 text-xs font-semibold ${meta.pillClass}`}>
              {meta.label}
            </div>
          ) : null;
        })()}
        {hasMissingAmount ? (
          <div className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
            此交易內容沒有金額，請先填寫「可編輯金額」後才能核准。
          </div>
        ) : null}

        <div className="mt-3">
          <div className="flex items-end justify-between gap-2">
            <div className="flex-1">
              <div className="text-xs text-slate-500">總金額</div>
              <input
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                inputMode="decimal"
                value={totalInput}
                onChange={(e) => {
                  setTotalInput(e.target.value);
                  setManualTotal(true);
                }}
              />
            </div>
          </div>
        </div>

        <div className="mt-3 grid gap-2">
          {(tx.items || []).map((item, idx) => {
            const meta = getVerificationMeta(item.verificationStatus);
            return (
              <section key={idx} className="rounded-xl border border-slate-200 p-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-slate-900">交易明細 {idx + 1}</div>
                  <span className="text-sm text-slate-600">
                    {formatCurrency(item.selectedAmount || item.manualAmount || item.extracted?.amount)}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-500">
                  <span>
                    客戶提交金額：
                    {formatCurrency(item.selectedAmount || item.manualAmount || item.extracted?.amount)}
                  </span>
                  <span>
                    mPay 黃金金額：
                    {item.verificationBackofficeAmount ? formatCurrency(item.verificationBackofficeAmount) : "-"}
                  </span>
                  <span>商戶：{item.extracted?.merchantName || "-"}</span>
                  <span>訂單號：{item.extracted?.transactionOrderNo || "-"}</span>
                  <span>
                    候選單號：
                    {Array.isArray(item.extracted?.allDetectedOrderNos) && item.extracted.allDetectedOrderNos.length
                      ? item.extracted.allDetectedOrderNos.join(" / ")
                      : "-"}
                  </span>
                  <span>核對結果：{meta?.label || "-"}</span>
                  <span>匹配單號：{item.verificationMatchedOrderNo || "-"}</span>
                  <span>
                    金額是否一致：
                    {item.verificationAmountMatched == null
                      ? "-"
                      : item.verificationAmountMatched
                        ? "是"
                        : "否（已按 mPay 後台自動校正）"}
                  </span>
                  <span>支付方式：{item.extracted?.paymentMethod || "-"}</span>
                  <span>時間：{item.extracted?.transactionTime || "-"}</span>
                  {item.validation?.isShopMismatch ? (
                    <span className="col-span-2 text-rose-600">商戶名稱與店舖名稱不完全一致，請人工確認</span>
                  ) : null}
                  {item.validation?.isAbnormal ? (
                    <span className="col-span-2 text-rose-600">
                      異常：缺少 {item.validation.missingKeys?.join("、") || "關鍵資料"}
                    </span>
                  ) : null}
                </div>
                <div className="mt-2">
                  <div className="text-xs text-slate-500">可編輯金額</div>
                  <input
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    inputMode="decimal"
                    value={itemAmounts[idx] ?? "0.00"}
                    onChange={(e) => {
                      const next = [...itemAmounts];
                      next[idx] = e.target.value;
                      setItemAmounts(next);
                      recomputeTotal(next);
                    }}
                  />
                </div>
              </section>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className="min-h-[44px] flex-1 rounded-2xl bg-white px-4 text-sm font-semibold text-slate-900 ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-50"
            disabled={saving}
            onClick={() => save(false)}
            type="button"
          >
            儲存修改
          </button>
          {tx.status === "pending" ? (
            <button
              className="min-h-[44px] flex-1 rounded-2xl bg-orange-500 px-4 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
              disabled={saving || hasMissingAmount}
              onClick={() => save(true)}
              type="button"
            >
              儲存並核准
            </button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

function AutoApproveDialog({
  settings,
  riskAccepted,
  onClose,
  onNeedRiskConfirm,
  onSaved,
}: {
  settings: OwnerSettings | null;
  riskAccepted: Set<string>;
  onClose: () => void;
  onNeedRiskConfirm: (status: string) => void;
  onSaved: (settings: OwnerSettings) => void;
}) {
  const enabled = settings?.auto_approve_enabled ?? false;
  const interval = settings?.auto_approve_interval_minutes ?? 300;
  const allowed = new Set(settings?.auto_approve_settings?.allowed_statuses || []);
  const maxAmount = settings?.auto_approve_settings?.max_amount ?? 5000;
  const cooldown = settings?.auto_approve_settings?.cooldown_seconds ?? 30;

  const [localEnabled, setLocalEnabled] = useState(enabled);
  const [localInterval, setLocalInterval] = useState(String(interval));
  const [localAllowed, setLocalAllowed] = useState<Set<string>>(new Set(allowed));
  const [localMax, setLocalMax] = useState(String(maxAmount));
  const [localCooldown, setLocalCooldown] = useState(String(cooldown));
  const [saving, setSaving] = useState(false);

  const STATUS_OPTIONS: { key: string; label: string; risky: boolean }[] = [
    { key: "verified_amount_and_id", label: "綠色：單號及金額已核實", risky: false },
    { key: "verified_id_only", label: "黃色：僅單號已核實", risky: false },
    { key: "no_match", label: "⚠️ 紅色：單號不匹配（須二次確認）", risky: true },
    { key: "no_order_id", label: "⚠️ 紅色：找不到交易單號（須二次確認）", risky: true },
    { key: "ai_skipped", label: "⚠️ 紫色：AI 未辨識（須二次確認）", risky: true },
  ];

  const toggleStatus = (key: string, risky: boolean, checked: boolean) => {
    if (checked && risky && !riskAccepted.has(key)) {
      onNeedRiskConfirm(key);
      return; // 等風險確認接受後再 tick（由父層傳入 riskAccepted 觸發重渲染）
    }
    setLocalAllowed((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  // 當父層 riskAccepted 包含某 risky status，且本地仲未勾選 → 幫佢勾上。
  useEffect(() => {
    STATUS_OPTIONS.forEach((opt) => {
      if (opt.risky && riskAccepted.has(opt.key) && !localAllowed.has(opt.key)) {
        setLocalAllowed((prev) => new Set(prev).add(opt.key));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [riskAccepted]);

  const save = async (enable: boolean) => {
    setSaving(true);
    try {
      const payload = await topupProxy<{ settings: OwnerSettings }>(`/settings`, {
        method: "POST",
        body: {
          autoApproveEnabled: enable,
          autoApproveIntervalSeconds: Math.max(1, Number(localInterval) || 300),
          autoApproveSettings: {
            allowed_statuses: [...localAllowed],
            max_amount: Math.max(0, Number(localMax) || 0),
            cooldown_seconds: Math.max(0, Number(localCooldown) || 0),
          },
        },
      });
      onSaved(payload.settings);
    } catch (error) {
      setSaving(false);
      alert(error instanceof Error ? error.message : "更新自動核准失敗");
    }
  };

  return (
    <Modal onClose={onClose}>
      <div className="max-h-[80vh] w-[92vw] max-w-md overflow-auto rounded-2xl bg-white p-4">
        <div className="flex items-center justify-between">
          <div className="text-base font-semibold text-slate-900">自動核准設定</div>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
              enabled ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" : "bg-slate-100 text-slate-600"
            }`}
          >
            {enabled ? "已啟用" : "未啟用"}
          </span>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          開啟後，系統會按你設定的秒數，自動核准已等待足夠時間的待審核交易。請先確認你了解自動核准風險。
        </p>

        <div className="mt-3">
          <div className="text-xs text-slate-500">間隔（秒）</div>
          <input
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
            inputMode="numeric"
            min="1"
            value={localInterval}
            onChange={(e) => setLocalInterval(e.target.value)}
          />
        </div>

        <div className="mt-3">
          <div className="text-xs text-slate-500">可自動核准狀態</div>
          <div className="mt-1 grid gap-1">
            {STATUS_OPTIONS.map((opt) => (
              <label
                key={opt.key}
                className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                  opt.risky ? "border-rose-200 bg-rose-50/40" : "border-slate-200"
                }`}
              >
                <input
                  className="h-4 w-4"
                  type="checkbox"
                  checked={localAllowed.has(opt.key)}
                  onChange={(e) => toggleStatus(opt.key, opt.risky, e.target.checked)}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            可同時勾選多個狀態；被 ⚠️ 標示的選項啟用時會彈出風險確認。
          </p>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <div>
            <div className="text-xs text-slate-500">單筆金額上限（0 = 不限）</div>
            <input
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
              inputMode="numeric"
              min="0"
              value={localMax}
              onChange={(e) => setLocalMax(e.target.value)}
            />
          </div>
          <div>
            <div className="text-xs text-slate-500">商家冷卻秒數（0 = 不冷卻）</div>
            <input
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
              inputMode="numeric"
              min="0"
              value={localCooldown}
              onChange={(e) => setLocalCooldown(e.target.value)}
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className="min-h-[44px] flex-1 rounded-2xl bg-white px-4 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-50"
            disabled={saving || !enabled}
            onClick={() => save(false)}
            type="button"
          >
            停止自動核准
          </button>
          <button
            className="min-h-[44px] flex-1 rounded-2xl bg-orange-500 px-4 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
            disabled={saving}
            onClick={() => save(true)}
            type="button"
          >
            {localEnabled ? "確認設定" : "確認啟動"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RiskConfirmDialog({
  status,
  onAccept,
  onCancel,
}: {
  status: string;
  onAccept: () => void;
  onCancel: () => void;
}) {
  const copy = RISK_CONFIRM_COPY[status];
  const [remaining, setRemaining] = useState(RISK_CONFIRM_DURATION);

  useEffect(() => {
    setRemaining(RISK_CONFIRM_DURATION);
    const id = window.setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          window.clearInterval(id);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [status]);

  return (
    <Modal onClose={onCancel}>
      <div className="w-[92vw] max-w-sm rounded-2xl bg-white p-4">
        <div className="text-base font-semibold text-slate-900">{copy?.title ?? "確認風險"}</div>
        <p className="mt-2 text-sm text-slate-600">{copy?.body ?? ""}</p>
        <div className="mt-3 flex items-center gap-2 text-sm text-slate-500">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-rose-100 text-base font-semibold text-rose-700">
            {remaining}
          </span>
          <span>秒後才能確認</span>
        </div>
        <div className="mt-4 flex gap-2">
          <button
            className="min-h-[44px] flex-1 rounded-2xl bg-white px-4 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
            onClick={onCancel}
            type="button"
          >
            取消
          </button>
          <button
            className="min-h-[44px] flex-1 rounded-2xl bg-orange-500 px-4 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
            disabled={remaining > 0}
            onClick={onAccept}
            type="button"
          >
            我了解並接受風險
          </button>
        </div>
      </div>
    </Modal>
  );
}
