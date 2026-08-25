// Phase 2 桌面 Companion 嘅網頁側 transport（見 docs/47）。
//
// 當 POS 網頁喺桌面瀏覽器（Windows/macOS/Linux）開啟、又無 native bridge（Android APK）
// 嗰陣，瀏覽器沙盒冇法直接打 LAN:9100 / USB / BT。呢個 transport 經 localhost HTTP
// 將 job 交去桌面 Companion 代理（desktop-companion/server.mjs），由佢用 OS 權限出單。
//
// 等於「桌面版嘅 PosNative」：Android 係 in-WebView bridge，桌面係 localhost HTTP。
// 協議 / payload 同 native.ts 一致（見 docs/47 §2）。

import type {
  DevicePrinterConfig,
  PrintJob,
  PrintSendOptions,
  PrintSendResult,
  PrintTransport,
} from "@/lib/types";

export interface CompanionTransportConfig {
  /** Companion 代理地址（綁 127.0.0.1，例如 http://127.0.0.1:9311） */
  baseUrl: string;
  /** 可選：配對 token（Companion 驗證用，見 docs/47 §2） */
  token?: string;
}

export class CompanionTransport implements PrintTransport {
  private cfg: CompanionTransportConfig;
  constructor(cfg: CompanionTransportConfig) {
    this.cfg = cfg;
  }

  supports(_printer: DevicePrinterConfig): boolean {
    return true;
  }

  async send(job: PrintJob, printer: DevicePrinterConfig, opts: PrintSendOptions): Promise<PrintSendResult> {
    // A2（docs/56）：Companion URL 若係黑洞地址，冇 timeout 嘅 fetch 會長期唔返 →
    // dispatch.ts 嘅 isFlushing 鎖永遠 true → 整個 flush worker 癱瘓、所有 job 永久卡 pending。
    // 加 5s AbortController，超時當失敗，唔會拖垮後續 flush。
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${this.cfg.baseUrl}/api/print`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.cfg.token ? { "x-companion-token": this.cfg.token } : {}),
        },
        body: JSON.stringify({
          job,
          printer,
          kind: opts.kind,
          storeName: opts.storeName ?? "",
          paymentMethod: opts.paymentMethod ?? "",
          total: opts.total ?? null,
        }),
        signal: controller.signal,
      });
      const data = (await res.json()) as { ok?: boolean; queued?: boolean; error?: string };
      if (data && (data.ok === true || data.queued === true)) {
        return { ok: true, queued: data.queued, ticketId: job.id };
      }
      return { ok: false, ticketId: job.id, error: data?.error || `companion HTTP ${res.status}` };
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      return {
        ok: false,
        ticketId: job.id,
        error: aborted ? "companion 逾時（5s 無回應），請檢查桌面代理是否開啟" : e instanceof Error ? e.message : "companion fetch failed",
      };
    } finally {
      window.clearTimeout(timeout);
    }
  }
}
