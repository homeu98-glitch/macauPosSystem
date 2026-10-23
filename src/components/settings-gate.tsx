"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { loadOperatorSession, operatorCanOpenSettings } from "@/lib/pos/operator-session";
import { loadAuthSession } from "@/lib/storage";

/**
 * 設定頁閘（2026-10-23）—— 操作員冇「設備／菜單設定」權限時，唔畀入 `/settings`。
 *
 * ## 為何要另開一層 gate，而唔係喺 `DeviceSettings` 入面判斷
 *
 * `device-settings.tsx` 成 4,400 行、十幾個分頁交錯 render；喺入面加一個
 * 條件包住全部內容嘅風險遠高於收益（好易漏一個分頁 ⇒ 權限形同虛設）。
 * 喺頁面外圍擋一次，簡單、唔會影響現有版面。
 *
 * ⚠️ 呢個只係 UX。真正防線仍然係伺服器（寫入需要 `posDeviceToken`）。
 *
 * ⚠️ 首次 render 一律**唔出任何嘢**（`allowed === null`）：server render 冇
 *    localStorage，如果照 render children 就會 hydration mismatch。
 */
export function SettingsGate({ children }: { children: ReactNode }) {
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    const session = loadAuthSession();
    const operator = loadOperatorSession(session?.merchantId ?? null);
    setAllowed(operatorCanOpenSettings(operator));
  }, []);

  if (allowed === null) {
    return <div className="min-h-[100dvh] bg-slate-100" />;
  }

  if (!allowed) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-slate-100 px-4">
        <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-5">
          <div className="text-lg font-semibold text-slate-900">冇設定權限</div>
          <div className="mt-2 text-sm leading-relaxed text-slate-600">
            而家簽到嘅員工冇「設備／菜單設定」權限。如需修改打印機、菜單或員工權限，
            請店長或店主簽到後再入設定。
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              className="inline-flex min-h-[44px] items-center rounded-full bg-orange-500 px-5 text-sm font-semibold text-white"
              href="/operator"
            >
              切換操作員
            </Link>
            <Link
              className="inline-flex min-h-[44px] items-center rounded-full bg-slate-100 px-5 text-sm font-semibold text-slate-700"
              href="/pos"
            >
              返回收銀台
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
