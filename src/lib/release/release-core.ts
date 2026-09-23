/**
 * 《App 安裝包版本》共用純邏輯（2026-09-23）。
 *
 * ## 點解要獨立一個檔
 *
 * 三邊都要用同一份口徑，唔可以各寫一套：
 *   1. **登入頁**（`components/app-download-buttons.tsx`）—— 靠裝置偵測決定顯示
 *      「下載 APK」定「下載安裝包」；
 *   2. **公開 API**（`/api/release/versions/active`）—— 砌下載連結、驗證 row 形狀；
 *   3. **admin 版本控制頁 + 管理 API** —— 驗證表單輸入、顯示檔案大小。
 *
 * ## 🔴 硬性約束：呢個檔**零 import**
 *
 * `npm test` = `node --test`，唔認 `@/` alias、唔支援 `.tsx`。
 * 所以呢度**唔可以** import 任何嘢（連 `import type` 都避免，除咗同檔內定義），
 * 亦唔可以喺 `.tsx` 用。要加依賴就開新檔，唔好污染呢度。
 *
 * ## 裝置偵測口徑（刻意簡單）
 *
 * 只有兩種平台：`android`（APK）同 `desktop`（安裝包）。
 *   · User-Agent 含 `android` → `android`；
 *   · 其餘一律 `desktop`。
 *
 * ⚠️ 即係 **iPhone / iPad 會歸入 `desktop`**。呢個係刻意的：
 *    我哋冇 iOS 安裝包，而「Android 先叫 mobile」係商家嘅實際口徑
 *    （見 `docs/` 版本控制需求）。將來真出 iOS 版就喺呢度加第三個平台，
 *    唔好改成「非 desktop 一律 mobile」而靜默改變現有行為。
 *
 * 判斷來源有兩層：
 *   ① `navigator.userAgent`（絕大多數情況夠用）；
 *   ② UA 空咗（自訂 WebView 會清）→ 退用 `navigator.platform`。
 */

/** 只有兩種對外平台，唔好隨意擴充（DB 有 check constraint 對應）。 */
export type ReleasePlatform = "android" | "desktop";

/** 展示次序：Android 行先（主要使用情境）。 */
export const RELEASE_PLATFORMS: readonly ReleasePlatform[] = ["android", "desktop"];

/** 平台代號 → 中文顯示名（admin 頁用）。 */
export const RELEASE_PLATFORM_LABEL: Record<ReleasePlatform, string> = {
  android: "Android（APK）",
  desktop: "Desktop（安裝包）",
};

/** 平台代號 → 登入頁按鈕文案。 */
export const RELEASE_PLATFORM_BUTTON_LABEL: Record<ReleasePlatform, string> = {
  android: "下載 APK",
  desktop: "下載安裝包",
};

/** 平台代號 → 檔案種類短描述（按鈕副標題／admin 表頭用）。 */
export const RELEASE_PLATFORM_FILE_LABEL: Record<ReleasePlatform, string> = {
  android: "Android 安裝檔",
  desktop: "桌面安裝檔",
};

/** Supabase Storage bucket 名（專案 `iyrywzormzisyppkokbi` 之內），public bucket。 */
export const RELEASE_STORAGE_BUCKET = "macauposapk";

/**
 * 下載連結嘅建議檔名（純粹俾 admin 表單做 placeholder，唔參與邏輯）。
 */
export const RELEASE_SUGGESTED_FILE_NAME: Record<ReleasePlatform, string> = {
  android: "macau-pos.apk",
  desktop: "macau-pos-setup.exe",
};

// ─────────────────────────────────────────────────────────────────────────────
// 平台判斷
// ─────────────────────────────────────────────────────────────────────────────

/** 型別守衛：由 DB / JSON 嚟嘅未知值收窄成 `ReleasePlatform`。 */
export function isReleasePlatform(value: unknown): value is ReleasePlatform {
  return value === "android" || value === "desktop";
}

/** UA 入面有 `android` 就算 Android（大小寫不敏感）。 */
function uaLooksAndroid(userAgent: string): boolean {
  return /android/i.test(userAgent);
}

/**
 * 由 User-Agent 判斷平台。**唔會 return null** —— 判斷唔到一律當 `desktop`。
 *
 * @param userAgent `navigator.userAgent`（SSR 時可能係 `undefined`／`null`）
 */
export function detectDevicePlatform(userAgent: string | null | undefined): ReleasePlatform {
  const ua = typeof userAgent === "string" ? userAgent : "";
  return uaLooksAndroid(ua) ? "android" : "desktop";
}

/**
 * 由瀏覽器環境判斷平台（比單看 UA 多一層 fallback）。
 *
 * 兩層：
 *   ① UA 有值 → 直接信 UA；
 *   ② UA 空白（自訂 WebView 會清空）→ 退用 `platform` 字串。
 *
 * ⚠️ 第 ② 層係**故意保守**：只有 UA 真係空白先會用 platform 猜。
 *    代價係「ARM 架構嘅 Linux 桌面 + 空白 UA」會被誤判成 Android ——
 *    呢個組合實際上唔存在（能跑 Chromium 嘅 ARM Linux 桌面一定有 UA），
 *    權衡之下寧願「UA 空白嘅 Android WebView」判得中。
 *
 * ⚠️ 故意**唔讀** `navigator.userAgentData.mobile`：
 *    佢喺 desktop Chrome 上長期係 `false`（幫唔到手），而 iPad 會報 `true`
 *    ⇒ 讀咗反而會令 iPad 派 APK。寧願保守。
 */
export function detectPlatformFromNavigator(input: {
  userAgent?: string | null;
  platform?: string | null;
}): ReleasePlatform {
  const ua = typeof input?.userAgent === "string" ? input.userAgent : "";
  if (ua.trim()) return detectDevicePlatform(ua);

  const plat = (typeof input?.platform === "string" ? input.platform : "").toLowerCase();
  // Android WebView 常見嘅 `navigator.platform` 值：
  //   · `Linux armv8l`（32 位 ARM）
  //   · `Linux aarch64`（64 位 ARM）← ⚠️ 唔會 startsWith("linux arm")，一定要另外捉
  if (plat.includes("android") || plat.startsWith("linux arm") || plat.includes("aarch64")) {
    return "android";
  }
  return "desktop";
}

/** 喺瀏覽器環境直接讀 navigator（component 用；SSR 時安全返 `desktop`）。 */
export function detectPlatformFromWindow(): ReleasePlatform {
  if (typeof navigator === "undefined") return "desktop";
  return detectPlatformFromNavigator({
    userAgent: navigator.userAgent,
    platform: typeof navigator.platform === "string" ? navigator.platform : null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 下載連結
// ─────────────────────────────────────────────────────────────────────────────

/** 去掉頭尾空白；空字串視為「冇填」。 */
function clean(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 由 Supabase Storage 路徑砌公開下載連結。
 *
 * 形狀：`{supabaseUrl}/storage/v1/object/public/{bucket}/{filePath}`
 *
 * 回 `null` 嘅情況（呼叫方要當「冇連結」處理，唔好顯示死 link）：
 *   · `supabaseUrl` 空白（本機／未配置）；
 *   · `filePath` 空白。
 *
 * ⚠️ `filePath` 每個路徑段落獨立編碼：**唔可以** `encodeURIComponent` 成條 path，
 *    否則 `1.4.2/macau-pos.apk` 嘅 `/` 會變 `%2F`，Storage 會 404。
 */
export function buildReleaseDownloadUrl(options: {
  supabaseUrl: string | null | undefined;
  bucket?: string | null;
  filePath: string | null | undefined;
}): string | null {
  const base = clean(options?.supabaseUrl).replace(/\/+$/, "");
  const filePath = clean(options?.filePath).replace(/^\/+/, "");
  const bucket = clean(options?.bucket) || RELEASE_STORAGE_BUCKET;
  if (!base || !filePath) return null;

  const encodedPath = filePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  if (!encodedPath) return null;

  return `${base}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodedPath}`;
}

/**
 * 決定一條版本 row 最終嘅下載連結。
 *
 * 優先次序：
 *   ① `download_url`（完整外部連結，admin 明確填嘅 → 無條件信佢）；
 *   ② 由 `file_path` + `supabaseUrl` 砌 Storage 公開連結；
 *   ③ 都冇 → `null`。
 *
 * `download_url` 只接受 `http(s)://` —— 防止 admin 誤填 `javascript:` 之類
 * 變成 XSS 載荷（呢個值會直接落喺登入頁嘅 `href`）。
 */
export function resolveReleaseDownloadUrl(options: {
  downloadUrl?: string | null;
  filePath?: string | null;
  supabaseUrl: string | null | undefined;
  bucket?: string | null;
}): string | null {
  const explicit = clean(options?.downloadUrl);
  if (explicit) {
    return /^https?:\/\//i.test(explicit) ? explicit : null;
  }
  return buildReleaseDownloadUrl({
    supabaseUrl: options?.supabaseUrl,
    bucket: options?.bucket,
    filePath: options?.filePath,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 顯示輔助
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 檔案大小人類可讀（admin 頁顯示）。
 * 未知（null / 負數 / 非有限數）→ `"—"`，唔好扮 `0 B`。
 */
export function formatReleaseFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  // 大檔（≥ 100）唔顯示小數，免得擠爆表格
  const decimals = value >= 100 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

/** 顯示用版本標題，例如 `1.4.2`（冇版本號就 `—`）。 */
export function formatReleaseVersionTitle(version: string | null | undefined): string {
  const v = clean(version);
  return v || "—";
}

// ─────────────────────────────────────────────────────────────────────────────
// 輸入驗證（admin API + admin 表單共用同一口徑）
// ─────────────────────────────────────────────────────────────────────────────

/** 驗證通過之後嘅正規化草稿。 */
export type ReleaseVersionDraft = {
  platform: ReleasePlatform;
  version: string;
  filePath: string | null;
  downloadUrl: string | null;
  fileSize: number | null;
  notes: string | null;
};

export type ValidateResult =
  | { ok: true; value: ReleaseVersionDraft }
  | { ok: false; error: string };

const MAX_VERSION_LEN = 64;
const MAX_PATH_LEN = 512;
const MAX_URL_LEN = 2048;
const MAX_NOTES_LEN = 1000;

/**
 * 驗證／正規化一個版本草稿（新增同編輯共用）。
 *
 * 刻意「寬入嚴出」：接受未知型別（`unknown`），唔會 throw，一律回 `{ ok, ... }`。
 * 呼叫方（API route）唔需要再自己 trim／判斷。
 */
export function validateReleaseDraft(raw: unknown): ValidateResult {
  if (!raw || typeof raw !== "object") return { ok: false, error: "缺少版本資料。" };
  const input = raw as Record<string, unknown>;

  const platform = input.platform;
  if (!isReleasePlatform(platform)) {
    return { ok: false, error: "平台必須係 android 或 desktop。" };
  }

  const version = clean(typeof input.version === "string" ? input.version : "");
  if (!version) return { ok: false, error: "請填版本號。" };
  if (version.length > MAX_VERSION_LEN) {
    return { ok: false, error: `版本號唔可以超過 ${MAX_VERSION_LEN} 個字。` };
  }

  const filePath = clean(typeof input.filePath === "string" ? input.filePath : "") || null;
  if (filePath && filePath.length > MAX_PATH_LEN) {
    return { ok: false, error: `檔案路徑唔可以超過 ${MAX_PATH_LEN} 個字。` };
  }
  // 路徑唔可以有 `..`（防目錄穿越；Storage 本身都擋，但唔好靠佢）
  if (filePath && filePath.split("/").some((seg) => seg === "..")) {
    return { ok: false, error: "檔案路徑唔可以包含「..」。" };
  }

  const downloadUrl = clean(typeof input.downloadUrl === "string" ? input.downloadUrl : "") || null;
  if (downloadUrl) {
    if (downloadUrl.length > MAX_URL_LEN) {
      return { ok: false, error: `下載連結唔可以超過 ${MAX_URL_LEN} 個字。` };
    }
    if (!/^https?:\/\//i.test(downloadUrl)) {
      return { ok: false, error: "下載連結必須以 http:// 或 https:// 開頭。" };
    }
  }

  if (!filePath && !downloadUrl) {
    return { ok: false, error: "請至少填「Storage 檔案路徑」或「完整下載連結」其中一項。" };
  }

  let fileSize: number | null = null;
  const rawSize = input.fileSize;
  if (rawSize !== null && rawSize !== undefined && rawSize !== "") {
    const parsed = typeof rawSize === "number" ? rawSize : Number.parseInt(String(rawSize), 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { ok: false, error: "檔案大小必須係不小於 0 嘅數字（bytes）。" };
    }
    fileSize = Math.round(parsed);
  }

  const notes = clean(typeof input.notes === "string" ? input.notes : "") || null;
  if (notes && notes.length > MAX_NOTES_LEN) {
    return { ok: false, error: `備註唔可以超過 ${MAX_NOTES_LEN} 個字。` };
  }

  return { ok: true, value: { platform, version, filePath, downloadUrl, fileSize, notes } };
}
