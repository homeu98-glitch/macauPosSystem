import { NextResponse } from "next/server";

import { loadActiveReleases } from "@/lib/release/release-server";

/**
 * `GET /api/download/apk` —— **短連結，一撳即下載 APK**（2026-10-31）。
 *
 * ## 為何要呢條 route
 *
 * 舊機器（Android 6 + Chrome 81）打開主站會**白屏**：Next 16 預設 target 係
 * Chrome 111+，App Router 嘅 client runtime 用咗 `static {}` 類靜態塊（Chrome 94+）
 * 同 `Array.prototype.at`（92+），Chrome 81 解析即 SyntaxError ⇒ React 掛唔上 ⇒ 白頁。
 * 實測生產 chunk `/_next/static/immutable/chunks/20es43nb27oti.js` 有齊以上語法。
 *
 * 但商家真正需要嘅只係「裝 APK」，唔需要渲染任何 React。
 * 一條純 302：瀏覽器收到 `Location` 就自己去下載，**唔會解析任何 JS** ⇒ 老機一定開得。
 *
 * ## 為何係 302 而唔係直接寫死 Storage 連結
 *
 * `macauposapk` bucket 係 **private**（實測 `…/object/public/…` 回 400），
 * 對外只可以用 **signed URL**，而 signed URL 帶 JWT token、長達 300+ 字元，
 * 冇可能叫人手打或者印成二維碼。
 *
 * ⇒ 每次請求都**重新讀 DB 拎最新 active 版本**（複用 `loadActiveReleases()`，
 *    同登入頁／`/api/release/versions/active` 完全同一份邏輯，冇另寫一套），
 *    再 302 過去。好處：
 *    · 連結**永不過期**（過期嘅只係中間嗰跳，用戶唔會見到）；
 *    · admin 喺 `/admin/versions` 切版本，呢條連結自動跟住變，唔使改代碼；
 *    · 手打得入、印得成 QR（`public/brand/apk-download-qr.svg` 就係指住呢度）。
 *
 * ## 為何 `no-store`
 *
 * 302 一旦被 CDN 快取，admin 換版本之後舊機仍然會被送去舊 package。
 * 呢條 route 每次只讀一行 DB（`is_active = true`），成本極低，唔值得為佢換風險。
 *
 * ⚠️ 呢條 route **刻意唔驗證登入**：佢派嘅係**公開嘅安裝包**（同登入頁個
 *    「下載 APK」按鈕一式一樣），裝機時都未有帳號密碼。真正嘅存取控制喺
 *    Supabase Storage 嘅 signed URL 上。
 */

export const dynamic = "force-dynamic";

/** 純靜態錯誤頁：零 JS、零框架、內聯樣式 ⇒ 連 Chrome 40 都顯示得到。 */
function unavailablePage(message: string): Response {
  const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>暫時未能下載</title>
<style>
  body{margin:0;padding:24px;background:#f6f7f9;color:#1f2937;
       font-family:-apple-system,"Helvetica Neue","Microsoft YaHei",sans-serif;}
  .box{max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;
       border-radius:16px;padding:28px 24px;}
  h1{margin:0 0 12px;font-size:22px;}
  p{margin:0 0 10px;font-size:16px;line-height:1.6;color:#4b5563;}
  .code{margin-top:18px;padding:12px 14px;background:#f3f4f6;border-radius:10px;
        font-size:13px;color:#6b7280;word-break:break-all;}
</style>
</head>
<body>
  <div class="box">
    <h1>暫時未能下載</h1>
    <p>${message}</p>
    <p>請聯絡管理員，或者喺電腦下載安裝包之後用 U 盤傳過嚟安裝。</p>
    <div class="code">macau-pos-system.vercel.app/install.html</div>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function GET() {
  let target: string | null = null;

  try {
    const result = await loadActiveReleases();
    target = result.releases.android?.downloadUrl ?? null;

    // 讀失敗／未設版本：只喺 server log 講原因，唔好將內部訊息（例如「未配置
    // SUPABASE_SERVICE_ROLE_KEY」）派俾終端用戶 —— 對店員毫無意義而且屬內部細節。
    if (!target) {
      console.warn(
        "[download-apk] 攞唔到 Android active 版本：",
        result.available ? "DB 冇 is_active 嘅 android row" : result.reason,
      );
    }
  } catch (error) {
    // 網絡／DB 例外一樣唔可以變成 500 白頁 —— 店員要見到一句人話。
    console.error(
      "[download-apk] 讀版本例外：",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!target) return unavailablePage("目前未設定可下載嘅 Android 安裝包。");

  /**
   * 🔴 二次校驗：呢個值會**直接落 `Location` 頭**，等於一條伺服器發出嘅跳轉。
   *    DB 寫入時已經驗過一次（`validateReleaseDraft`），但這裡係最外層出口，
   *    寧願重覆驗：只放行 http(s)，擋走 `javascript:` / `data:` 之類。
   */
  if (!/^https?:\/\//i.test(target)) {
    console.error("[download-apk] downloadUrl 唔係 http(s)，已拒絕：", target);
    return unavailablePage("下載連結設定有誤，請聯絡管理員。");
  }

  return NextResponse.redirect(target, {
    status: 302,
    headers: {
      // 唔可以快取：admin 換版本後要即刻生效。
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
