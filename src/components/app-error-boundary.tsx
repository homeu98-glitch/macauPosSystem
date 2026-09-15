"use client";

import { Component, ErrorInfo, ReactNode } from "react";

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  hasError: boolean;
  message: string;
  detail: string;
};

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
  };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    const normalized = normalizeError(error);
    return {
      hasError: true,
      message: normalized.message,
      detail: normalized.detail,
    };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    const normalized = normalizeError(error);
    this.setState({
      hasError: true,
      message: normalized.message,
      detail: normalized.detail || errorInfo.componentStack || "",
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
   * 真正需要攔截嘅係 **render 期錯誤**（`getDerivedStateFromError`）
   * 同 **window error**（`handleWindowError`）—— 嗰兩條路照舊觸發修復畫面。
   */
  handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    console.error("[app-error-boundary] 未處理嘅 promise rejection（唔會中斷畫面）：", event.reason);
  };

  clearLocalDataAndReload = async () => {
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

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="grid min-h-screen place-items-center bg-slate-100 px-4 py-8">
        <div className="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-xl">
          <div className="text-sm font-semibold tracking-widest text-red-600">頁面修復模式</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">偵測到前端初始化失敗</div>
          <div className="mt-3 text-sm text-slate-600">
            系統已攔截白屏錯誤。你可以先重新載入，如果仍有問題，再清除本機快取與 service worker 後重開。
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
          </div>

          <div className="mt-5 grid gap-2 sm:grid-cols-2">
            <button
              className="rounded-2xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white"
              onClick={this.reloadPage}
              type="button"
            >
              重新載入頁面
            </button>
            <button
              className="rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
              onClick={this.goToLogin}
              type="button"
            >
              返回登入頁
            </button>
            <button
              className="sm:col-span-2 rounded-2xl bg-red-600 px-4 py-3 text-sm font-semibold text-white"
              onClick={() => void this.clearLocalDataAndReload()}
              type="button"
            >
              清除本機快取並重開
            </button>
          </div>
        </div>
      </div>
    );
  }
}
