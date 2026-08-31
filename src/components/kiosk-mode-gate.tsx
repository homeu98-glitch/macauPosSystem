"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { loadKioskMode } from "@/lib/kiosk-order";

/**
 * 裝置模式分流（docs/87 §1）：掛喺收銀台首頁 `/` 最外層。
 *
 * 呢部機開咗 kiosk mode → 直接跳去 `/order`（客人自助點餐介面），唔 render 收銀台。
 * 冇開 → 正常 render 收銀台 (`children`)。
 *
 * 點解要喺 client effect 度做：kiosk mode 係 localStorage 旗標，server 睇唔到，
 * 所以第一拍先 render `null`（等 localStorage 讀到），避免 hydration mismatch
 * 同「收銀台 flash 一下先跳走」。
 */
export function KioskModeGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<"checking" | "kiosk" | "pos">("checking");

  useEffect(() => {
    if (loadKioskMode()) {
      setState("kiosk");
      router.replace("/order");
      return;
    }
    setState("pos");
  }, [router]);

  if (state === "checking") {
    return (
      <main className="flex h-[100dvh] items-center justify-center bg-slate-100 text-sm text-slate-400">
        載入中…
      </main>
    );
  }
  if (state === "kiosk") {
    return (
      <main className="flex h-[100dvh] items-center justify-center bg-slate-100 text-sm text-slate-400">
        正在進入自助點餐模式…
      </main>
    );
  }
  return <>{children}</>;
}
