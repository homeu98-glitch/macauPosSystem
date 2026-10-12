"use client";

import { Component, ErrorInfo, ReactNode } from "react";

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  hasError: boolean;
  message: string;
  detail: string;
  /** true = 顯示「正在自動恢復」過渡畫面（自癒 reload 進行中） */
  autoHealing: boolean;
  /** true = 已複製錯誤詳情（按鈕短暫反饋） */
  copied: boolean;
  /** true = 剪貼板不可用，改 render 純文字方塊俾人手複製 */
  copyFallback: boolean;
};

/**
 * 🔴 2026-10-12（實機影片診斷）：「可自癒」錯誤模式。
 *
 * 場景：瀏覽器擴充功能（翻譯／比價／拼寫檢查類）喺 React 載入前或 commit
 * 期間改動 DOM，造成兩類錯——
 *  · `Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.`
 *    （React commit 想移除節點，已被擴充搬走／刪走）
 *  · React #418/#419/#423「Hydration failed ... didn't match」
 *    （server 出嘅 HTML 文字節點被擴充翻譯／改寫）
 *
 * 呢兩類錯**重新載入頁面大概率就好**（重新走一次 hydration／commit，
 * 擴充唔一定再改）。所以：第一次遇到 → 自動 reload 一次（**唔清任何本機
 * 資料**）；再崩先至彈完整修復頁。
 *
 * ⚠️ 限流：同一個 tab session 只自動 reload 一次（sessionStorage 記 ts，
 * 60 秒內 reload 過就唔再自動），防止擴充持續作妖造成死循環刷新。
 */
const SELF_HEAL_ERROR_PATTERNS = [
  "removeChild",
  "insertBefore",
  "Hydration failed",
  "didn't match",
  "Minified React error #418",
  "Minified React error #419",
  "Minified React error #423",
];

const AUTO_RELOAD_KEY = "macau-pos/crash-auto-reload";
const AUTO_RELOAD_COOLDOWN_MS = 60_000;

/** 純判斷（唔碰 storage）：呢隻錯屬唔屬於「重新載入就好」類。 */
function isSelfHealableError(input: unknown): boolean {
  const message =
    input instanceof Error
      ? `${input.message}\n${input.stack ?? ""}`
      : typeof input === "string"
        ? input
        : "";
  if (!message) return false;
  return SELF_HEAL_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * 消耗一次自動 reload 預算。返回 false = 60 秒內已經自動 reload 過
 *（或 sessionStorage 唔可用）→ 唔再自動，轉交完整修復頁。
 */
function consumeAutoReloadBudget(): boolean {
  try {
    const raw = window.sessionStorage.getItem(AUTO_RELOAD_KEY);
    const last = raw ? Number(raw) : 0;
    if (Number.isFinite(last) && last > 0 && Date.now() - last < AUTO_RELOAD_COOLDOWN_MS) {
      return false;
    }
    window.sessionStorage.setItem(AUTO_RELOAD_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

function normalizeError(input: unknown): { message: string; detail: string } {
  if (input instanceof Error) {
    return {
      message: input.message || "前端初始化失敗",
      detail: input.stack ?? "",
    };
  }

  if (typeof input === "string") {
    return { message: input, detail: "" };
  }

  return {
    message: "前端初始化失敗",
    detail: "",
  };
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    hasError: false,
    message: "",
    detail: "",
    autoHealing: false,
    copied: false,
    copyFallback: false,
  };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    const normalized = normalizeError(error);
    return {
      hasError: true,
      message: normalized.message,
      detail: normalized.detail,
      autoHealing: isSelfHealableError(error),
      copied: false,
      copyFallback: false,
    };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    // 可自癒錯誤（removeChild / hydration 類）：自動 reload 一次，唔清資料。
    // 預算已用完（60 秒內 reload 過）→ 轉完整修復頁。
    if (this.state.autoHealing && consumeAutoReloadBudget()) {
      window.location.reload();
      return;
    }

    const normalized = normalizeError(error);
    this.setState({
      hasError: true,
      message: normalized.message,
      detail: normalized.detail || errorInfo.componentStack || "",
      autoHealing: false,
    });
  }

  componentDidMount() {
    window.addEventListener("error", this.handleWindowError);
    window.addEventListener("unhandledrejection", this.handleUnhandledRejection);
  }

  componentWillUnmount() {
    window.removeEventListener("error", this.handleWindowError);
    window.removeEventListener("unhandledrejection", this.handleUnhandledRejection);
  }

  handleWindowError = (event: ErrorEvent) => {
    if (this.state.hasError) return;
    // removeChild 類運行時錯先試自癒（同 render 期錯同一策略）
    if (isSelfHealableError(event.error ?? event.message) && consumeAutoReloadBudget()) {
      this.setState({ autoHealing: true });
      window.location.reload();
      return;
    }
    const normalized = normalizeError(event.error ?? event.message);
    this.setState({
      hasError: true,
      message: normalized.message,
      detail: normalized.detail,
    });
  };

  /**
   * 🔴 2026-09-15：`unhandledrejection` **刻意唔再觸發全屏修復畫面**（改為只 log）。
   *
   * 點解要改：呢個 app 有大量 fire-and-forget 非同步工作（同步 flush、打印派發、
   * Realtime 重連、背景對賬守護…），佢哋 reject 之後**本身已經有自己嘅處理路徑**
   * （保留 pending、入 outbox 遲啲重試、退避重連）。若將任何一個未 catch 嘅 promise
   * rejection 都升級做全屏「頁面修復模式」，收銀員就會因為**一次無害嘅網絡失敗**
   * 而被踢出收銀畫面 —— 比原本（只 console warn）**更差**，屬回歸。
   *
   * 所以：只 log，唔改 state（＝維持掛載前嘅既有行為）。
   * render 期錯誤（`getDerivedStateFromError`）同 window error
   *（`handleWindowError`）會觸發畫面——但 2026-10-12 起，屬「可自癒」類
   *（removeChild / hydration mismatch，多由瀏覽器擴充改 DOM 引起）會先
   * 自動 reload 一次，只有再崩先至顯示完整修復頁。
   */
  handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    console.error("[app-error-boundary] 未處理嘅 promise rejection（唔會中斷畫面）：", event.reason);
  };

  clearLocalDataAndReload = async () => {
    const confirmed = window.confirm(
      [
        "「清除本機快取並重開」會刪除：",
        "· 所有本機暫存（未落單嘅購物車、離線佇列）",
        "· service worker 快取",
        "並且會返回登入頁要重新登入。",
        "",
        "一般白屏撳「重新載入頁面」就得（唔會丟資料）。",
        "確定仍要清除嗎？",
      ].join("\n")
    );
    if (!confirmed) return;

    try {
      const keysToDelete: string[] = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key?.startsWith("macau-pos/")) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach((key) => window.localStorage.removeItem(key));
    } catch {
      // ignore
    }

    try {
      if ("caches" in window) {
        const cacheKeys = await caches.keys();
        await Promise.all(cacheKeys.map((key) => caches.delete(key)));
      }
    } catch {
      // ignore
    }

    try {
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
      }
    } catch {
      // ignore
    }

    window.location.replace(`/login?recovery=${Date.now()}`);
  };

  reloadPage = () => {
    window.location.reload();
  };

  goToLogin = () => {
    window.location.replace(`/login?from=crash&ts=${Date.now()}`);
  };

  buildErrorReport = () => {
    return [
      `[頁面修復模式] ${new Date().toISOString()}`,
      `URL: ${window.location.href}`,
      `UA: ${navigator.userAgent}`,
      "",
      "── 錯誤摘要 ──",
      this.state.message || "未知錯誤",
      "",
      "── 詳細資訊 ──",
      this.state.detail || "(空)",
    ].join("\n");
  };

  copyErrorDetail = async () => {
    try {
      await navigator.clipboard.writeText(this.buildErrorReport());
      this.setState({ copied: true, copyFallback: false });
    } catch {
      // 剪貼板唔可用（非 HTTPS／無權限）→ 顯示純文字方塊俾人手複製
      this.setState({ copyFallback: true, copied: false });
    }
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    // 自癒過渡畫面：自動 reload 已觸發，呢個畫面只會出現極短時間
    if (this.state.autoHealing) {
      return (
        <div className="grid min-h-screen place-items-center bg-slate-100 px-6 text-center">
          <div>
            <div
              aria-label="正在自動恢復"
              className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-slate-300 border-t-slate-900"
              role="status"
            />
            <div className="mt-4 text-base font-semibold text-slate-900">正在自動恢復…</div>
            <div className="mt-2 text-sm text-slate-500">
              偵測到暫時性畫面錯誤，系統為你自動重新載入（唔會刪除任何資料）。
            </div>
            <button
              className="mt-5 rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white"
              onClick={this.reloadPage}
              type="button"
            >
              立即重新載入
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="grid min-h-screen place-items-center bg-slate-100 px-4 py-8">
        <div className="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-xl">
          <div className="text-sm font-semibold tracking-widest text-red-600">頁面修復模式</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">偵測到前端初始化失敗</div>
          <div className="mt-3 text-sm text-slate-600">
            系統已攔截白屏錯誤。請先撳「重新載入頁面」——呢類錯誤多數重新載入就恢復，而且唔會丟資料。
          </div>

          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
            <div className="font-semibold text-slate-900">錯誤摘要</div>
            <div className="mt-2 break-words">{this.state.message || "未知錯誤"}</div>
            {this.state.detail ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs font-semibold text-slate-500">查看詳細資訊</summary>
                <pre className="mt-2 overflow-auto whitespace-pre-wrap rounded-2xl bg-slate-950 p-3 text-xs text-slate-200">
                  {this.state.detail}
                </pre>
              </details>
            ) : null}
            {this.state.copyFallback ? (
              <textarea
                className="mt-3 h-32 w-full rounded-2xl border border-slate-200 bg-white p-2 text-xs"
                onFocus={(event) => event.currentTarget.select()}
                readOnly
                value={this.buildErrorReport()}
              />
            ) : null}
          </div>

          <div className="mt-5 grid gap-2">
            <button
              className="rounded-2xl bg-slate-900 px-4 py-3 text-base font-semibold text-white"
              onClick={this.reloadPage}
              type="button"
            >
              重新載入頁面（先試呢個）
            </button>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                className="rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                onClick={() => void this.copyErrorDetail()}
                type="button"
              >
                {this.state.copied ? "已複製" : "複製錯誤詳情"}
              </button>
              <button
                className="rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                onClick={this.goToLogin}
                type="button"
              >
                返回登入頁
              </button>
            </div>
            <button
              className="mt-1 rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-red-600 shadow-sm ring-1 ring-red-200"
              onClick={() => void this.clearLocalDataAndReload()}
              type="button"
            >
              清除本機快取並重開（會刪除未落單資料，唔好亂撳）
            </button>
          </div>
        </div>
      </div>
    );
  }
}
