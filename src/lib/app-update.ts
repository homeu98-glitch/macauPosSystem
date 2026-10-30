// App OTA 更新 bridge（2026-10-30，1.2.3）—— web 端經 window.PosNative.* 檢查/更新 APK 版本。
//
// 鏈路：
//   checkAppUpdate()   → APK 原生同步打 {POS_URL}/api/release/versions/active 比 versionName
//   startAppUpdate(url) → APK 原生下載 → FileProvider → 系統安裝器（永遠要店員按一次「安裝」）
//
// 進度/結果回呼（MainActivity 注入）：
//   window.__onAppUpdateProgress({ phase:"downloading", received, total, percent })
//   window.__onAppUpdateResult({ ok, phase:"installer" } | { ok:false, error, needsInstallPermission? })

/** `/api/release/versions/active` 嘅精簡形狀（同 app-download-button.tsx 一致）。 */
export type NativeAppUpdateCheck = {
  ok: boolean;
  updateAvailable: boolean;
  currentVersion: string;
  currentVersionCode: number;
  latestVersion?: string;
  downloadUrl?: string;
  fileSize?: number | null;
  notes?: string | null;
  error?: string;
};

export type AppUpdateCheckResult =
  | {
      ok: true;
      updateAvailable: boolean;
      currentVersion: string;
      currentVersionCode: number;
      latestVersion: string | null;
      downloadUrl: string | null;
      fileSize: number | null;
      notes: string | null;
    }
  | { ok: false; error: string };

export type AppUpdateProgress = {
  phase: "downloading";
  received: number;
  total: number;
  percent: number;
};

export type AppUpdateResult =
  | { ok: true; phase: "installer" }
  | { ok: false; needsInstallPermission?: boolean; error: string };

type PosNativeUpdateBridge = {
  checkAppUpdate?: () => unknown;
  startAppUpdate?: (url: string) => unknown;
};

function getBridge(): PosNativeUpdateBridge | null {
  if (typeof window === "undefined") return null;
  const p = (window as unknown as { PosNative?: Record<string, unknown> }).PosNative;
  if (!p) return null;
  return p as PosNativeUpdateBridge;
}

/**
 * 呢部機係咪 Android 原生殼（APK WebView）——**只**認有 `checkAppUpdate` 嘅橋。
 *
 * ⚠️ 唔好攞 `isRunningInNativeShell()`（嗰個連 desktop Companion 都當 true）：
 *    「版本」tab 同更新橫幅係 APK 專屬，桌面版更新走另一條路。
 *    舊版 APK（<1.2.3）冇呢個方法 → 呢個函數回 false ⇒ 唔會出 tab／橫幅（正確：
 *    舊 APK 也冇能力裝新包，要靠人手下載，顯示「有更新」只會誤導）。
 */
export function isAndroidNativeShell(): boolean {
  if (typeof window === "undefined") return false;
  const p = (window as unknown as { PosNative?: Record<string, unknown> }).PosNative;
  return !!(p && typeof p.checkAppUpdate === "function");
}

/** parseMaybeJson 嘅本地版（避免 import native.ts 拖埋打印依賴）。 */
function parseJson(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 檢查有冇新版（經 APK 原生；阻塞喺原生綫程做，JS 呢邊係同步包一層）。 */
export function checkNativeAppUpdate(): AppUpdateCheckResult {
  const b = getBridge();
  if (!b?.checkAppUpdate) return { ok: false, error: "此裝置唔支援版本檢查" };
  try {
    const parsed = parseJson(b.checkAppUpdate());
    if (!parsed) return { ok: false, error: "檢查更新回應格式不正確" };
    if (parsed.ok !== true) {
      return { ok: false, error: typeof parsed.error === "string" ? parsed.error : "檢查更新失敗" };
    }
    const num = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      ok: true,
      updateAvailable: parsed.updateAvailable === true,
      currentVersion: typeof parsed.currentVersion === "string" ? parsed.currentVersion : "",
      currentVersionCode: num(parsed.currentVersionCode) ?? 0,
      latestVersion: typeof parsed.latestVersion === "string" ? parsed.latestVersion : null,
      downloadUrl: typeof parsed.downloadUrl === "string" ? parsed.downloadUrl : null,
      fileSize: parsed.fileSize == null ? null : num(parsed.fileSize),
      notes: typeof parsed.notes === "string" ? parsed.notes : null,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── 下載進度 / 結果 ─────────────────────────────────────────────────────

type ProgressFn = (p: AppUpdateProgress) => void;
type ResultFn = (r: AppUpdateResult) => void;

let resultResolve: ResultFn | null = null;
let resultTimer: ReturnType<typeof setTimeout> | null = null;

function parseProgress(raw: unknown): AppUpdateProgress | null {
  const p = parseJson(raw);
  if (!p || p.phase !== "downloading") return null;
  const received = Number(p.received);
  const total = Number(p.total);
  const percent = Number(p.percent);
  if (![received, total, percent].every(Number.isFinite)) return null;
  return { phase: "downloading", received, total, percent };
}

function parseResult(raw: unknown): AppUpdateResult | null {
  const p = parseJson(raw);
  if (!p) return null;
  if (p.ok === true && p.phase === "installer") return { ok: true, phase: "installer" };
  if (p.ok === false) {
    return {
      ok: false,
      needsInstallPermission: p.needsInstallPermission === true,
      error: typeof p.error === "string" ? p.error : "更新失敗",
    };
  }
  return null;
}

function settleResult(r: AppUpdateResult) {
  if (resultTimer) {
    clearTimeout(resultTimer);
    resultTimer = null;
  }
  const fn = resultResolve;
  resultResolve = null;
  fn?.(r);
}

/**
 * 開始下載＋安裝。`onProgress` 可選（設置 tab 顯示百分比用）。
 *
 * Promise 喺「開到安裝器」或「失敗」時 resolve；下載可能要一兩分鐘，
 * 所以逾時設 6 分鐘（300s call timeout + 餘量）。
 */
export function startNativeAppUpdate(
  downloadUrl: string,
  onProgress?: ProgressFn,
): Promise<AppUpdateResult> {
  return new Promise<AppUpdateResult>((resolve) => {
    const b = getBridge();
    if (!b?.startAppUpdate) {
      resolve({ ok: false, error: "此裝置唔支援應用內更新" });
      return;
    }
    if (resultResolve) {
      // 上一次未完又撳多次 → 當作取代，唔好留兩個 pending resolver。
      resolve({ ok: false, error: "已另一次更新進行中" });
      return;
    }
    resultResolve = resolve;
    resultTimer = setTimeout(() => {
      settleResult({ ok: false, error: "更新逾時（6 分鐘），請重試" });
    }, 360_000);

    const w = window as unknown as {
      __onAppUpdateProgress?: (raw: unknown) => void;
      __onAppUpdateResult?: (raw: unknown) => void;
    };
    w.__onAppUpdateProgress = (raw) => {
      const p = parseProgress(raw);
      if (!p) return;
      onProgress?.(p);
    };
    w.__onAppUpdateResult = (raw) => {
      const r = parseResult(raw);
      if (!r) return;
      settleResult(r);
    };

    try {
      b.startAppUpdate(downloadUrl);
    } catch (e) {
      settleResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}
