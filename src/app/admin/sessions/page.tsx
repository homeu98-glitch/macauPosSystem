"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AdminShell } from "@/components/admin-shell";
import { loadAuthSession } from "@/lib/storage";
import { formatMacauStamp, readClientBuildInfo } from "@/lib/build-info";
import {
  canClearPosSession,
  classifyPosSession,
  describeAgo,
  describeOpenDuration,
  describePosSessionState,
  groupPosSessions,
  isSessionBehind,
  summarizePosSessions,
  type PosSessionRow,
  type PosSessionState,
} from "@/lib/pos/session-record";

/**
 * Admin panel · POS 工作階段（2026-09-22，migration 0047）。
 *
 * ## 為何要有呢一頁
 *
 * 2026-09-21 egress 事故嘅真兇係「**商家唔為意開咗幾個分頁，舊分頁靜靜燒流量**」
 * —— 單一舊分頁（Mac Safari、開咗一整日冇 reload）26 分鐘拉 123 MB，
 * 佔該窗口 egress **97%**。事後只能靠 Vercel log 反推邊部機跑住舊 bundle。
 *
 * 呢一頁將件事變成**一眼睇得到、一撳關得掉**：
 *   · 邊間店開咗幾個工作階段（多開 = 最需要留意）；
 *   · 每個工作階段跑住邊個版本（同線上最新對照 ⇒ 落後就標出嚟）；
 *   · 強制關閉（**軟踢**：POS 端下次請求先見到，唔會令正在結帳嘅客人卡死）。
 *
 * ## 資料來源
 *
 * `GET /api/admin/sessions`（admin session token，12h）。
 * 分組／KPI／門檻**一律用 `@/lib/pos/session-record`**（同 server 端同一份純邏輯，
 * 唔喺呢度另寫一套 —— 呢個專案已經中過「同一判斷寫兩次然後漂移」）。
 *
 * ## 🔴 自動刷新唔可以橫衝直撞
 *
 * 呢個頁面係喺**同一部電腦**開，而本專案對請求量極敏感（egress 計費）。
 * ⇒ 30 秒一次、**分頁隱藏即停**、離開頁面 clearInterval。
 * ⇒ 亦因為咁，呢頁**唔會**顯示即時秒級狀態（門檻本身就係分鐘級）。
 */

type AdminSessionRow = PosSessionRow;

type SessionsPayload = {
  ok?: boolean;
  error?: string;
  serverBuildId?: string;
  nowIso?: string;
  stores?: Array<{ id: string; name: string }>;
  sessions?: AdminSessionRow[];
};

const STATUS_FILTERS = [
  { id: "all", label: "全部狀態" },
  { id: "live", label: "使用中" },
  { id: "idle", label: "閒置" },
  { id: "off", label: "已離線" },
  { id: "rev", label: "已強制關閉" },
] as const;

/** 狀態色點（同真產品嘅 slate 系一致）。 */
function dotClass(state: PosSessionState): string {
  if (state === "live") return "bg-green-500 ring-4 ring-green-100";
  if (state === "idle") return "bg-amber-500 ring-4 ring-amber-100";
  if (state === "off") return "bg-slate-300 ring-4 ring-slate-100";
  return "bg-red-600 ring-4 ring-red-100";
}

function stateTextClass(state: PosSessionState): string {
  if (state === "live") return "text-green-700";
  if (state === "idle") return "text-amber-700";
  if (state === "off") return "text-slate-500";
  return "text-red-700";
}

/**
 * 角色代碼 → 中文（UI 一律唔露出枚舉值，同專案其他頁一致）。
 * 認唔到嘅值原樣回（唔可以當成收銀，否則會誤導）。
 */
function roleLabel(role: string | null): string {
  if (!role) return "";
  if (role === "admin") return "管理員";
  if (role === "manager") return "店長";
  if (role === "cashier") return "收銀";
  return role;
}

/** 版本 chip：同線上最新一致 → 綠；唔一致 → 琥珀；未知 → 灰。 */
function VersionCell({
  row,
  serverBuildId,
}: {
  row: AdminSessionRow;
  serverBuildId: string | null;
}) {
  const known = Boolean(row.build_id);
  const behind = isSessionBehind(row, serverBuildId);
  const sha = row.build_id ?? "未知";
  if (!known) {
    return (
      <div className="min-w-0">
        <span className="font-mono text-xs font-semibold text-slate-500">{sha}</span>
        <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">
          未知
        </span>
        <p className="mt-0.5 text-[11px] text-slate-400">此分頁未回報版本</p>
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <span className={`font-mono text-xs font-semibold ${behind ? "text-amber-700" : "text-green-700"}`}>
        {sha}
      </span>
      <span
        className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
          behind ? "bg-amber-100 text-amber-700" : "bg-green-100 text-green-700"
        }`}
      >
        {behind ? "落後" : "最新"}
      </span>
      <p className="mt-0.5 truncate text-[11px] text-slate-400">
        {behind ? "舊 JS：每次多拉約 1 倍資料" : "與線上一致"}
      </p>
    </div>
  );
}

export default function AdminSessionsPage() {
  const [rows, setRows] = useState<AdminSessionRow[]>([]);
  const [serverBuildId, setServerBuildId] = useState<string | null>(null);
  const [storeNames, setStoreNames] = useState<Map<string, string>>(new Map());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const [filterStore, setFilterStore] = useState("all");
  const [filterStatus, setFilterStatus] = useState<(typeof STATUS_FILTERS)[number]["id"]>("all");
  const [onlyBehind, setOnlyBehind] = useState(false);
  const [search, setSearch] = useState("");
  const [flatView, setFlatView] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  /** 詳情抽屜目前開喺邊個 session（null = 關咗）。 */
  const [detailId, setDetailId] = useState<string | null>(null);
  /** 確認框：要強制關閉邊幾個 id（空陣列 = 關咗）。 */
  const [confirmIds, setConfirmIds] = useState<string[]>([]);
  const [confirmReason, setConfirmReason] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    if (busyRef.current) return;
    const token = loadAuthSession()?.adminSessionToken;
    if (!token) {
      setError("未授權，請先登入。");
      setLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/admin/sessions", { headers: { Authorization: `Bearer ${token}` } });
      const json = (await res.json()) as SessionsPayload;
      if (!res.ok || !json.ok) {
        setError(json.error ?? `載入失敗（HTTP ${res.status}）`);
        return;
      }
      setError(null);
      setRows(json.sessions ?? []);
      setServerBuildId(json.serverBuildId ?? null);
      setStoreNames(new Map((json.stores ?? []).map((s) => [s.id, s.name])));
      setNowMs(json.nowIso ? Date.parse(json.nowIso) : Date.now());
      setUpdatedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 自動刷新：30 秒，**分頁隱藏即停**。
   *
   * 為何要停：呢頁係喺電腦後台長開嘅，如果冇人睇都照拉，
   * 就係本專案一直要消滅嘅「冇人睇嘅輪詢」。
   */
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      setNowMs(Date.now());
      void load();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (filterStore !== "all" && row.store_id !== filterStore) return false;
      if (filterStatus !== "all" && classifyPosSession(row, nowMs) !== filterStatus) return false;
      if (onlyBehind && !isSessionBehind(row, serverBuildId)) return false;
      if (q) {
        const hay = `${row.store_id} ${storeNames.get(row.store_id) ?? ""} ${row.account ?? ""} ${row.ip ?? ""} ${row.build_id ?? ""}`;
        if (!hay.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [rows, filterStore, filterStatus, onlyBehind, search, nowMs, serverBuildId, storeNames]);

  // ⚠️ KPI 用**全量** `rows`（唔用 `filtered`）：呢頁係監控頁，
  //    上面嘅數字應該係「全平台實況」，唔應該被下面嘅篩選影響。
  const summary = useMemo(
    () => summarizePosSessions(rows, nowMs, serverBuildId),
    [rows, nowMs, serverBuildId],
  );
  const groups = useMemo(
    () => groupPosSessions(filtered, nowMs, serverBuildId),
    [filtered, nowMs, serverBuildId],
  );
  const flatRows = useMemo(
    () => [...filtered].sort((a, b) => Date.parse(b.opened_at) - Date.parse(a.opened_at)),
    [filtered],
  );
  const detailRow = useMemo(() => rows.find((r) => r.id === detailId) ?? null, [rows, detailId]);

  /** 管理操作紀錄：由已撤銷嘅 row 反推（0047 冇另開 audit 表，避免多一張表要維護）。 */
  const auditRows = useMemo(
    () =>
      rows
        .filter((r) => Boolean(r.revoked_at))
        .sort((a, b) => Date.parse(b.revoked_at ?? "") - Date.parse(a.revoked_at ?? ""))
        .slice(0, 20),
    [rows],
  );

  /** 一店仲有幾多個「唔係最新版本」嘅重複分頁（＝可以一鍵清理嘅候選）。 */
  function redundantIds(group: ReturnType<typeof groupPosSessions>[number]): string[] {
    const live = group.sessions.filter((s) => classifyPosSession(s, nowMs) !== "rev");
    if (live.length <= 1) return [];
    // 保留「最近有上報」嗰一個（＝最可能係收銀員正在用嗰個），其餘列為多餘。
    const keep = live.reduce((best, cur) =>
      Date.parse(cur.last_seen_at) > Date.parse(best.last_seen_at) ? cur : best,
    );
    return live.filter((s) => s.id !== keep.id).map((s) => s.id);
  }

  async function submitAction(action: "revoke" | "clear", ids: string[], reason?: string) {
    if (ids.length === 0 || busyRef.current) return;
    const token = loadAuthSession()?.adminSessionToken;
    if (!token) {
      setError("未授權，請先登入。");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/sessions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, ids, reason: reason ?? null }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; results?: Array<{ ok: boolean; error?: string }> };
      if (!res.ok || !json.ok) {
        const firstError = json.results?.find((r) => !r.ok)?.error;
        setError(firstError ?? json.error ?? `操作失敗（HTTP ${res.status}）`);
      }
      setConfirmIds([]);
      setConfirmReason("");
      setDetailId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const storeLabel = (storeId: string) => storeNames.get(storeId) ?? storeId;
  const clientBuildId = readClientBuildInfo().id;

  return (
    <AdminShell>
      <div className="space-y-6">
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {/* KPI：固定 5 格（沿既有 KPI 帶規則，唔另開第 6 張卡） */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {[
            {
              label: "開啟中工作階段",
              value: String(summary.total),
              sub: `${summary.stores} 間店家`,
              tone: "",
            },
            {
              label: "多開店家",
              value: String(summary.multiOpenStores),
              sub: groups
                .filter((g) => g.multiOpen)
                .slice(0, 2)
                .map((g) => `${storeLabel(g.storeId)} ${g.sessions.length} 個`)
                .join(" · ") || "冇",
              tone: summary.multiOpenStores > 0 ? "border-amber-200 bg-amber-50" : "",
              subTone: summary.multiOpenStores > 0 ? "text-amber-700" : "",
            },
            {
              label: "版本落後",
              value: String(summary.behind),
              sub: serverBuildId ? `線上最新 ${serverBuildId}` : "未取得線上版本",
              tone: summary.behind > 0 ? "border-amber-200 bg-amber-50" : "",
              subTone: summary.behind > 0 ? "text-amber-700" : "",
            },
            {
              label: "最舊未關",
              value: summary.oldestOpenedAt ? describeOpenDuration(summary.oldestOpenedAt, nowMs) : "—",
              sub: summary.oldestOpenedAt ? formatMacauStamp(summary.oldestOpenedAt) : "—",
              tone: "",
            },
            {
              label: "已下達待生效",
              value: String(summary.revokedPending),
              sub: summary.openOver24h > 0 ? `另有 ${summary.openOver24h} 個超 24 小時未關` : "冇超 24 小時",
              tone: "",
            },
          ].map((kpi) => (
            <div key={kpi.label} className={`rounded-xl border border-slate-200 bg-white px-4 py-3 ${kpi.tone}`}>
              <p className="text-xs text-slate-500">{kpi.label}</p>
              <p className="mt-1 text-lg font-semibold text-slate-900 tabular-nums">{kpi.value}</p>
              <p className={`mt-1 text-[11px] ${kpi.subTone ?? "text-slate-400"}`}>{kpi.sub}</p>
            </div>
          ))}
        </div>

        {/* 篩選列 */}
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-slate-500">
              店家
              <select
                value={filterStore}
                onChange={(e) => setFilterStore(e.target.value)}
                className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
              >
                <option value="all">全部店家</option>
                {[...new Set(rows.map((r) => r.store_id))].map((id) => (
                  <option key={id} value={id}>
                    {storeLabel(id)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-xs text-slate-500">
              狀態
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value as typeof filterStatus)}
                className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
              >
                {STATUS_FILTERS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => setOnlyBehind((v) => !v)}
              className={`inline-flex min-h-[36px] items-center gap-2 rounded-full border px-3 text-xs ${
                onlyBehind
                  ? "border-amber-300 bg-amber-50 font-semibold text-amber-800"
                  : "border-slate-300 bg-white text-slate-600"
              }`}
            >
              <span
                className={`relative inline-block h-3.5 w-6 shrink-0 rounded-full transition-colors ${
                  onlyBehind ? "bg-amber-500" : "bg-slate-300"
                }`}
              >
                <span
                  className={`absolute top-[1px] h-3 w-3 rounded-full bg-white transition-all ${
                    onlyBehind ? "left-[11px]" : "left-[1px]"
                  }`}
                />
              </span>
              只看版本落後
            </button>
            <button
              type="button"
              onClick={() => setFlatView((v) => !v)}
              className="min-h-[36px] rounded-lg border border-slate-300 px-3 text-xs text-slate-600 hover:bg-slate-50"
            >
              {flatView ? "按店家分組" : "平鋪清單"}
            </button>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜尋店家 / 員工帳號 / IP / 版本…"
              className="w-56 rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900 outline-none focus:border-blue-500"
            />
            <span className="ml-auto text-[11px] text-slate-400">
              {updatedAt ? `上次更新 ${formatMacauStamp(updatedAt)}` : "—"}
              　·　
              <button
                type="button"
                onClick={() => setAutoRefresh((v) => !v)}
                className="underline decoration-dotted underline-offset-2"
              >
                {autoRefresh ? "30 秒自動更新：開" : "30 秒自動更新：關"}
              </button>
            </span>
            <button
              type="button"
              onClick={() => void load()}
              className="min-h-[36px] rounded-lg bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-800"
            >
              重新載入
            </button>
          </div>
          {/*
            ⚠️ `dev` 係「未注入建置識別碼」（本機開發）——**唔可以**當成「版本唔一致」，
            否則每次本機開呢頁都會出假警告（同 `describeBuildMismatch()` 一樣嘅保守決定）。
          */}
          {clientBuildId && serverBuildId && clientBuildId !== "dev" && serverBuildId !== "dev" && clientBuildId !== serverBuildId ? (
            <p className="mt-2 text-[11px] text-amber-700">
              注意：你而家用緊嘅後台分頁版本（{clientBuildId}）同線上最新（{serverBuildId}）唔一致 ——
              呢頁顯示嘅版本對照以線上最新為準。
            </p>
          ) : null}
        </div>

        {/* 主體 */}
        {loading ? (
          <p className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">載入中…</p>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-green-200 bg-white px-6 py-8 text-center">
            <p className="text-sm font-semibold text-slate-900">沒有需要處理的工作階段</p>
            <p className="mt-1 text-xs text-slate-500">
              {rows.length === 0
                ? "目前沒有登記中的 POS 工作階段（或者 migration 0047 未執行）。"
                : "以目前篩選條件，冇符合嘅工作階段。"}
            </p>
          </div>
        ) : flatView ? (
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="grid grid-cols-[150px_14px_minmax(0,1fr)_150px_150px_130px_120px_96px] items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-[11px] font-medium text-slate-500">
              <span>店家</span>
              <span />
              <span>員工 / 裝置</span>
              <span>版本</span>
              <span>開啟時間</span>
              <span>狀態 · 最後上報</span>
              <span>IP</span>
              <span className="text-right">操作</span>
            </div>
            {flatRows.map((row) => (
              <SessionRow
                key={row.id}
                row={row}
                nowMs={nowMs}
                serverBuildId={serverBuildId}
                storeLabel={storeLabel(row.store_id)}
                showStore
                onOpen={() => setDetailId(row.id)}
                onRevoke={() => setConfirmIds([row.id])}
                onClear={() => void submitAction("clear", [row.id])}
              />
            ))}
          </section>
        ) : (
          <div className="space-y-3">
            {/* 欄位圖例（同列同一組欄寬；唔寫兩套，否則會歪） */}
            <div className="grid grid-cols-[14px_minmax(0,1fr)_150px_150px_130px_120px_96px] items-center gap-3 px-4 text-[11px] text-slate-400">
              <span />
              <span>員工 / 裝置</span>
              <span>版本</span>
              <span>開啟時間</span>
              <span>狀態 · 最後上報</span>
              <span>IP</span>
              <span className="text-right">操作</span>
            </div>
            {groups.map((group) => {
              const redundant = redundantIds(group);
              return (
                <section key={group.storeId} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                  <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
                    <span className="text-sm font-bold text-slate-900">{storeLabel(group.storeId)}</span>
                    <span className="font-mono text-[11px] text-slate-400">{group.storeId}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        group.multiOpen ? "border border-amber-200 bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {group.sessions.length} 個工作階段
                    </span>
                    {group.multiOpen ? (
                      <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700">
                        ⚠ 多開
                      </span>
                    ) : null}
                    {group.behind > 0 ? (
                      <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                        {group.behind} 個版本落後
                      </span>
                    ) : null}
                    <span className="ml-auto flex items-center gap-2">
                      {redundant.length > 0 ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setConfirmIds(redundant)}
                          className="min-h-[32px] rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                          關閉多餘（保留最近上報嗰個）
                        </button>
                      ) : null}
                      {group.sessions.some((s) => classifyPosSession(s, nowMs) !== "rev") ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            setConfirmIds(
                              group.sessions
                                .filter((s) => classifyPosSession(s, nowMs) !== "rev")
                                .map((s) => s.id),
                            )
                          }
                          className="min-h-[32px] rounded-lg border border-red-200 px-3 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                        >
                          全部強制關閉
                        </button>
                      ) : null}
                    </span>
                  </div>
                  {group.sessions.map((row) => (
                    <SessionRow
                      key={row.id}
                      row={row}
                      nowMs={nowMs}
                      serverBuildId={serverBuildId}
                      storeLabel={storeLabel(row.store_id)}
                      onOpen={() => setDetailId(row.id)}
                      onRevoke={() => setConfirmIds([row.id])}
                      onClear={() => void submitAction("clear", [row.id])}
                    />
                  ))}
                </section>
              );
            })}
          </div>
        )}

        {/* 管理操作紀錄（由已撤銷嘅 row 反推；唔另開 audit 表） */}
        {auditRows.length > 0 ? (
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
              <h2 className="mr-auto text-sm font-semibold text-slate-900">管理操作紀錄</h2>
              <span className="text-[11px] text-slate-400">只保留最近 30 日 · 唔可以刪除</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[11px] text-slate-500">
                    <th className="px-4 py-2 font-medium">時間</th>
                    <th className="px-4 py-2 font-medium">店家</th>
                    <th className="px-4 py-2 font-medium">員工</th>
                    <th className="px-4 py-2 font-medium">動作</th>
                    <th className="px-4 py-2 font-medium">操作者</th>
                    <th className="px-4 py-2 font-medium">原因</th>
                  </tr>
                </thead>
                <tbody>
                  {auditRows.map((row) => (
                    <tr key={row.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-4 py-2 tabular-nums text-slate-600">{formatMacauStamp(row.revoked_at)}</td>
                      <td className="px-4 py-2 text-slate-900">{storeLabel(row.store_id)}</td>
                      <td className="px-4 py-2 text-slate-600">{row.account ?? "—"}</td>
                      <td className="px-4 py-2">
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700">
                          強制關閉
                        </span>
                      </td>
                      <td className="px-4 py-2 text-slate-600">{row.revoked_by ?? "—"}</td>
                      <td className="px-4 py-2 text-xs text-slate-500">{row.revoke_reason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <p className="text-xs text-slate-400">
          狀態口徑：最後上報 ≤ 6 分鐘＝使用中（輪詢閘最多 5 分鐘唔出聲，門檻一定要夠鬆）；
          6~30 分鐘＝閒置；&gt; 30 分鐘＝已離線。「強制關閉」係軟踢：該分頁下次連線才生效，
          只擋新單／加菜，結帳與退款照樣放行。
        </p>
      </div>

      {detailRow ? (
        <SessionDetailDrawer
          row={detailRow}
          nowMs={nowMs}
          serverBuildId={serverBuildId}
          storeName={storeLabel(detailRow.store_id)}
          busy={busy}
          onClose={() => setDetailId(null)}
          onRevoke={() => setConfirmIds([detailRow.id])}
        />
      ) : null}

      {confirmIds.length > 0 ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4">
          <div className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="border-b border-slate-100 px-5 py-4">
              <h2 className="text-base font-bold text-slate-900">
                {confirmIds.length > 1 ? `強制關閉這 ${confirmIds.length} 個 POS 工作階段？` : "強制關閉這個 POS 工作階段？"}
              </h2>
              <p className="mt-1 text-xs text-slate-500">此操作會即時生效，並記錄在你的管理員帳號下。</p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="space-y-1.5">
                {rows
                  .filter((r) => confirmIds.includes(r.id))
                  .map((r) => (
                    <div key={r.id} className="rounded-lg border border-slate-200 px-3 py-2 text-xs">
                      <span className="font-semibold text-slate-900">{storeLabel(r.store_id)}</span>
                      <span className="ml-2 text-slate-500">
                        {r.account ?? "—"} · {describePosSessionState(classifyPosSession(r, nowMs))} · 版本{" "}
                        <span className="font-mono">{r.build_id ?? "未知"}</span>
                      </span>
                      <div className="mt-0.5 text-[11px] text-slate-400">
                        開啟 {formatMacauStamp(r.opened_at)}（已開 {describeOpenDuration(r.opened_at, nowMs)}）·
                        最後上報 {describeAgo(r.last_seen_at, nowMs)}
                      </div>
                    </div>
                  ))}
              </div>

              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-xs leading-relaxed text-amber-900">
                <p className="font-bold">會發生（該分頁）：</p>
                <ul className="mt-1 list-disc pl-4">
                  <li>下次連線時停止接收新訂單，亦唔會再輪詢拉資料</li>
                  <li>畫面出現「此工作階段已被管理員關閉」橫幅，需要重新登入</li>
                  <li>
                    <b>唔會自動重新載入</b>：若正在結帳，該筆結帳會照常放行，收銀員可先完成
                  </li>
                </ul>
              </div>
              <div className="mt-3 rounded-xl border border-green-200 bg-green-50 px-3.5 py-3 text-xs leading-relaxed text-green-800">
                <p className="font-bold">唔會發生（安心位）：</p>
                <ul className="mt-1 list-disc pl-4">
                  <li>唔會刪除任何訂單／未上雲嘅紀錄</li>
                  <li>本機未落單嘅購物車會保留，重新登入後仍在</li>
                  <li>唔會影響同店其他工作階段、打印中繼機或客人掃碼落單</li>
                </ul>
              </div>

              <label className="mt-4 block">
                <span className="mb-1 block text-xs text-slate-500">原因（選填，只作記錄）</span>
                <input
                  type="text"
                  value={confirmReason}
                  onChange={(e) => setConfirmReason(e.target.value)}
                  placeholder="例：疑似開啟了多個分頁，清理舊分頁"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500"
                />
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
              <button
                type="button"
                onClick={() => {
                  setConfirmIds([]);
                  setConfirmReason("");
                }}
                className="min-h-[40px] rounded-lg border border-slate-300 bg-white px-4 text-sm text-slate-700 hover:bg-slate-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void submitAction("revoke", confirmIds, confirmReason)}
                className="min-h-[40px] rounded-lg bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {busy ? "處理中…" : "強制關閉"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </AdminShell>
  );
}

/* ──────────────────────────────────────────────────────────────────────────── */

function SessionRow({
  row,
  nowMs,
  serverBuildId,
  storeLabel,
  showStore,
  onOpen,
  onRevoke,
  onClear,
}: {
  row: AdminSessionRow;
  nowMs: number;
  serverBuildId: string | null;
  storeLabel: string;
  showStore?: boolean;
  onOpen: () => void;
  onRevoke: () => void;
  onClear: () => void;
}) {
  const state = classifyPosSession(row, nowMs);
  const canClear = canClearPosSession(row, nowMs);
  // ⚠️ 分組同平鋪兩個視圖嘅欄寬必須一致（唔一致就會「歪」而工具捉唔到）。
  const gridClass = showStore
    ? "grid grid-cols-[150px_14px_minmax(0,1fr)_150px_150px_130px_120px_96px] items-center gap-3 px-4 py-2.5"
    : "grid grid-cols-[14px_minmax(0,1fr)_150px_150px_130px_120px_96px] items-center gap-3 px-4 py-2.5";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      title="點擊查看詳情"
      className={`${gridClass} cursor-pointer border-b border-slate-100 transition-colors last:border-0 hover:bg-blue-50/60 focus:bg-blue-50/60 focus:outline-none`}
    >
      {showStore ? (
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-slate-900">{storeLabel}</p>
          <p className="truncate font-mono text-[11px] text-slate-400">{row.store_id}</p>
        </div>
      ) : null}
      <span className={`justify-self-center rounded-full ${dotClass(state)}`} style={{ width: 9, height: 9 }} />
      <div className="min-w-0">
        <p className="truncate text-[13px] font-semibold text-slate-900">
          {row.account ?? "—"}
          {row.role ? (
            <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
              {roleLabel(row.role)}
            </span>
          ) : null}
        </p>
        <p className="truncate text-[11px] text-slate-400">{row.user_agent ?? "未知裝置"}</p>
      </div>
      <VersionCell row={row} serverBuildId={serverBuildId} />
      <div className="min-w-0">
        <p className="font-mono text-xs text-slate-800">{formatMacauStamp(row.opened_at)}</p>
        <p className="text-[11px] text-slate-400">已開 {describeOpenDuration(row.opened_at, nowMs)}</p>
      </div>
      <div className="min-w-0">
        <p className={`text-xs font-semibold ${stateTextClass(state)}`}>{describePosSessionState(state)}</p>
        <p className="text-[11px] text-slate-400">
          {state === "rev" ? formatMacauStamp(row.revoked_at) : `最後上報 ${describeAgo(row.last_seen_at, nowMs)}`}
        </p>
      </div>
      <p className="truncate font-mono text-[11px] text-slate-500">{row.ip ?? "—"}</p>
      <div className="text-right">
        {state === "rev" ? (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">已下達</span>
        ) : canClear ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            className="min-h-[32px] rounded-lg border border-slate-200 px-3 text-xs text-slate-500 hover:bg-slate-50"
          >
            清除
          </button>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRevoke();
            }}
            className="min-h-[32px] rounded-lg border border-red-200 px-3 text-xs font-medium text-red-600 hover:bg-red-50"
          >
            強制關閉
          </button>
        )}
      </div>
    </div>
  );
}

function SessionDetailDrawer({
  row,
  nowMs,
  serverBuildId,
  storeName,
  busy,
  onClose,
  onRevoke,
}: {
  row: AdminSessionRow;
  nowMs: number;
  serverBuildId: string | null;
  storeName: string;
  busy: boolean;
  onClose: () => void;
  onRevoke: () => void;
}) {
  const state = classifyPosSession(row, nowMs);
  const behind = isSessionBehind(row, serverBuildId);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/30">
      <button type="button" aria-label="關閉" className="flex-1 cursor-default" onClick={onClose} />
      <div className="flex h-full w-full max-w-md flex-col bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3.5">
          <div>
            <p className="text-sm font-bold text-slate-900">
              {storeName}　{row.account ?? "—"}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {describePosSessionState(state)} · {row.user_agent ?? "未知裝置"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[36px] rounded-lg border border-slate-200 px-3 text-xs text-slate-500 hover:bg-slate-50"
          >
            ✕ 關閉
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
          <section>
            <h3 className="mb-2 text-[11px] font-bold tracking-wide text-slate-500">狀態</h3>
            <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-y-1.5 text-xs">
              <dt className="text-slate-500">目前</dt>
              <dd className={`font-semibold ${stateTextClass(state)}`}>{describePosSessionState(state)}</dd>
              <dt className="text-slate-500">最後上報</dt>
              <dd className="text-slate-900">
                {describeAgo(row.last_seen_at, nowMs)}（{formatMacauStamp(row.last_seen_at)}）
              </dd>
              <dt className="text-slate-500">判定門檻</dt>
              <dd className="text-slate-600">≤ 6 分鐘＝使用中；6~30 分鐘＝閒置；&gt; 30 分鐘＝已離線</dd>
            </dl>
          </section>
          <section>
            <h3 className="mb-2 text-[11px] font-bold tracking-wide text-slate-500">版本</h3>
            <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-y-1.5 text-xs">
              <dt className="text-slate-500">此分頁運行</dt>
              <dd className="font-mono text-slate-900">
                {row.build_id ?? "未知"}{" "}
                {behind ? (
                  <span className="ml-1 rounded-full bg-amber-100 px-1.5 py-0.5 font-sans text-[10px] font-bold text-amber-700">
                    落後
                  </span>
                ) : null}
              </dd>
              <dt className="text-slate-500">線上最新</dt>
              <dd className="font-mono text-slate-900">{serverBuildId ?? "未知"}</dd>
              <dt className="text-slate-500">影響</dt>
              <dd className="text-slate-600">
                {behind
                  ? "此分頁仍用舊 JS，每次全量拉取多約 1 倍資料；建議請店家登出並重新登入。"
                  : "與線上一致。"}
              </dd>
            </dl>
          </section>
          <section>
            <h3 className="mb-2 text-[11px] font-bold tracking-wide text-slate-500">店家與員工</h3>
            <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-y-1.5 text-xs">
              <dt className="text-slate-500">店家</dt>
              <dd className="text-slate-900">
                {storeName}　<span className="font-mono text-slate-400">{row.store_id}</span>
              </dd>
              <dt className="text-slate-500">員工</dt>
              <dd className="text-slate-900">
                {row.account ?? "—"}
                {row.role ? `（${roleLabel(row.role)}）` : ""}
              </dd>
            </dl>
          </section>
          <section>
            <h3 className="mb-2 text-[11px] font-bold tracking-wide text-slate-500">裝置與網絡</h3>
            <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-y-1.5 text-xs">
              <dt className="text-slate-500">瀏覽器</dt>
              <dd className="break-all text-slate-900">{row.user_agent ?? "—"}</dd>
              <dt className="text-slate-500">來源 IP</dt>
              <dd className="font-mono text-slate-900">{row.ip ?? "—"}</dd>
              <dt className="text-slate-500">識別碼</dt>
              <dd className="break-all font-mono text-[11px] text-slate-500">{row.session_key}</dd>
            </dl>
          </section>
          <section>
            <h3 className="mb-2 text-[11px] font-bold tracking-wide text-slate-500">時間軸</h3>
            <div className="border-l-2 border-slate-200 pl-4">
              <div className="relative pb-3">
                <span
                  className={`absolute -left-[21px] top-1 rounded-full ${dotClass(state)}`}
                  style={{ width: 9, height: 9 }}
                />
                <p className="text-xs font-semibold text-slate-900">最後上報</p>
                <p className="text-[11px] text-slate-400">
                  {formatMacauStamp(row.last_seen_at)}　{describeAgo(row.last_seen_at, nowMs)}
                </p>
              </div>
              {row.revoked_at ? (
                <div className="relative pb-3">
                  <span className="absolute -left-[21px] top-1 rounded-full bg-red-600" style={{ width: 9, height: 9 }} />
                  <p className="text-xs font-semibold text-slate-900">管理員下達強制關閉</p>
                  <p className="text-[11px] text-slate-400">
                    {formatMacauStamp(row.revoked_at)}　{row.revoked_by ?? ""}
                    {row.revoke_reason ? `　${row.revoke_reason}` : ""}
                  </p>
                </div>
              ) : null}
              <div className="relative">
                <span className="absolute -left-[21px] top-1 rounded-full bg-slate-300" style={{ width: 9, height: 9 }} />
                <p className="text-xs font-semibold text-slate-900">工作階段開啟</p>
                <p className="text-[11px] text-slate-400">
                  {formatMacauStamp(row.opened_at)}　（註冊於 /api/ledger/login）
                </p>
              </div>
            </div>
          </section>
        </div>
        <div className="flex gap-2 border-t border-slate-100 bg-slate-50 px-4 py-3">
          {classifyPosSession(row, nowMs) === "rev" ? (
            <span className="flex-1 rounded-lg border border-slate-200 py-2.5 text-center text-xs text-slate-500">
              已下達強制關閉，等該分頁下次連線確認
            </span>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={onRevoke}
              className="min-h-[40px] flex-1 rounded-lg border border-red-200 text-center text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              強制關閉
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
