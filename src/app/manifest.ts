import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "澳門會員通 POS",
    short_name: "Macau POS",
    description: "澳門餐飲 POS，可安裝到主頁，支援快餐、堂食、會員與離線操作。",
    /**
     * ⚠️ 2026-09-17：由 `/login` 改為 `/`（**統一入口**）。
     *
     * 由主畫面圖示開啟時直接入統一入口（工作台選擇頁），商家喺嗰度揀端別。
     * `AuthGuard` 會處理未登入嘅情況（導向 `/login`），所以唔會「開咗但入唔到」。
     *
     * 注意：`/` **唔會**自動跳去「上次使用」嘅端別 —— 佢係刻意保留選擇頁，
     * 因為呢個入口嘅目的就係「每次由商家決定呢部機做咩」。
     * 選擇頁會標示「上次使用」徽章（`loadLastWorkbench()`），所以固定崗位嘅機
     * 一眼就搵返自己嗰張卡，唔使諗。
     */
    start_url: "/",
    display: "standalone",
    background_color: "#0f172a",
    theme_color: "#f97316",
    orientation: "portrait",
    icons: [
      {
        src: "/icon?size=192",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icon?size=512",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/apple-icon",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  };
}
