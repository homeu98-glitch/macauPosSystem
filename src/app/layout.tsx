import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { ClientOnly } from "@/components/client-only";
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
  maximumScale: 1,
  userScalable: false,
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
          {children}
        </ClientOnly>
      </body>
    </html>
  );
}
