// Phase 5 互聯網備援：relay 配置讀取（P5.3 接駁用，見 docs/46）。
//
// relayUrl + token 由 localStorage 提供（正式 token 簽發見 docs/46 §4 / §7）。
// storeId 由 bootstrap cache 取。呢度只係提供一個 lazy RelayTransport 實例畀 dispatch 用。

import { RelayTransport } from "@/lib/print-bridge/relay-transport";
import { loadBootstrapCache } from "@/lib/storage";

const RELAY_URL_KEY = "macau-pos-relay-url";
const RELAY_TOKEN_KEY = "macau-pos-relay-token";

export function getRelayUrl(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(RELAY_URL_KEY) ?? "";
}

export function setRelayConfig(url: string, token: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(RELAY_URL_KEY, url);
  window.localStorage.setItem(RELAY_TOKEN_KEY, token);
}

export function isRelayConfigured(): boolean {
  return getRelayUrl().trim().length > 0;
}

let cached: RelayTransport | null = null;
let cachedUrl = "";

/** 取得（lazy）RelayTransport 實例；未配置 relay 或冇 storeId 就返 null。 */
export function getRelayTransport(): RelayTransport | null {
  const relayUrl = getRelayUrl();
  if (!relayUrl.trim()) return null;
  const token =
    (typeof window !== "undefined" ? window.localStorage.getItem(RELAY_TOKEN_KEY) : "") ?? "";
  const storeId = loadBootstrapCache()?.storeId ?? "";
  if (!storeId) return null;
  if (!cached || cachedUrl !== relayUrl) {
    cached = new RelayTransport({ relayUrl, token, storeId });
    cachedUrl = relayUrl;
  }
  return cached;
}
