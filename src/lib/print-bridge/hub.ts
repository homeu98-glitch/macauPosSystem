/**
 * Printer Hub adapter — POS 網頁配對 Sunmi 上面跑嘅 Print Agent APK（HTTP Hub :8787）。
 *
 * 架構：POS（Vercel HTTPS）→ HTTP Hub（店內 LAN :8787）→ raw socket :9100 → 打印機。
 * 同 demo print.html 嘅合約一致：非 HTTPS 先用 fetch POST /api/print，否則用
 * beacon.png 隱藏圖片 chunked 傳輸過 mixed content。
 *
 * 命名空間 localStorage：posHubIp / posHubPort
 */

import type { PrintJob } from "@/lib/types";

declare global {
  interface Window {
    jsQR?: (
      data: Uint8ClampedArray,
      width: number,
      height: number,
      options?: unknown,
    ) => { data: string } | null;
  }
}

/** Hub 嘅 service id（同 APK PrinterService 對齊）。 */
export const HUB_SERVICES = [
  { id: "front", label: "前台" },
  { id: "bar", label: "水吧" },
  { id: "kitchen", label: "廚房" },
] as const;

export type HubServiceId = (typeof HUB_SERVICES)[number]["id"];

export interface HubDevice {
  key: string;
  name: string;
  ip: string;
  mac: string;
  openPorts: number[];
  service: string; // "" 或 front/bar/kitchen
  canRawPrint: boolean;
}

const DEFAULT_PORT = "8787";

/** 讀取已配對嘅 Hub base URL（http://IP:PORT）。 */
export function getHubUrl(): string {
  if (typeof window === "undefined") return "";
  const ip = window.localStorage.getItem("posHubIp")?.trim();
  const port = window.localStorage.getItem("posHubPort")?.trim() || DEFAULT_PORT;
  if (!ip) return "";
  return `http://${ip}:${port}`;
}

export function isHubConfigured(): boolean {
  return getHubUrl() !== "";
}

/**
 * 新 PrintJob 嘅初始狀態（Hub-only）。
 * 已配對 Hub 嘅 job 交畀 flush worker 經 Hub 派發（樂觀標 sent，失敗再由 worker 改 failed）；
 * 未配對 Hub 嘅 job 維持 pending，等店主喺設置頁配對 Sunmi Hub。
 */
export function resolvePrintJobStatus(networkOnline: boolean): PrintJob["status"] {
  if (isHubConfigured()) return "sent";
  return "pending";
}

export function saveHubConfig(ip: string, port: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem("posHubIp", ip.trim());
  window.localStorage.setItem("posHubPort", port.trim() || DEFAULT_PORT);
}

/** 解析 QR / 手動輸入嘅 Hub 地址。支援 http://IP:PORT / poshub://IP:PORT / 純 IP:PORT / 純 IP。 */
export function applyPairText(raw: string): { ip: string; port: string } | null {
  const text = String(raw || "").trim();
  let ip = "";
  let port = DEFAULT_PORT;
  try {
    if (/^https?:\/\//i.test(text)) {
      const u = new URL(text);
      ip = u.hostname;
      port = u.port || DEFAULT_PORT;
    } else if (/^poshub:\/\//i.test(text)) {
      const rest = text.replace(/^poshub:\/\//i, "");
      const parts = rest.split(":");
      ip = parts[0];
      port = parts[1] || DEFAULT_PORT;
    } else {
      const m = text.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/);
      if (m) {
        ip = m[1];
        port = m[2] || DEFAULT_PORT;
      }
    }
  } catch {
    // ignore
  }
  return ip ? { ip, port } : null;
}

/** 將 PrintJob.printerGroup 映射到 Hub service id。 */
export function mapGroupToService(group: string): HubServiceId {
  if (group === "kitchen" || group === "zone") return "kitchen";
  if (group === "bar") return "bar";
  return "front"; // receipt / label / 其他 → 前台
}

/** 將 PrintJob 渲染成可讀文本票（Hub 嘅 Android 端再做 ESC/POS 封裝）。 */
export function renderJobToText(job: PrintJob): string {
  const lines: string[] = [];
  const tag =
    job.ticketType === "addon" ? "[加單]" : job.ticketType === "void" ? "[取消]" : "";
  const header = [
    tag,
    job.tableName ? `桌號 ${job.tableName}` : "",
    job.orderNo ? `單號 ${job.orderNo}` : "",
  ]
    .filter(Boolean)
    .join("  ");
  if (header) lines.push(header);
  lines.push("------------------------------");
  for (const it of job.items ?? []) {
    let line = `${it.name} x${it.quantity}`;
    if (it.specs && it.specs.length) line += `  [${it.specs.join(" ")}]`;
    lines.push(line);
    if (it.note) lines.push(`  ${it.note}`);
  }
  lines.push("------------------------------");
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────
// 發送（共用 print.html 合約）
// ─────────────────────────────────────────────────────────────

function chunkMessage(msg: string, maxEncoded: number): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const ch of msg) {
    const trial = cur + ch;
    if (encodeURIComponent(trial).length > maxEncoded) {
      if (cur) chunks.push(cur);
      cur = ch;
    } else {
      cur = trial;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [""];
}

function sendBeacon(
  base: string,
  params: { service?: string; ip?: string; title?: string },
  message: string,
) {
  const parts = chunkMessage(message, 1400);
  const job = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  parts.forEach((chunk, seq) => {
    const q = new URLSearchParams({
      job,
      seq: String(seq),
      total: String(parts.length),
      chunk,
      t: String(Date.now()),
    });
    if (params.service) q.set("service", params.service);
    if (params.ip) q.set("ip", params.ip);
    if (params.title) q.set("title", params.title);
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.src = `${base}/beacon.png?${q.toString()}`;
  });
}

async function sendFetch(
  base: string,
  body: Record<string, string>,
): Promise<boolean> {
  try {
    const r = await fetch(`${base}/api/print`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await r.json().catch(() => ({}))) as { received?: boolean; ok?: boolean };
    return Boolean(j.received || j.ok);
  } catch {
    return false;
  }
}

/** 發送到指定 service（按 service 分發到綁定嘅打印機）。 */
export async function sendToHub(service: HubServiceId | string, message: string): Promise<void> {
  const base = getHubUrl();
  if (!base) throw new Error("未配對 Printer Hub");
  if (typeof location !== "undefined" && location.protocol !== "https:") {
    if (await sendFetch(base, { service, message })) return;
  }
  sendBeacon(base, { service }, message);
}

/** 發送到指定 IP（直接打某部打印機，唔經 service 分發）。 */
export async function sendToHubIp(ip: string, title: string, message: string): Promise<void> {
  const base = getHubUrl();
  if (!base) throw new Error("未配對 Printer Hub");
  if (typeof location !== "undefined" && location.protocol !== "https:") {
    if (await sendFetch(base, { ip, title, message })) return;
  }
  sendBeacon(base, { ip, title }, message);
}

/** 高階：將 PrintJob 渲染 + 映射 service + 發送到 Hub。 */
export async function sendJobToHub(
  job: PrintJob,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = getHubUrl();
  if (!base) return { ok: false, error: "未配對 Printer Hub" };
  const service = mapGroupToService(job.printerGroup);
  const message = renderJobToText(job);
  try {
    await sendToHub(service, message);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "發送到 Hub 失敗" };
  }
}

// ─────────────────────────────────────────────────────────────
// Hub 管理 API
// ─────────────────────────────────────────────────────────────

export async function fetchHubStatus(): Promise<{
  ok: boolean;
  listening?: boolean;
  localIp?: string;
  port?: number;
  deviceCount?: number;
  bound?: number;
  subnetPrefix?: string;
  devices?: HubDevice[];
  error?: string;
}> {
  const base = getHubUrl();
  if (!base) return { ok: false, error: "未配對 Printer Hub" };
  try {
    const r = await fetch(`${base}/api/status`, { cache: "no-store" });
    const j = (await r.json()) as {
      ok?: boolean;
      listening?: boolean;
      localIp?: string;
      port?: number;
      deviceCount?: number;
      bound?: number;
      subnetPrefix?: string;
      devices?: HubDevice[];
    };
    return {
      ok: j.ok ?? false,
      listening: j.listening,
      localIp: j.localIp,
      port: j.port,
      deviceCount: j.deviceCount,
      bound: j.bound,
      subnetPrefix: j.subnetPrefix,
      devices: j.devices,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Hub 離線" };
  }
}

export async function fetchHubDevices(): Promise<{
  ok: boolean;
  devices?: HubDevice[];
  error?: string;
}> {
  const base = getHubUrl();
  if (!base) return { ok: false, error: "未配對 Printer Hub" };
  try {
    const r = await fetch(`${base}/api/devices`, { cache: "no-store" });
    const j = (await r.json()) as { ok?: boolean; devices?: HubDevice[] };
    return { ok: j.ok ?? false, devices: j.devices };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Hub 離線" };
  }
}

async function hubPost(
  path: string,
  body: Record<string, string>,
): Promise<{ ok: boolean; devices?: HubDevice[]; error?: string }> {
  const base = getHubUrl();
  if (!base) return { ok: false, error: "未配對 Printer Hub" };
  try {
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; devices?: HubDevice[]; error?: string };
    return { ok: j.ok ?? false, devices: j.devices, error: j.error };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Hub 離線" };
  }
}

export function assignHubPrinter(key: string, serviceId: HubServiceId | string) {
  return hubPost("/api/assign", { key, service: serviceId });
}

export function manualAddHubPrinter(ip: string, name: string, serviceId: HubServiceId | string) {
  return hubPost("/api/manual", { ip, name, service: serviceId });
}

export function removeHubPrinter(key: string) {
  return hubPost("/api/remove", { key });
}

export function clearHubPrinters() {
  return hubPost("/api/clear", {});
}

export async function startHubScan(prefix?: string) {
  // Hub 嘅 requestScan() 要求 prefix 係 3 段 IP（網段，例如 192.168.1），
  // 否則直接 return false 唔掃描。冇傳 prefix 就由 /api/status 嘅 subnetPrefix 自動拎。
  let p = (prefix ?? "").trim();
  if (!p) {
    const st = await fetchHubStatus();
    p = st.subnetPrefix ?? "";
  }
  if (!p) {
    return {
      ok: false,
      error: "請先填寫掃描網段（例如 192.168.1），或等 Hub 自動偵測網段",
      devices: [],
    };
  }
  return hubPost("/api/scan", { prefix: p, identify: "true" });
}

// ─────────────────────────────────────────────────────────────
// QR 掃描（動態載入 jsQR from CDN，同 print.html）
// ─────────────────────────────────────────────────────────────

export function loadJsQr(): Promise<((data: Uint8ClampedArray, width: number, height: number) => { data: string } | null) | null> {
  return new Promise((resolve) => {
    if (typeof window !== "undefined" && typeof window.jsQR === "function") {
      resolve(window.jsQR);
      return;
    }
    if (typeof document === "undefined") {
      resolve(null);
      return;
    }
    const existing = document.querySelector("script[data-jsqr]");
    if (existing) {
      existing.addEventListener("load", () => resolve(window.jsQR ?? null));
      existing.addEventListener("error", () => resolve(null));
      return;
    }
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js";
    s.async = true;
    s.setAttribute("data-jsqr", "1");
    s.onload = () => resolve(window.jsQR ?? null);
    s.onerror = () => resolve(null);
    document.body.appendChild(s);
  });
}
