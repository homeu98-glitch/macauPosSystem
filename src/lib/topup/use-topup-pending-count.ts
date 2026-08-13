"use client";

import { useEffect, useSyncExternalStore } from "react";

import {
  getTopupPendingSnapshot,
  refreshTopupPendingCount,
  startTopupPendingPolling,
  subscribeTopupPending,
} from "@/lib/topup/pending-count-store";
import { useNetworkOnlineListener } from "@/lib/use-network-online";

export function useTopupPendingCount(options?: { fast?: boolean }) {
  const state = useSyncExternalStore(subscribeTopupPending, getTopupPendingSnapshot, getTopupPendingSnapshot);

  useEffect(() => {
    return startTopupPendingPolling(options?.fast ? "fast" : "slow");
  }, [options?.fast]);

  useNetworkOnlineListener((online) => {
    if (online) void refreshTopupPendingCount();
  });

  return {
    pendingCount: state.pendingCount,
    hasPending: state.configured && state.pendingCount > 0,
    loading: state.loading,
    configured: state.configured,
    refresh: refreshTopupPendingCount,
  };
}
