"use client";

import { useEffect } from "react";

import { flushPendingPrintJobs } from "@/lib/print-bridge/dispatch";
<<<<<<< HEAD
import { tryAutoPairCompanion } from "@/lib/print-bridge/companion";
=======
>>>>>>> 3e35bda0ada861ee6fd26497e72a3f326554dfe8

const FLUSH_INTERVAL_MS = 2500;

/**
<<<<<<< HEAD
 * 背景打印 worker（取代舊 HubPrintWorker）。
 *
 * 定時：
 *   1) 嘗試自動配對 / 重連桌面 Companion 代理（loopback http://127.0.0.1:9311）；
 *   2) 刷新 pending PrintJob 派發到打印機：native bridge（Android APK）優先，
 *      否則 fallback 桌面 Companion 代理（LAN :9100 / USB / 藍牙）。
 *
 * 經 root layout 全域掛載，餐飲同 salon 共用，唔使各自再配對。
=======
 * 背景打印 worker。
 *
 * 定時把 pending PrintJob 派發到打印機：native bridge（Android APK）優先，
 * 否則桌面 Companion（localhost），最後經 Cloud Print Relay 備援。
 * 唔使再同步 config 到 HTTP bridge。
 * 無論有無配置 Companion 都會 poll：native-only 模式（Android APK）下，收據照樣要靠呢個 worker flush。
>>>>>>> 3e35bda0ada861ee6fd26497e72a3f326554dfe8
 */
export function PrintFlushWorker() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    let cancelled = false;

    async function tick() {
      if (cancelled) return;
<<<<<<< HEAD
      try {
        await tryAutoPairCompanion();
      } catch {
        // 配對失敗唔阻礙 flush
      }
=======
>>>>>>> 3e35bda0ada861ee6fd26497e72a3f326554dfe8
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
