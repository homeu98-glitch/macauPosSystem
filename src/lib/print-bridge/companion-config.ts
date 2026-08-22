// Phase 2 桌面 Companion 配置讀取（見 docs/47）。
// baseUrl + token 由 localStorage 提供（設置頁配對 Companion 嗰陣寫入，同 Hub 配對類似）。

import { CompanionTransport } from "@/lib/print-bridge/companion-transport";

const COMPANION_URL_KEY = "macau-pos-companion-url";
const COMPANION_TOKEN_KEY = "macau-pos-companion-token";

export function getCompanionUrl(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(COMPANION_URL_KEY) ?? "";
}

export function setCompanionConfig(url: string, token: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(COMPANION_URL_KEY, url);
  window.localStorage.setItem(COMPANION_TOKEN_KEY, token);
}

export function isCompanionConfigured(): boolean {
  return getCompanionUrl().trim().length > 0;
}

let cached: CompanionTransport | null = null;
let cachedUrl = "";

export function getCompanionTransport(): CompanionTransport | null {
  const baseUrl = getCompanionUrl();
  if (!baseUrl.trim()) return null;
  const token =
    (typeof window !== "undefined" ? window.localStorage.getItem(COMPANION_TOKEN_KEY) : "") ?? "";
  if (!cached || cachedUrl !== baseUrl) {
    cached = new CompanionTransport({ baseUrl, token });
    cachedUrl = baseUrl;
  }
  return cached;
}
