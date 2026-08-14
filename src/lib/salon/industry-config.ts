// 終端行業配置（salon 維度的 localStorage 標識）。
// Phase 1 用法：營運把終端部署到美容院時，設成 "salon"；之後切到 /salon/... 路由。
// Phase 2+ 之後會由 Ledger login session 帶 merchant.industry 覆蓋此處設定。

import { SALON_STORAGE_KEYS, type TerminalIndustry } from "@/lib/salon/types";

function readRaw(key: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

/** 取得終端行業設定；未設定回傳 null（首次訪問） */
export function getTerminalIndustry(): TerminalIndustry | null {
  const raw = readRaw(SALON_STORAGE_KEYS.terminalIndustry);
  if (raw === "salon" || raw === "restaurant") {
    return raw;
  }
  return null;
}

/** 設定終端行業 */
export function setTerminalIndustry(industry: TerminalIndustry) {
  writeRaw(SALON_STORAGE_KEYS.terminalIndustry, industry);
}

/** 清除終端行業設定（用於測試或重置） */
export function clearTerminalIndustry() {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(SALON_STORAGE_KEYS.terminalIndustry);
  } catch {
    // ignore
  }
}

/** 是否為 salon 終端 */
export function isSalonTerminal(): boolean {
  return getTerminalIndustry() === "salon";
}
