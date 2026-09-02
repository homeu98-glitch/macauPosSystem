// 雲端中繼：relay 配對狀態（docs/96）。
// 配對完成（web 經 /api/pos/print-agent/pair 確認）後，將 agentId / token / storeId / storeName
// 存落 localStorage。dispatch.ts channel ③ 同 print-center 靠 isRelayConfigured() 決定啟用。

import { RelayTransport } from "@/lib/print-bridge/relay-transport";

const RELAY_AGENT_ID_KEY = "macau-pos-relay-agent-id";
const RELAY_TOKEN_KEY = "macau-pos-relay-token";
const RELAY_STORE_ID_KEY = "macau-pos-relay-store-id";
const RELAY_STORE_NAME_KEY = "macau-pos-relay-store-name";
const RELAY_PAIRED_KEY = "macau-pos-relay-paired";

export interface RelayPairing {
  agentId: string;
  token: string;
  storeId: string;
  storeName: string | null;
}

export function getRelayPairing(): RelayPairing | null {
  if (typeof window === "undefined") return null;
  if (window.localStorage.getItem(RELAY_PAIRED_KEY) !== "1") return null;
  const agentId = window.localStorage.getItem(RELAY_AGENT_ID_KEY) ?? "";
  const token = window.localStorage.getItem(RELAY_TOKEN_KEY) ?? "";
  const storeId = window.localStorage.getItem(RELAY_STORE_ID_KEY) ?? "";
  if (!agentId || !storeId) return null;
  const storeName = window.localStorage.getItem(RELAY_STORE_NAME_KEY) || null;
  return { agentId, token, storeId, storeName };
}

export function setRelayPaired(p: RelayPairing): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(RELAY_AGENT_ID_KEY, p.agentId);
  window.localStorage.setItem(RELAY_TOKEN_KEY, p.token);
  window.localStorage.setItem(RELAY_STORE_ID_KEY, p.storeId);
  if (p.storeName) window.localStorage.setItem(RELAY_STORE_NAME_KEY, p.storeName);
  window.localStorage.setItem(RELAY_PAIRED_KEY, "1");
}

export function clearRelayPairing(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(RELAY_AGENT_ID_KEY);
  window.localStorage.removeItem(RELAY_TOKEN_KEY);
  window.localStorage.removeItem(RELAY_STORE_ID_KEY);
  window.localStorage.removeItem(RELAY_STORE_NAME_KEY);
  window.localStorage.removeItem(RELAY_PAIRED_KEY);
}

export function isRelayConfigured(): boolean {
  return getRelayPairing() !== null;
}

let cached: RelayTransport | null = null;
let cachedPaired = false;

/** 取得（lazy）RelayTransport 實例；未配對就返 null。 */
export function getRelayTransport(): RelayTransport | null {
  const paired = isRelayConfigured();
  if (!paired) {
    cached = null;
    cachedPaired = false;
    return null;
  }
  if (!cached || !cachedPaired) {
    cached = new RelayTransport();
    cachedPaired = true;
  }
  return cached;
}
