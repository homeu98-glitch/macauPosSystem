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

function emit() {
  listeners.forEach((listener) => listener());
}

function getPollIntervalMs() {
  return fastPollers > 0 ? 12_000 : 30_000;
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
