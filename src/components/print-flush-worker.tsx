"use client";

import { useEffect } from "react";

import { flushPendingPrintJobs } from "@/lib/print-bridge/dispatch";
import { tryAutoPairCompanion } from "@/lib/print-bridge/companion";

const FLUSH_INTERVAL_MS = 2500;

/**
 * 背景打印 worker（取代舊 HubPrintWorker）。
 *
 * 定時：
 *   1) 刷新 pending PrintJob 派發到打印機：native bridge（Android APK）優先，
 *      否則 fallback 桌面 Companion 代理（LAN :9100 / USB / 藍牙）。
 *
 * 自動配對 Companion 只喺 mount 嗰陣做一次（見下面），**唔再擺落 2.5 秒嘅 flush 迴圈** ——
 * 否則冇裝 Companion 嘅網站會每 2.5 秒打一次 http://127.0.0.1:9311/api/health 然後
 * ERR_CONNECTION_REFUSED，永久洗 console + network tab。而 `tryAutoPairCompanion()`
 * 亦已加閘：純 website 上從來冇配對過就直接 skip（見 companion.ts 註解）。
 *
 * 經 root layout 全域掛載，餐飲同 salon 共用，唔使各自再配對。
 */
export function PrintFlushWorker() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    let cancelled = false;

    // 自動配對 Companion：mount 時試一次就夠（內部已有閘，純 website 無配對過會直接 skip）。
    // 之後要靠佢嘅話，設定頁有「測試連線」掣同 ?companion= 參數。
    void Promise.resolve()
      .then(() => tryAutoPairCompanion())
      .catch(() => {
        // 配對失敗唔阻礙 flush
      });

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
