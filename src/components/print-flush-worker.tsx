"use client";

import { useEffect } from "react";

import { flushPendingPrintJobs } from "@/lib/print-bridge/dispatch";

const FLUSH_INTERVAL_MS = 2500;

/**
 * 背景打印 worker。
 *
 * 定時把 pending PrintJob 派發到打印機：native bridge（Android APK）優先，
 * 否則桌面 Companion（localhost），最後經 Cloud Print Relay 備援。
 * 唔使再同步 config 到 HTTP bridge。
 * 無論有無配置 Companion 都會 poll：native-only 模式（Android APK）下，收據照樣要靠呢個 worker flush。
 */
export function PrintFlushWorker() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    let cancelled = false;

    async function tick() {
      if (cancelled) return;
      await flushPendingPrintJobs();
    }

    void tick();

    const timer = window.setInterval(() => {
      void tick();
    }, FLUSH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
