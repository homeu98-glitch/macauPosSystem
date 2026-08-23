/**
 * Print bridge 共用工具——原 Printer Hub adapter 已於 2026-08 評估（docs/50）移除。
 *
 * 本檔現只保留三個不被 Hub 專屬、但被其他 transport 共用嘅函數：
 *   - resolveJobPrinter：按 PrintJob.printerGroup 由 config.printers 搵目標打印機（單一真源，dispatch.ts 用）
 *   - applyPairText：解析 QR / 手動輸入嘅配對地址（Companion QR 掃描用）
 *   - loadJsQr：動態載入 jsQR（Companion QR 掃描用）
 *
 * 新打印通道：desktop 經 Companion（localhost）、Android 經 native bridge、互聯網備援經 relay。
 * Hub 發送 / 管理 API 已全刪。
 */

import type { DevicePrinterConfig, PrintJob } from "@/lib/types";
import { loadDeviceConfig } from "@/lib/storage";
import { defaultDeviceConfig } from "@/lib/mock-data";

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

/** 解析 QR / 手動輸入嘅配對地址。支援 http://IP:PORT / poshub://IP:PORT / 純 IP:PORT / 純 IP。
 *  現主要畀 Companion 代理地址配對用（Companion 同 Hub 格式兼容）。 */
export function applyPairText(raw: string): { ip: string; port: string } | null {
  const text = String(raw || "").trim();
  let ip = "";
  let port = "8787";
  try {
    if (/^https?:\/\//i.test(text)) {
      const u = new URL(text);
      ip = u.hostname;
      port = u.port || "8787";
    } else if (/^poshub:\/\//i.test(text)) {
      const rest = text.replace(/^poshub:\/\//i, "");
      const parts = rest.split(":");
      ip = parts[0];
      port = parts[1] || "8787";
    } else {
      const m = text.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/);
      if (m) {
        ip = m[1];
        port = m[2] || "8787";
      }
    }
  } catch {
    // ignore
  }
  return ip ? { ip, port } : null;
}

/** 按 PrintJob.printerGroup 由 config.printers 搵出目標打印機（單一真源）。 */
export function resolveJobPrinter(job: PrintJob): DevicePrinterConfig | undefined {
  const printers = (loadDeviceConfig() ?? defaultDeviceConfig).printers;
  // 1) 直接用 job 記錄嘅 printerId（建 job 時已對應到某部 config.printers）
  if (job.printerId) {
    const byId = printers.find((p) => p.id === job.printerId && p.enabled);
    if (byId) return byId;
  }
  // 2) 按 printerGroup 對應 role / zoneId
  if (job.printerGroup === "receipt") {
    return printers.find((p) => p.role === "receipt" && p.enabled);
  }
  if (job.printerGroup === "label") {
    return printers.find((p) => p.role === "label" && p.enabled);
  }
  // 分區打印機：zoneId 對應 printerGroup
  return printers.find(
    (p) => (p.role === "zone" || p.role === "label") && (p.zoneId ?? "") === job.printerGroup && p.enabled,
  );
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
