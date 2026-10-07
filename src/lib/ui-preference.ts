import {
  DEFAULT_UI_LANG,
  normalizeUiLang,
  type UiLang,
} from "@/lib/i18n";

/**
 * UI 語言偏好（**只存本機 device，唔上雲**）。
 *
 * ## 🔴 點解唔可以用 `PosLocalSettings`
 *
 * `PosLocalSettings` **會上雲**：
 * `device-settings.tsx:933` → `POST /api/pos/device-config`
 * → `api/pos/device-config/route.ts:109` `local_settings: payload.localSettings`
 * 成份寫入 `pos_device_configs.local_settings`（jsonb）。
 *
 * 加上 `storage.ts:427` `normalizePosLocalSettings()` 係**逐欄重建**（唔係 spread merge），
 * 任何冇喺該函式明寫嘅欄位會喺每次 load / save / 雲端同步時**靜靜消失**
 * （repo 內已因此燒過至少 6 次：`standaloneSpecGroups` / `receipt.qrUrl` /
 * `receipt.returnPolicyText` / `label.paperSize` / `retailLabel` / `shiftTemplatePresets`）。
 *
 * 所以呢個檔**刻意獨立**：
 * - 唔入 `PosLocalSettings` ⇒ 唔會被 `normalizePosLocalSettings` 剷走
 * - 唔經 `device-config` ⇒ 唔會上雲、唔會跨機覆蓋
 * - 唔需要改 `storage.ts` / `mock-data.ts` / `types.ts` 三處
 *
 * ⚠️ 呢度**刻意唔係 per-store key**：語言係「呢部機嘅顯示偏好」，唔係店務。
 * 同一部平板切咗英文，之後去第二間店都應該仲係英文（員工唔使每間店重設）。
 *
 * 防護寫法照 `pos/workbench-preference.ts:25-50`（try/catch + SSR 短路）——
 * 無痕模式 / 私隱設定會令 localStorage throw，唔可以因為記唔到偏好就令佢入唔到 POS。
 */

const LANG_KEY = "pos.uiLang";

function readRaw(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore：記唔到偏好唔應該影響登入
  }
}

/** 讀本機語言偏好。冇寫過 → `zh-Hant`（現行行為，零遷移成本）。 */
export function loadUiLang(): UiLang {
  return normalizeUiLang(readRaw(LANG_KEY));
}

export function saveUiLang(lang: UiLang) {
  writeRaw(LANG_KEY, lang);
}

/**
 * 首次安裝 / 遷移時寫入預設值。
 *
 * ⚠️ **刻意唔自動寫入**：只有讀取（`loadUiLang`）就係讀唔到就 fallback 中文，
 * 唔需要寫。減少一次寫入 = 減少一個「無痕模式 throw」嘅機會。
 * 呢個函式只供「需要明確初始化」嘅測試用。
 */
export function ensureUiLangInitialized(): UiLang {
  const existing = readRaw(LANG_KEY);
  if (existing === null) return DEFAULT_UI_LANG;
  return normalizeUiLang(existing);
}