// Desktop App 自動更新——版本資訊 API。
//
// electron-updater 嘅 generic provider 預期喺 publish URL 搵到 `latest.yml`。
// 我哋改做 JSON manifest（`/releases/manifest.json`），俾 POS 網頁同 Electron 都可以查。
//
// electron-updater 仍要 `latest.yml`——呢個 route 額外提供 JSON 俾：
//   - POS 網頁嘅 AppUpdatePanel 顯示「目前 vs 最新版本」對比
//   - 將來可選手動下載連結
//
// 部署後 manifest.json 放喺 Vercel static（public/releases/），改 manifest 唔使 redeploy API。

import { NextResponse } from "next/server";

export const dynamic = "force-static";

// manifest 喺 build time 由 Vercel serve 做 static file（public/），但呢個 route
// 俾 Electron / POS UI 用 fetch 攞 metadata。讀 static manifest 再加 baseUrl。
export async function GET() {
  const manifestUrl = "/releases/manifest.json";
  // Vercel 同 localhost 都用 relative path；electron-updater 會自己拼 baseUrl。
  try {
    // 喺 server 端讀 static file（public/ 映射去 root）
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const filePath = path.join(process.cwd(), "public", "releases", "manifest.json");
    const raw = await readFile(filePath, "utf-8");
    const manifest = JSON.parse(raw);

    // 加埋完整 download URL（俾 Electron 直接用）
    const baseUrl = `https://macau-pos-system.vercel.app`;
    const downloadUrl = manifest.url || `${baseUrl}${manifest.path || `/releases/${manifest.fileName || ""}`}`;

    return NextResponse.json({
      ...manifest,
      downloadUrl,
      baseUrl,
    }, {
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  } catch {
    // manifest 唔存在（首次未發佈）→ 返 404 等資訊
    return NextResponse.json(
      { ok: false, error: "manifest.json 未找到——尚未發佈任何版本" },
      { status: 404 },
    );
  }
}
