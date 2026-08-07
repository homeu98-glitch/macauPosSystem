import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "澳門會員通 POS",
    short_name: "Macau POS",
    description: "澳門餐飲 POS，可安裝到主頁，支援快餐、堂食、會員與離線操作。",
    start_url: "/login",
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
