// Phase 5 終端側 relay transport 骨架（來自 docs/46 §6 / docs/43 path B）。
//
// 實作 Phase 0 嘅 PrintTransport 接口。當 Terminal Local Agent 偵測到 off store-LAN
// （LAN anchor 唔在，見 docs/43 / docs/46 §1）時，用呢個 transport 經 Cloud Print Relay
// 出單：WSS submit → relay 中轉去店內 Stationary Agent → 回 result。
//
// ⚠️ 骨架：暫未接入 dispatch.ts（留 P5.3）；auth/token/重連/anchor 切換要 P5.1–P5.5 補。
// 協議訊息幀見 docs/46 §3。

import type {
  DevicePrinterConfig,
  PrintJob,
  PrintSendOptions,
  PrintSendResult,
  PrintTransport,
} from "@/lib/types";

export interface RelayTransportConfig {
  /** wss:// 中繼地址（見 docs/46 §2 部署選型） */
  relayUrl: string;
  /** store-scoped token（由 Supabase Auth 派生，見 docs/46 §4） */
  token: string;
  storeId: string;
  /** 等待 submit_ack / result 嘅超時（ms，預設 60s = job ttl） */
  timeoutMs?: number;
}

interface PendingJob {
  resolve: (r: PrintSendResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RelayTransport implements PrintTransport {
  private cfg: RelayTransportConfig;
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingJob>();

  constructor(cfg: RelayTransportConfig) {
    this.cfg = cfg;
  }

  /** relay 可以處理任何 connectionType（最終由店內 Stationary Agent 用對應 transport 出單）。 */
  supports(_printer: DevicePrinterConfig): boolean {
    return true;
  }

  private ensureSocket(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    return new Promise((resolve, reject) => {
      const url =
        `${this.cfg.relayUrl}?role=terminal&storeId=${encodeURIComponent(this.cfg.storeId)}` +
        `&token=${encodeURIComponent(this.cfg.token)}`;
      const ws = new WebSocket(url);
      ws.onopen = () => {
        this.ws = ws;
        resolve(ws);
      };
      ws.onerror = () => reject(new Error("relay socket error"));
      ws.onmessage = (ev) => this.onMessage(typeof ev.data === "string" ? ev.data : "");
    });
  }

  private onMessage(raw: string): void {
    let m: { type?: string; jobId?: string; ok?: boolean; code?: string; error?: string };
    try {
      m = JSON.parse(raw) as typeof m;
    } catch {
      return;
    }
    if ((m.type === "submit_ack" || m.type === "result") && m.jobId) {
      const p = this.pending.get(m.jobId);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.jobId);
      if (m.type === "result") {
        // 真正物理出單結果（由店內 Stationary Agent 經 relay 返）
        p.resolve({ ok: Boolean(m.ok), ticketId: m.jobId, code: m.code, error: m.error });
      }
      // submit_ack：relay 接受咗，等後續 result（pending 保留）
    }
  }

  async send(job: PrintJob, printer: DevicePrinterConfig, opts: PrintSendOptions): Promise<PrintSendResult> {
    const ws = await this.ensureSocket();
    const timeoutMs = this.cfg.timeoutMs ?? 60_000;
    return new Promise<PrintSendResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(job.id);
        resolve({ ok: false, ticketId: job.id, code: "RELAY_TIMEOUT", error: "relay timeout" });
      }, timeoutMs);
      this.pending.set(job.id, { resolve, timer });
      ws.send(
        JSON.stringify({
          type: "submit",
          storeId: this.cfg.storeId,
          token: this.cfg.token,
          job,
          printer,
          kind: opts.kind,
          storeName: opts.storeName ?? "",
          ttl: job.ttl ?? null,
        }),
      );
    });
  }
}
