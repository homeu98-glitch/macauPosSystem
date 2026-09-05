/**
 * 桌面 Companion 代理客戶端（取代 Sunmi Printer Hub）。
 *
 * 架構：POS（Vercel HTTPS / 本地 Electron）↔ Companion 代理（loopback http://127.0.0.1:9311）
 *        ↔ raw socket :9100 / node-usb / 藍牙 → 打印機。
 *
 * 優勢：
 *   - 零配置預配對：固定 loopback 地址 + 空 token，開 app 即自動連。
 *   - 跨平台：Windows / macOS / Linux 桌面 Electron 都經呢層打印（唔再靠 Android APK）。
 *   - 自動偵測：Companion 經 mDNS 掃區網 LAN 機、node-usb 枚舉 USB 機，商家唔使手填 VID/PID。
 *
 * localStorage 命名空間：macau-pos-companion-url / macau-pos-companion-token
 */

import type { DevicePrinterConfig, PrintJob } from "@/lib/types";
import { defaultDeviceConfig } from "@/lib/mock-data";
import { loadDeviceConfig } from "@/lib/storage";
import { toHexId } from "@/lib/print-bridge/printer-models";

export const COMPANION_DEFAULT_URL = "http://127.0.0.1:9311";

const LS_URL = "macau-pos-companion-url";
const LS_TOKEN = "macau-pos-companion-token";

let cachedAvailable = false;
let cachedVersion = "";

// ─────────────────────────────────────────────────────────────
// 配置讀寫
// ─────────────────────────────────────────────────────────────

export function getCompanionUrl(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(LS_URL)?.trim() || "";
}

export function setCompanionUrl(url: string) {
  if (typeof window === "undefined") return;
  const v = url.trim();
  if (v) window.localStorage.setItem(LS_URL, v);
  else window.localStorage.removeItem(LS_URL);
}

export function getCompanionToken(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(LS_TOKEN)?.trim() || "";
}

export function setCompanionToken(token: string) {
  if (typeof window === "undefined") return;
  const v = token.trim();
  if (v) window.localStorage.setItem(LS_TOKEN, v);
  else window.localStorage.removeItem(LS_TOKEN);
}

/** 是否已配對（地址非空即視為已配對；token 預設留空） */
export function isCompanionConfigured(): boolean {
  return getCompanionUrl() !== "";
}

export function getCachedCompanionVersion(): string {
  return cachedVersion;
}

// ─────────────────────────────────────────────────────────────
// 執行環境判斷（三層規則，由嚴到寬，唔好混淆）
//
//   ① shouldUseCompanionChannel()   ← 最嚴：淨係原生殼（PC Electron / Android APK）
//   ② shouldKeepCompanionAlive()    ← ① + 帶 `?companion=` 參數
//                                     用嚟決定「走唔走 companion 通道 / 起唔起輪詢」
//   ③ shouldAutoDiscoverCompanion() ← ① + 本機 dev（localhost）
//                                     用嚟決定「值唔值得探一次 loopback」
//
// 純 website / PWA（Vercel HTTPS、PWA standalone、自己打網址開）三個都 false
// → 零 `http://127.0.0.1:9311/api/health` 請求，呢個就係呢層判斷存在嘅原因。
// ─────────────────────────────────────────────────────────────

/**
 * 「Companion 環境」**真實定義**：當前 page 跑喺我哋自己嘅原生殼入面。
 * 用原生殼主動注入嘅 bridge 標記（PosNative → Android APK WebView；
 * companionShell → PC Electron 殼），係 codebase 現有慣例
 * （見 `src/components/pwa-install-button.tsx`）。
 *
 * **只有** 喺呢個環境入面，`http://127.0.0.1:9311/api/health` 嘅探測先有意義 —
 * 因為 desktop agent 喺 loopback 住，可以喺 web view 探到。
 *
 * 純 website / PWA（Chrome standalone、macau-pos-system.vercel.app、localhost:3000
 * 開個普通瀏覽器測）都**唔算** Companion 環境：loopback 探過去只會
 * `ERR_CONNECTION_REFUSED`，冇 IPC 對手。
 *
 * 用嚟 gate：
 *   · print dispatch 通道②（`dispatch.ts`、`salon/print.ts`）—— 純 website
 *     就算 localStorage 有 stale URL 都要 skip
 *   · PrintFlushWorker mount 嗰次 `tryAutoPairCompanion()`
 */
export function shouldUseCompanionChannel(): boolean {
  // 攤平 import：避免 companion.ts 對 UI 檔有依賴
  if (typeof window === "undefined") return false;
  const hasPosNative = Boolean((window as unknown as { PosNative?: { printJob?: unknown } }).PosNative?.printJob);
  const hasCompanionShell = Boolean((window as unknown as { companionShell?: unknown }).companionShell);
  return hasPosNative || hasCompanionShell;
}

/**
 * 值唔值得**自動**去探 loopback（127.0.0.1:9311）搵 Companion？——**探測**用
 * （`auto-pair-companion.ts`、`tryAutoPairCompanion` branch 3、`probeCompanion()` fallback、
 *   `PrinterCompanionPanel` CompanionStatusCard mount probe）
 *
 * 背景（2026-09-02 + 2026-09-03 修訂）：
 * 舊版 `PrintFlushWorker` 每 2.5 秒 call 一次 `tryAutoPairCompanion()`，
 * branch 3（零配置 loopback 探測）會喺**從來冇配對過 Companion** 嘅情況下照打
 * `http://127.0.0.1:9311/api/health`。喺純 website（Vercel HTTPS / PWA standalone）上
 * 冇裝 Companion，呢個 fetch 只會永久掟 `ERR_CONNECTION_REFUSED`。
 *
 * 規則：**冇理由相信本機有 Companion，就唔好主動搵。**
 * 有理由 = ① 跑緊原生殼（PC Electron 殼 / Android APK WebView）→ 即
 *            `shouldUseCompanionChannel()`
 *          ② 個 page 本身就喺 localhost（`npm run dev` / 本機架嘅 POS）
 *
 * 仍然照行、唔受影響嘅 deliberate user 路徑（無論咩環境）：
 *   · URL `?companion=<url>` 參數（Companion 狀態頁「一鍵開 POS」帶入）
 *   · localStorage 已存咗地址（即用家配對過，之後會一直探佢）
 *   · 設定頁「測試連線」掣 / `PrinterCompanionPanel` 人手輸入地址
 *   · `probeCompanion(urlOverride)` 傳咗明確地址
 */
export function shouldAutoDiscoverCompanion(): boolean {
  if (typeof window === "undefined") return false;
  // 原生殼（PC Electron / Android APK）：Companion loopback 係呢個環境嘅設計一部分
  if (shouldUseCompanionChannel()) return true;
  // 本機（dev 或本機架嘅 POS）：loopback 探測有意義
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

/** URL 上有冇 `?companion=<url>` 參數（桌面 Companion「一鍵開 POS」帶入） */
function hasCompanionUrlParam(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).has("companion");
  } catch {
    return false;
  }
}

/**
 * 應唔應該**持續維持** Companion 連線（自動配對 + 健康檢查輪詢）？
 *
 * = 原生殼 **或** 帶咗 `?companion=` 參數。
 * 後者係桌面 Companion「一鍵開 POS」開出嚟嘅分頁 —— 就算係系統瀏覽器（唔係我哋個殼），
 * 用家都係由 Companion 嗰邊過嚟，desktop agent 的確喺度，所以要照輪詢、照顯示連線狀態。
 *
 * 純 website / PWA（自己打網址開、PWA standalone）一律 false → 零 /api/health 請求。
 */
export function shouldKeepCompanionAlive(): boolean {
  return shouldUseCompanionChannel() || hasCompanionUrlParam();
}

/**
 * 應唔應該**顯示** Companion 相關 UI（「桌面 Companion 代理」狀態卡）？
 *
 * 桌面 Companion agent 住喺本機 loopback（127.0.0.1:9311），**只有**以下情況
 * 先有可能連到，UI 出現先有意義：
 *   ① 跑喺原生殼（PC Electron / Android APK WebView）→ `shouldUseCompanionChannel()`
 *   ② 分頁由 Companion「一鍵開 POS」帶 `?companion=<url>` 開出嚟
 *      （即使係系統瀏覽器，agent 的確喺度）→ `hasCompanionUrlParam()`
 *   ③ 本機（localhost / 127.0.0.1）dev 或自架 POS → `shouldAutoDiscoverCompanion()` 內含
 *
 * **純 website / PWA（Vercel HTTPS、PWA standalone、自己打網址開）一律 false** →
 * 狀態卡完全隱藏，唔會出現「未連線（代理未啟動）」呢啲對純網店用家無意義、
 * 亦永遠解決唔到嘅紅燈。
 *
 * 同 `shouldKeepCompanionAlive()` 嘅分別：輪詢（keepAlive）唔包括 localhost dev
 * （避免 dev 無謂輪詢），但 UI 顯示要包埋 localhost，否則本機開發測唔到張卡。
 */
export function shouldShowCompanionUi(): boolean {
  if (typeof window === "undefined") return false;
  return shouldAutoDiscoverCompanion() || hasCompanionUrlParam();
}

// ─────────────────────────────────────────────────────────────
// 低階 fetch
// ─────────────────────────────────────────────────────────────

async function companionFetch(
  url: string,
  path: string,
  opts: RequestInit = {},
): Promise<Response> {
  const token = getCompanionToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers as Record<string, string>),
  };
  if (token) headers["X-POS-Token"] = token;
  return fetch(`${url}${path}`, { ...opts, headers, cache: "no-store" });
}

async function companionJson<T = unknown>(
  url: string,
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const r = await companionFetch(url, path, opts);
  if (!r.ok) throw new Error(`Companion ${path} → HTTP ${r.status}`);
  return (await r.json()) as T;
}

// ─────────────────────────────────────────────────────────────
// 連線探測 / 自動配對
// ─────────────────────────────────────────────────────────────

export interface CompanionProbeResult {
  ok: boolean;
  version?: string;
  error?: string;
}

/**
 * 探測指定（或當前已配對）Companion 地址是否可用。
 *
 * ⚠️ 2026-09-02：`urlOverride` 留空 **且** 從未配對過時，以前會無條件 fallback 去
 * `COMPANION_DEFAULT_URL`（即 `http://127.0.0.1:9311`）並真係打過去。純 website 上冇
 * Companion，結果係永遠 `ERR_CONNECTION_REFUSED`。所以呢個 fallback 而家要過
 * `shouldAutoDiscoverCompanion()` 呢道閘；過唔到就直接當離線，一啲 request 都唔好掟。
 *
 * 有明確 `urlOverride`（設定頁「測試連線」、`?companion=` 帶入嘅地址）一律照探 ——
 * 呢啲係用家主動要求嘅，唔屬於「主動搵」。
 */
export async function probeCompanion(urlOverride?: string): Promise<CompanionProbeResult> {
  const stored = getCompanionUrl();
  let url = urlOverride ?? stored;
  if (!url && !shouldAutoDiscoverCompanion()) {
    cachedAvailable = false;
    return { ok: false, error: "未設定 Companion 地址" };
  }
  url = url || COMPANION_DEFAULT_URL;
  try {
    const j = (await companionJson<{ ok?: boolean; version?: string }>(url, "/api/health")) as {
      ok?: boolean;
      version?: string;
    };
    if (j && (j.ok || j.version)) {
      cachedAvailable = true;
      cachedVersion = j.version || cachedVersion;
      if (!getCompanionUrl()) setCompanionUrl(url);
      return { ok: true, version: cachedVersion };
    }
    cachedAvailable = false;
    return { ok: false, error: "Companion 回應唔正常" };
  } catch (e) {
    cachedAvailable = false;
    return { ok: false, error: e instanceof Error ? e.message : "Companion 離線" };
  }
}

/**
 * 零配置自動配對：優先 URL ?companion= → 已儲存地址 → 預設 loopback 探測。
 * 只要預設地址可連，就寫入 localStorage（token 留空），之後即用。
 */
export async function tryAutoPairCompanion(): Promise<boolean> {
  if (typeof window === "undefined") return false;

  // 1) URL 參數（由桌面 Electron / 啟動器帶入）
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("companion");
    if (fromUrl) {
      const res = await probeCompanion(fromUrl.trim());
      if (res.ok) {
        setCompanionUrl(fromUrl.trim());
        return true;
      }
    }
  } catch {
    // ignore
  }

  // 2) 已儲存地址
  const stored = getCompanionUrl();
  if (stored) {
    const res = await probeCompanion(stored);
    return res.ok;
  }

  // 3) 預設 loopback 探測（零配置）
  //    只喺「有理由相信本機有 Companion」時先探（見 shouldAutoDiscoverCompanion 註解）。
  //    純 website 上從來冇配對過 → 直接返 false，唔好每 2.5 秒掟一次 ERR_CONNECTION_REFUSED。
  if (!shouldAutoDiscoverCompanion()) return false;
  const res = await probeCompanion(COMPANION_DEFAULT_URL);
  if (res.ok) {
    setCompanionUrl(COMPANION_DEFAULT_URL);
    setCompanionToken("");
    return true;
  }
  return false;
}

/** 取得可用性（recheck=true 時重新探測） */
export async function isCompanionAvailable(recheck = false): Promise<boolean> {
  if (recheck) {
    const res = await probeCompanion();
    return res.ok;
  }
  return cachedAvailable;
}

/** 畫面「測試連線」按鈕用：探測當前已配對地址 */
export async function testCompanionConnection(): Promise<CompanionProbeResult> {
  const url = getCompanionUrl();
  if (!url) return { ok: false, error: "未配對 Companion（地址空白）" };
  return probeCompanion(url);
}

// ─────────────────────────────────────────────────────────────
// 健康檢查輪詢（**按執行環境兩分**）
//
//   ┌────────────────────────────────┬────────────────────────────────┐
//   │ Companion 環境（保留輪詢）     │ 純 Website 環境（停用輪詢）    │
//   ├────────────────────────────────┼────────────────────────────────┤
//   │ · PC Desktop App（Electron）   │ · 瀏覽器自己開網站              │
//   │ · Android Native App（APK）    │   （Vercel HTTPS）              │
//   │ · `?companion=<url>` 帶入分頁  │ · PWA standalone（Home Screen） │
//   │   （桌面 Companion「一鍵       │ · 本機 dev（localhost）         │
//   │     開 POS」嘅分頁）           │                                │
//   ├────────────────────────────────┼────────────────────────────────┤
//   │ ✅ mount 探一次真實狀態         │ ❌ 完全唔探、唔輪詢              │
//   │ ✅ 15 秒週期性 /api/health      │ ❌ 連預設地址都唔掟              │
//   └────────────────────────────────┴────────────────────────────────┘
//
// 純 Website 環境點解要停用：
//   · 呢類環境喺用家嘅日常瀏覽器，根本連唔到本機端點（loopback 127.0.0.1:9311 唔存在）
//   · 每次輪詢都係 ERR_CONNECTION_REFUSED
//   · console + Network tab 永久洗錯誤訊息
//   · 完全冇實質意義（探極都係零）
//
// Companion 環境點解要保留：
//   · desktop agent 喺 loopback 住，web view 探得到
//   · 需要持續確認 native frame ↔ website 條橋仲喺唔喺度
//   · 例如 desktop agent 被關掉／升級重啟，畫面要自動由「已連線」轉「未連線」
//
// **單一真源** = `shouldKeepCompanionAlive()`（同 `dispatch.ts` / `salon/print.ts`
// Companion 通道嘅 gate 用同一個函式，保證行為一致）。
// 純 Website 環境一個 /api/health 都唔掟；Companion 環境 mount 即探、15 秒一輪。
// ─────────────────────────────────────────────────────────────

export interface CompanionAvailability {
  available: boolean;
  version: string;
}

/** 輪詢間隔：15 秒。夠快反映 agent 斷線，又唔會洗 network。 */
const COMPANION_HEALTH_POLL_MS = 15_000;

const availabilityListeners = new Set<(s: CompanionAvailability) => void>();
let healthPollTimer: ReturnType<typeof setInterval> | null = null;
let lastNotified: CompanionAvailability = { available: false, version: "" };

function snapshotAvailability(): CompanionAvailability {
  return { available: cachedAvailable, version: cachedVersion };
}

function notifyAvailability(next: CompanionAvailability) {
  if (next.available === lastNotified.available && next.version === lastNotified.version) return;
  lastNotified = next;
  for (const fn of availabilityListeners) fn(next);
}

async function pollCompanionHealth(): Promise<void> {
  // 分頁喺背景就唔好白白探（減省無謂請求）
  if (typeof document !== "undefined" && document.hidden) return;
  const res = await probeCompanion();
  notifyAvailability({
    available: res.ok,
    version: res.ok ? res.version ?? cachedVersion : "",
  });
}

function startHealthPolling(): void {
  if (healthPollTimer !== null) return;
  healthPollTimer = setInterval(() => {
    void pollCompanionHealth();
  }, COMPANION_HEALTH_POLL_MS);
}

function stopHealthPolling(): void {
  if (healthPollTimer === null) return;
  clearInterval(healthPollTimer);
  healthPollTimer = null;
}

/**
 * 訂閱 Companion 連線狀態（畫面用，例如 CompanionStatusCard 嗰粒燈）。
 *
 * **兩種環境嘅明確分流**（清晰、容易維護）：
 *   · 純 Website 環境（瀏覽器開網站、PWA standalone、localhost dev）
 *     → 訂閱當下畀一次目前 cached 狀態（`{available:false}`），之後**完全唔探、唔輪詢**。
 *       一個 `/api/health` request 都唔掟 —— 純 Website 根本連唔到本機端點。
 *   · Companion 環境（PC Desktop App / Android Native App / `?companion=` URL 分頁）
 *     → 訂閱當下畀一次 cached 狀態，**即探一次真實狀態**，**起 15 秒週期輪詢**持續
 *       確認 native frame ↔ website 條橋仲喺唔喺度（例如 agent 被關掉／升級重啟時
 *       畫面自動由「已連線」轉「未連線」）。
 *
 * 用嚟決定嘅單一函式：`shouldKeepCompanionAlive()`（同 `dispatch.ts` / `salon/print.ts`
 * 嘅 Companion 通道 gate 共用一個 function，保證兩邊行為一致）。
 *
 * @returns 取消訂閱函式（最後一個 listener 走咗會順手停輪詢器）
 */
export function subscribeCompanionAvailability(
  fn: (s: CompanionAvailability) => void,
): () => void {
  if (typeof window === "undefined") return () => {};

  availabilityListeners.add(fn);
  fn(snapshotAvailability());

  // 純 Website 環境：early-return，唔探、唔輪詢。
  // 連 cached 狀態都已經畀咗 listener（`fn(snapshotAvailability())` 上面），UI 即時見到
  // 「未連線（代理未啟動）」—— 唔需要任何網絡請求。
  if (!shouldKeepCompanionAlive()) {
    return () => {
      availabilityListeners.delete(fn);
      // 冇起過 polling timer，所以唔需要 stopHealthPolling()
    };
  }

  // Companion 環境：即刻探一次真實狀態 + 起 15 秒週期輪詢。
  void pollCompanionHealth();
  startHealthPolling();

  return () => {
    availabilityListeners.delete(fn);
    if (availabilityListeners.size === 0) stopHealthPolling();
  };
}

// ─────────────────────────────────────────────────────────────
// LAN 連線探測（Meituan 式 wizard Step 3 用）
// ─────────────────────────────────────────────────────────────

export interface ProbeLanResult {
  ok: boolean;
  error?: string;
}

/**
 * 經 Companion 代理探測 LAN 打印機 TCP :9100 是否可連。
 * 用於 Printer Wizard Step 3「測試連接」按鈕。
 */
export async function probeLan(ip: string, port = 9100): Promise<ProbeLanResult> {
  const url = getCompanionUrl();
  if (!url) {
    // Companion 離線時只做 IP 格式驗證
    const validIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(ip.trim());
    return { ok: validIp, error: validIp ? undefined : "IP 格式不正確" };
  }
  try {
    const r = await companionFetch(url, "/api/probe-lan", {
      method: "POST",
      body: JSON.stringify({ ip: ip.trim(), port }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return { ok: Boolean(j.ok), error: j.error };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "探測失敗" };
  }
}

// ─────────────────────────────────────────────────────────────
// 發送 PrintJob
// ─────────────────────────────────────────────────────────────

export async function sendJobToCompanion(
  job: PrintJob,
  printer: DevicePrinterConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = getCompanionUrl();
  if (!url) return { ok: false, error: "未配對 Companion 代理（http://127.0.0.1:9311 未啟動）" };
  try {
    const r = await companionFetch(url, "/api/print", {
      method: "POST",
      body: JSON.stringify({ job, printer }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (r.ok && (j.ok || r.status === 200)) return { ok: true };
    return { ok: false, error: j.error || `Companion 回應 HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "發送到 Companion 失敗" };
  }
}

// ─────────────────────────────────────────────────────────────
// 打印機發現（Meituan 式：商家唔使手填 VID/PID）
// ─────────────────────────────────────────────────────────────

export interface PrinterCandidate {
  source: "lan" | "usb" | "bluetooth";
  name: string;
  connectionType: "lan" | "usb" | "bluetooth";
  ipAddress?: string;
  lanPort?: number;
  usbVendorId?: string;
  usbProductId?: string;
  bluetoothName?: string;
  bluetoothAddress?: string;
  model?: string;
  charset?: string;
  paperSize?: string;
  /** 中文（Kanji）倍大指令：商頌 POS-80 等機要用 GS ! n；標準 ESC/POS 機用 FS ! n。
   *  Companion 由 VID/PID 對照型號表或 USB Printer Class 通用 fallback 回傳；web 直接採用。 */
  kanjiEnlarge?: "FS!" | "GS!";
}

interface DiscoveredLanPrinter {
  name?: string;
  ip?: string;
  port?: number;
  type?: string;
}

interface UsbPrinterRow {
  vendorId?: string | number;
  productId?: string | number;
  brand?: string;
  model?: string;
  charset?: string;
  paperSize?: string;
  kanjiEnlarge?: "FS!" | "GS!";
  recognized?: boolean;
}

/** mDNS 掃區網 LAN ESC/POS 機（:9100） */
export async function discoverCompanionLanPrinters(): Promise<PrinterCandidate[]> {
  const url = getCompanionUrl();
  if (!url) return [];
  try {
    const j = (await companionJson<{ ok?: boolean; printers?: DiscoveredLanPrinter[] }>(
      url,
      "/api/discover",
    )) as { ok?: boolean; printers?: DiscoveredLanPrinter[] };
    return (j.printers ?? []).map((p) => ({
      source: "lan",
      name: p.name || `LAN 打印機 ${p.ip ?? ""}`,
      connectionType: "lan",
      ipAddress: p.ip,
      lanPort: p.port || 9100,
    }));
  } catch {
    return [];
  }
}

/** node-usb 枚舉 USB 打印機，按 VID/PID 對照型號表（商家唔使手填） */
export async function enumerateCompanionUsbPrinters(): Promise<PrinterCandidate[]> {
  const url = getCompanionUrl();
  if (!url) return [];
  try {
    const j = (await companionJson<{ ok?: boolean; printers?: UsbPrinterRow[]; note?: string }>(
      url,
      "/api/usb",
    )) as { ok?: boolean; printers?: UsbPrinterRow[]; note?: string };
    return (j.printers ?? []).map((p) => {
      const vid = toHexId(p.vendorId);
      const pid = toHexId(p.productId);
      const name = p.model || p.brand || `USB 打印機 ${vid}`;
      return {
        source: "usb",
        name,
        connectionType: "usb",
        usbVendorId: vid,
        usbProductId: pid,
        model: p.model,
        charset: p.charset,
        paperSize: p.paperSize,
        kanjiEnlarge: p.kanjiEnlarge,
      } as PrinterCandidate;
    });
  } catch {
    return [];
  }
}

/** 合併 LAN + USB 清單（藍牙由商家手動 COM 名輸入） */
export async function listCompanionPrinters(): Promise<PrinterCandidate[]> {
  const url = getCompanionUrl();
  if (!url) return [];
  try {
    const j = (await companionJson<{
      ok?: boolean;
      lan?: DiscoveredLanPrinter[];
      usb?: UsbPrinterRow[];
    }>(url, "/api/printers")) as { ok?: boolean; lan?: DiscoveredLanPrinter[]; usb?: UsbPrinterRow[] };
    const lan: PrinterCandidate[] = (j.lan ?? []).map((p) => ({
      source: "lan",
      name: p.name || `LAN 打印機 ${p.ip ?? ""}`,
      connectionType: "lan",
      ipAddress: p.ip,
      lanPort: p.port || 9100,
    }));
    const usb: PrinterCandidate[] = (j.usb ?? []).map((p) => {
      const vid = toHexId(p.vendorId);
      const pid = toHexId(p.productId);
      return {
        source: "usb",
        name: p.model || p.brand || `USB 打印機 ${vid}`,
        connectionType: "usb",
        usbVendorId: vid,
        usbProductId: pid,
        model: p.model,
        charset: p.charset,
        paperSize: p.paperSize,
        kanjiEnlarge: p.kanjiEnlarge,
      } as PrinterCandidate;
    });
    return [...lan, ...usb];
  } catch {
    return [];
  }
}

interface BluetoothPortRow {
  path?: string;
  friendlyName?: string;
  pnpId?: string;
  manufacturer?: string;
}

/** 列舉藍牙（SPP）序列埠，俾「手動+ 藍牙打印機」從清單揀（Companion 經 serialport 列，網頁本身列唔到） */
export async function enumerateCompanionBluetoothDevices(): Promise<PrinterCandidate[]> {
  const url = getCompanionUrl();
  if (!url) return [];
  try {
    const j = (await companionJson<{ ok?: boolean; ports?: BluetoothPortRow[] }>(
      url,
      "/api/bluetooth",
    )) as { ok?: boolean; ports?: BluetoothPortRow[] };
    return (j.ports ?? []).map((p) => ({
      source: "bluetooth",
      name: p.friendlyName || p.path || "藍牙打印機",
      connectionType: "bluetooth",
      bluetoothName: p.path || "",
    }));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// 共用路由 helpers（取代 hub.ts 同名函式）
// ─────────────────────────────────────────────────────────────

/**
 * 新 PrintJob 嘅初始狀態。
 * 一律回 "pending"，交畀背景 flush worker（dispatch.ts）按 native / companion / relay 通道派發；
 * 無可用通道時 worker 會維持 pending 等下次 flush。
 *
 * ⚠️ 唔可以樂觀標 "sent"：flushPendingPrintJobs 只處理 status==="pending" 嘅 job，
 * 如果呢度回 "sent"，worker 會 skip 呢啲 job，令真實落單 / 收據 / 退款嘅打印永遠唔會派發
 * （打印靜默、Print Center 全部顯示「已發送」但張紙唔出）。見 hub.ts 同名函式註解。
 */
export function resolvePrintJobStatus(_networkOnline: boolean): PrintJob["status"] {
  return "pending";
}

/** 按 PrintJob.printerGroup 由 config.printers 搵出目標打印機（單一真源） */
export function resolveJobPrinter(job: PrintJob): DevicePrinterConfig | undefined {
  const printers = (loadDeviceConfig() ?? defaultDeviceConfig).printers;
  // 1) 直接用 job 記錄嘅 printerId
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
