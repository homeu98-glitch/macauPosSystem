// 終端行業配置（salon 維度的 localStorage 標識）。
// Phase 1 用法：營運把終端部署到美容院時，設成 "salon"；之後切到 /salon/... 路由。
// Phase 2+ 之後會由 Ledger login session 帶 merchant.industry 覆蓋此處設定。

import { SALON_STORAGE_KEYS, type TerminalIndustry } from "@/lib/salon/types";

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

/** 設定終端行業 */
export function setTerminalIndustry(industry: TerminalIndustry) {
  writeRaw(SALON_STORAGE_KEYS.terminalIndustry, industry);
}
