import type { NextConfig } from "next";

/**
 * 建置資訊（2026-09-22）—— 畀「設置頁版本號」用。
 *
 * ── 為何要喺 `next.config` 注入而唔係叫用戶設 env ──────────────────────
 * Vercel **自動**提供 `VERCEL_GIT_COMMIT_SHA` / `VERCEL_ENV` 等系統變數（build 階段就有）
 * ⇒ 喺呢度讀一次、計出短版本號，再交 `env` **喺建置時內聯入 JS bundle**
 * ⇒ **商家／J 完全唔需要設任何環境變數**。
 *
 * ── 為何一定要「內聯」（關鍵）───────────────────────────────────────────
 * 設置頁要顯示嘅係「**當前運行嘅版本**」。如果改為由 server 提供（例如 `/api/version`），
 * 一個**跑住舊 JS 嘅分頁**一樣會顯示「最新版本」—— 咁就完全失去意義。
 * 內聯入 bundle ⇒ 呢個字串**跟住嗰份 JS 一齊**，跑舊 JS 就顯示舊版本 ✓。
 *
 * ── 🔴 兩個官方限制（見 `next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/env.md`）──
 * 1. `env` 嘅值**一律會入 JS bundle**（即係公開）⇒ 唔可以放任何機密。
 *    （呢三個值本來就係公開嘅 build metadata，冇問題。）
 * 2. **唔可以 destructure `process.env`** —— DefinePlugin 只做字面文字替換。
 *    ⇒ 讀嘅時候一定要寫 `process.env.NEXT_PUBLIC_BUILD_ID`，唔可以
 *    `const { NEXT_PUBLIC_BUILD_ID } = process.env`。
 */

/** 短版本號：commit sha（7 位）→ 冇就用 deployment id → 都冇就 `dev`。 */
function resolveBuildId(): string {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (sha) return sha.slice(0, 7);
  const deployment = process.env.VERCEL_DEPLOYMENT_ID;
  if (deployment) return deployment.slice(0, 12);
  return "dev";
}

/** Vercel 環境：`production` / `preview` / `development`。 */
function resolveBuildEnv(): string {
  return process.env.VERCEL_ENV ?? "development";
}

/** 建置時間（config 被載入嗰刻 ≈ build 開始）。 */
const BUILD_TIME = new Date().toISOString();

const nextConfig: NextConfig = {
  /**
   * 建置輸出目錄，預設 `.next`（Vercel 走呢個）。
   *
   * 加環境變數覆寫係為咗本機打包 APK 離線 bundle：2026-10-29 實測本機 `.next`
   * 會因為檔案鎖令 `next build` 永遠停在「Running next.config.ts」之後
   * （0 CPU、冇子進程、冇錯誤訊息）—— 改用另一個 distDir 即刻正常。
   * 對應工具：`macauPosAndroid/tools/bundle-web.cjs` 讀 `NEXT_DIST_DIR`。
   */
  distDir: process.env.NEXT_DIST_DIR || ".next",
  env: {
    NEXT_PUBLIC_BUILD_ID: resolveBuildId(),
    NEXT_PUBLIC_BUILD_TIME: BUILD_TIME,
    NEXT_PUBLIC_BUILD_ENV: resolveBuildEnv(),
  },
};

export default nextConfig;
