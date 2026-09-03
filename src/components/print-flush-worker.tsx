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
 *   2) mount 嗰次呼叫 `tryAutoPairCompanion()` —— 內部已經按兩種環境分流：
 *      · Companion 環境（PC Desktop App / Android APK / `?companion=<url>` 分頁）
 *        → 走 URL 參數 / 已儲存地址 / 預設 loopback 任一條路徑
 *      · 純 Website 環境（瀏覽器開網站 / PWA standalone）
 *        → 全部 branch skip，**完全唔掟** `http://127.0.0.1:9311/api/health`，
 *          唔會每 2.5 秒洗 console + network tab
 *
 * **本檔唔做 health check polling** —— 嗰個喺 `subscribeCompanionAvailability()`
 * 統一處理（Companion 環境先探、純 Website 完全唔探），本 worker 唔重複。
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
