// 雲端中繼 transport（docs/96 新設計：Supabase Realtime + claim RPC）。
//
// 與舊 docs/46 WSS 骨架唔同：呢度唔開 socket。Web 側「發單」= 確保張單已寫落雲端
// pos_print_jobs（由中繼 APK 經 Realtime 訂閱 + claim RPC 拎走打印）。
//
// 張單嘅 PRINT_JOB_CREATED 事件喺建單嗰陣已經入咗 sync queue（pos-app.tsx 等 9 處），
// send() 做一次 flush 確保即時上雲，然後回 ok（已交咗畀雲端中繼）。
// 真正出紙結果由 APK 經 /api/pos/print-agent/result 回報，雲端 pos_print_jobs.status 係權威。

import type {
  DevicePrinterConfig,
  PrintJob,
  PrintSendOptions,
  PrintSendResult,
  PrintTransport,
} from "@/lib/types";
import { flushPosSyncQueue } from "@/lib/pos/sync-flush";

export class RelayTransport implements PrintTransport {
  /** relay 可以處理任何 printer（最終由店內 APK 用對應通道出紙）。 */
  supports(_printer: DevicePrinterConfig): boolean {
    return true;
  }

  async send(_job: PrintJob, _printer: DevicePrinterConfig, _opts: PrintSendOptions): Promise<PrintSendResult> {
    // 確保張單嘅 PRINT_JOB_CREATED 已推上雲（寫入 pos_print_jobs），中繼 APK 隨後 claim。
    // 離線時 sync queue 會自己 retry，呢度樂觀回 ok（已交咗畀雲端中繼機制）。
    try {
      await flushPosSyncQueue({ silent: true });
    } catch {
      /* 靜默：sync queue 自行 retry */
    }
    return { ok: true };
  }
}
