import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { ClientOnly } from "@/components/client-only";
import { AppErrorBoundary } from "@/components/app-error-boundary";
import { IosFocusHelper } from "@/components/ios-focus-helper";
import { LangProvider } from "@/components/lang-provider";
import { PosSyncFlushWorker } from "@/components/pos-sync-flush-worker";
import { PwaRegister } from "@/components/pwa-register";
import { PrintFlushWorker } from "@/components/print-flush-worker";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Macau POS System",
  description: "澳門餐飲 POS 第一版 MVP",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Macau POS",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  /*
   * 🔴 唔可以加 `maximumScale: 1` / `userScalable: false`（2026-09-14 商家實紙）。
   *
   * 症狀：iPad 上撳任何 text 欄位 → 焦點有到（focus ring + 游標 + iOS 系統文字工具列），
   * 但系統鍵盤完全唔彈；同一部機開 Ledger 網頁（membership-uat.macau-tech.com）**正常**。
   *
   * 兩者實測差異就係呢兩行：Ledger 只有 `width / initial-scale / viewport-fit`，
   * 冇 `user-scalable=no`。iOS 喺「鍵盤彈出」時要做一次視口重算（visual viewport resize
   * → 知道真係要有鍵盤空間）；`user-scalable=no` 會鎖死視口重繪，令嗰步失敗 ⇒ 鍵盤唔彈。
   *
   * 副作用說明：唔再禁止縮放之後，< 16px 字級嘅欄位會被 iOS 自動放大——所以 globals.css
   * 加咗 `@media (pointer: coarse) { input/textarea/select { font-size: 16px } }` 令佢唔觸發放大。
   */
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-Hant"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="h-full overflow-hidden flex flex-col">
        <ClientOnly
          fallback={
            <div className="grid min-h-screen place-items-center bg-slate-100 px-6 text-center">
              <div>
                <div className="text-base font-semibold text-slate-900">正在載入頁面…</div>
                <div className="mt-2 text-sm text-slate-500">請稍候</div>
              </div>
            </div>
          }
        >
          <PwaRegister />
          <PrintFlushWorker />
          <PosSyncFlushWorker />
          <IosFocusHelper />
          {/*
            2026-09-15 加固：掛上錯誤邊界。
            以前 `app-error-boundary.tsx` **全 repo 零 import**（死碼），所以 `/`、`/orders`、
            `/prints`、`/kitchen` 等全部冇錯誤邊界 —— 任何 render 期例外 = 白屏，
            而且嗰個元件提供嘅三個自救入口（重新載入 / 清快取 / 返登入頁）全部叫唔到。
            ⚠️ 只包 `children`，**唔包上面 4 個 worker**：worker 係背景任務，
            出錯唔應該令畫面變全屏修復模式。
          */}
          {/*
            2026-10-07 UI 語言（第 1 層顯示文案）—— `LangProvider` 刻意喺
            `<AppErrorBoundary>` **之外**（即係包住錯誤邊界）：

            · 喺 `<ClientOnly>` 之內 ⇒ server 階段淨係出靜態 fallback，client 首次
              render 就讀到本機語言，**唔會有首次閃爍**（ClientOnly 嘅
              `getServerSnapshot()` 回 false，server 永遠唔 render children）。
            · 喺 `<AppErrorBoundary>` 之外 ⇒ 萬一 Provider 自己出錯（例：本機儲存
              讀到垃圾值），錯誤邊界仍然顯示到「重新載入／清快取／返登入頁」三個自救
              入口。如果包咗喺入面，Provider 同 children 一齊死，畫面就永久白屏。
            · 喺 4 個 background worker 之外 ⇒ worker 出錯唔應該令畫面變修復模式。

            ⚠️ `useLang()` 本身**唔會**靜靜 fallback（搵唔到 Provider 會 throw），
            所以「Provider 掛錯」一定會被上面嘅錯誤邊界捉到，而唔係靜靜顯示中文。
          */}
          <LangProvider>
            <AppErrorBoundary>{children}</AppErrorBoundary>
          </LangProvider>
        </ClientOnly>
      </body>
    </html>
  );
}
