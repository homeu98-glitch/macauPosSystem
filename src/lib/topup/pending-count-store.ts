"use client";

import { ensureLedgerSession } from "@/lib/ledger/session";
import { loadAuthSession } from "@/lib/storage";
import { readNetworkOnline } from "@/lib/use-network-online";

type PendingSnapshot = {
  pendingCount: number;
  loading: boolean;
  configured: boolean;
};

const DEFAULT_SNAPSHOT: PendingSnapshot = {
  pendingCount: 0,
  loading: false,
  configured: true,
};

let snapshot: PendingSnapshot = { ...DEFAULT_SNAPSHOT };
const listeners = new Set<() => void>();
let pollTimer: number | null = null;
let pollInFlight = false;
let fastPollers = 0;
let slowPollers = 0;
/** 上一次真正發請求嘅時間（用嚟做回到前景嘅去抖，見 `ensureVisibilityListener`）。 */
let lastRefreshAt = 0;
/**
 * 回到前景補拉用嘅**單一** listener（module-level singleton）。
 *
 * 🔴 為咩唔喺 `startTopupPendingPolling` 內逐個訂閱者加：每個訂閱者加一個 listener
 * 就會變成「一次 focus → N 個並發 fetch」。呢個正是 2026-09-21 喺 Supabase log
 * 觀察到嘅反面教材 —— `pos_online_order_settings` 每次爆 4.5 個同秒請求，
 * 就係多個 hook 各自掛 `visibilitychange` 造成（每次 4~5 個 GET）。
 * 呢度只掛**一次**，並用 refCount 決定要唔要拉。
 */
let visibilityListener: (() => void) | null = null;

/** 回到前景去抖：太密嘅 focus（例如快速切 tab）唔會重複打。 */
const VISIBILITY_REFRESH_MIN_GAP_MS = 30_000;

function ensureVisibilityListener() {
  if (visibilityListener || typeof document === "undefined") return;
  visibilityListener = () => {
    if (document.visibilityState !== "visible") return;
    if (slowPollers + fastPollers === 0) return; // 冇人訂閱 → 唔打
    if (Date.now() - lastRefreshAt < VISIBILITY_REFRESH_MIN_GAP_MS) return;
    void refreshTopupPendingCount();
  };
  document.addEventListener("visibilitychange", visibilityListener);
}

function emit() {
  listeners.forEach((listener) => listener());
}

/**
 * 輪詢間隔（2026-09-21 調整）。
 *
 * ⚠️ 為咩要放慢：呢個計數器係掛喺 **側欄一個紅點**（`app-sidebar.tsx` → 收銀台
 * `pos-app.tsx` 無條件渲染），即係**開機期間一直跑**。而每次 `refreshTopupPendingCount()`
 * 會打 `/api/topup/pending-count`，該 route 內部做：
 *   ① Ledger `auth.getUser()`　② `merchant_staff` select　③ `merchants` select
 *   ④ `fetchTopupShopId()`　⑤ **對外部充值站一次 HTTP fetch**（route.ts:80）
 * ⇒ 為一個紅點，原本每 30 秒做 5~6 個上游往返。
 * 實測（Vercel Usage 2026-09-21）：131,010 invocations／21 日，單單呢一項佔約 23%。
 *
 * ⇒ slow：30 秒 → **5 分鐘**（300 秒）；fast：12 秒 → **60 秒**。
 *   紅點最多遲 5 分鐘出現，但**回到前景（visibilitychange）會即時補拉一次**
 *   （見 `startTopupPendingPolling` 內嘅 listener），所以實際感受唔到延遲。
 *   要還原舊行為：改返 `fastPollers > 0 ? 12_000 : 30_000`。
 */
function getPollIntervalMs() {
  return fastPollers > 0 ? 60_000 : 300_000;
}

function schedulePoll() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  if (slowPollers + fastPollers === 0) return;
  pollTimer = window.setInterval(() => {
    void refreshTopupPendingCount();
  }, getPollIntervalMs());
}

function setSnapshot(next: Partial<PendingSnapshot>) {
  snapshot = { ...snapshot, ...next };
  emit();
}

export function getTopupPendingSnapshot(): PendingSnapshot {
  return snapshot;
}

export function subscribeTopupPending(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function refreshTopupPendingCount() {
  if (pollInFlight) return;
  if (!readNetworkOnline()) return;

  const session = loadAuthSession();
  if (!session?.ledgerAccessToken) {
    setSnapshot({ pendingCount: 0, loading: false, configured: false });
    return;
  }

  pollInFlight = true;
  lastRefreshAt = Date.now();
  setSnapshot({ loading: true });

  try {
    const accessToken = (await ensureLedgerSession()) ?? session.ledgerAccessToken;
    const latestSession = loadAuthSession();
    const response = await fetch("/api/topup/pending-count", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        staffAccount: latestSession?.account ?? session.account,
        refreshToken: latestSession?.ledgerRefreshToken ?? session.ledgerRefreshToken,
      }),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      pendingCount?: number;
      error?: string;
    };

    if (response.status === 503 && payload.error?.includes("未設定")) {
      setSnapshot({ pendingCount: 0, loading: false, configured: false });
      return;
    }

    if (!response.ok || !payload.ok) {
      setSnapshot({ loading: false, configured: true });
      return;
    }

    setSnapshot({
      pendingCount: Math.max(0, Number(payload.pendingCount) || 0),
      loading: false,
      configured: true,
    });
  } catch {
    setSnapshot({ loading: false });
  } finally {
    pollInFlight = false;
  }
}

export function startTopupPendingPolling(mode: "slow" | "fast") {
  if (mode === "fast") {
    fastPollers += 1;
  } else {
    slowPollers += 1;
  }

  // 回到前景即時補拉（單一 listener；見 `ensureVisibilityListener` 註釋）。
  // 因為輪詢已放慢到 5 分鐘，呢個 listener 係「即時性」嘅來源。
  ensureVisibilityListener();

  schedulePoll();
  void refreshTopupPendingCount();

  return () => {
    if (mode === "fast") {
      fastPollers = Math.max(0, fastPollers - 1);
    } else {
      slowPollers = Math.max(0, slowPollers - 1);
    }

    if (slowPollers + fastPollers === 0 && pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
      return;
    }

    schedulePoll();
  };
}
