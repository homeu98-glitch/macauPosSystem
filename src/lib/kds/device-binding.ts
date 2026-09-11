/**
 * 後廚屏設備綁定（docs/116 §4.2 / §4.4）。
 *
 * 照抄 kiosk 嘅「登入一次、之後開機即入」模式，但多一個 `station`：
 * **崗位係設備屬性** —— 呢部 iPad 綁死做「廚房屏」或「水吧屏」，
 * 屏內冇任何切換掣，要改只能重新登入（防止廚房同事誤撳）。
 *
 * ⚠️ 一定要過 `isPlaceholderStoreId()` 硬閘。示範店代碼（`macau-store-a`）
 * 寫落去會令所有雲端查詢靜靜咁 match 唔到 —— 同 docs/113 記錄嘅 print-agent 坑一樣。
 *
 * 為咗令呢個模組可以喺 `node --test` 下載入，呢度**唔用 `@/` alias**，
 * 一律用相對路徑 + `.ts`（`allowImportingTsExtensions` 已開）。
 */

import { isPlaceholderStoreId } from "../pos/store-id-guard.ts";
import type { KdsDeviceBinding, KdsRole } from "./types.ts";

export const KDS_BINDING_KEY = "macau-pos-kds-device";

const VALID_ROLES: ReadonlySet<string> = new Set<KdsRole>(["kitchen", "expo"]);

/**
 * 讀綁定。假店 / 壞資料一律當「冇綁定」處理 ——
 * 寧願彈返去登入，都唔好靜靜查錯店（查到空 = 屏永遠空白，最難 debug）。
 */
export function loadKdsDeviceBinding(): KdsDeviceBinding | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KDS_BINDING_KEY);
    if (!raw) return null;
    const binding = JSON.parse(raw) as Partial<KdsDeviceBinding> | null;
    if (!binding || typeof binding !== "object") return null;
    if (typeof binding.storeId !== "string" || isPlaceholderStoreId(binding.storeId)) return null;
    if (typeof binding.role !== "string" || !VALID_ROLES.has(binding.role)) return null;
    // 後廚屏冇 station = 未完成綁定 → 當冇綁定，強制返去揀崗位。
    // ⚠️ 絕對唔可以「冇 station 就當全部」—— 咁就係用戶想消滅嘅模式。
    if (binding.role === "kitchen" && (typeof binding.station !== "string" || !binding.station.trim())) {
      return null;
    }
    return {
      storeId: binding.storeId,
      storeName: typeof binding.storeName === "string" ? binding.storeName : "",
      role: binding.role as KdsRole,
      station: typeof binding.station === "string" ? binding.station.trim() : undefined,
      boundAt: typeof binding.boundAt === "string" ? binding.boundAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * 寫綁定。示範店代碼一律拒寫（呢度係最後一道防線）。
 * @returns 成功與否（false = 被硬閘擋咗，caller 應該顯示錯誤而唔係扮成功）
 */
export function saveKdsDeviceBinding(binding: KdsDeviceBinding): boolean {
  if (typeof window === "undefined") return false;
  if (isPlaceholderStoreId(binding?.storeId)) {
    console.error(
      `[kds] 拒絕寫入示範店綁定（storeId=${binding?.storeId}）。` +
        `呢個係 mock 值，寫咗會令後廚屏所有雲端查詢靜靜咁 match 唔到。` +
        `請確保登入有帶到 merchantId。`,
    );
    return false;
  }
  if (!VALID_ROLES.has(binding.role)) return false;
  if (binding.role === "kitchen" && !binding.station?.trim()) return false;
  window.localStorage.setItem(KDS_BINDING_KEY, JSON.stringify(binding));
  return true;
}

/** 清綁定（「⚙ 設定」→「切換崗位」用）。 */
export function clearKdsDeviceBinding(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KDS_BINDING_KEY);
}
