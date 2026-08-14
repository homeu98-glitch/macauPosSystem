"use client";

import { useEffect } from "react";

// Next.js 段級 error boundary：包住成個 /salon/* 段。
// 任務渲染出錯顯示 fallback + 重試，唔使 reload 成個 app。
// 只覆蓋 salon 段，唔影響餐飲（尊重「不動餐飲」）。

export default function SalonError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 本地 only：記 console，不送後端（salon 尚無錯誤上報通道）
    console.error("[salon] 路由錯誤:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="text-2xl font-semibold text-slate-900">美容院模組出錯</div>
      <p className="max-w-md text-sm text-slate-600">
        頁面載入時發生錯誤，你可以重試；本地資料不會遺失。
      </p>
      {error?.message ? (
        <p className="max-w-md break-words text-xs text-slate-400">{error.message}</p>
      ) : null}
      <button
        type="button"
        className="rounded-2xl bg-violet-500 px-5 py-2.5 text-sm font-semibold text-white"
        onClick={() => reset()}
      >
        重試
      </button>
    </div>
  );
}
