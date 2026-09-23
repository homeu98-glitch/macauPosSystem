"use client";

import { useEffect, useState } from "react";

import { isRunningInNativeShell } from "@/components/pwa-install-button";
import {
  RELEASE_PLATFORM_BUTTON_LABEL,
  RELEASE_PLATFORM_FILE_LABEL,
  detectPlatformFromWindow,
  formatReleaseFileSize,
  isReleasePlatform,
  type ReleasePlatform,
} from "@/lib/release/release-core";

/**
 * 登入頁嘅「下載安裝包」入口（2026-09-23）。
 *
 * ## 行為
 *
 * | 呢部機係 | 顯示 |
 * |---|---|
 * | Android（UA 含 `Android`） | **「下載 APK」** |
 * | 其他（Windows / macOS / Linux / iPad…） | **「下載安裝包」** |
 * | 已經跑喺原生殼（APK WebView / Electron） | **唔顯示**（已經裝咗，再下載冇意義） |
 * | 後台未設 active 版本 / 砌唔到連結 | **唔顯示**（唔派死 link） |
 *
 * 連結一律連去**目前 active 版本**，由 `/api/release/versions/active` 拎。
 * 版本切換喺 admin「版本控制」頁做（`/admin/versions`），唔需要改代碼重新部署。
 *
 * ## 三條實作紀律
 *
 * 1. **平台偵測要喺 `useEffect` 做，唔可以喺 `useState` 初始值做**。
 *    SSR 冇 `navigator` ⇒ 初始值一定係 `desktop`；若攞嚟做初始 state，
 *    Android 機首次 render 會出「下載安裝包」跟住即刻變「下載 APK」
 *    ＝ React hydration mismatch（React 19 會直接報錯）。所以 SSR／首次
 *    render 一律**唔出任何嘢**，`useEffect` 之後先出正確嘅按鈕。
 * 2. **失敗一律靜默**。呢個係登入頁 —— 拎唔到版本資料（網絡問題、migration 未跑、
 *    未配置 service key）最多係「少一個下載入口」，**絕對唔可以**彈錯誤遮住登入表單，
 *    更加唔可以 throw 令整頁白屏。
 * 3. **`downloadUrl` 為空就唔 render**。`<a href="">` 撳落去 = reload 當前頁，
 *    商家只會覺得「下載壞咗」，而且冇任何錯誤訊息可查。
 *
 * ## 為何開新分頁（`target="_blank"`）
 *
 * Supabase Storage 對 `.apk` 一般會直接觸發下載（`Content-Disposition`），
 * 但萬一 Content-Type 被判成可顯示類型，瀏覽器會**導航過去**——
 * 登入頁就冇咗。開新分頁係比較安全嘅失敗模式：就算被導航，
 * 原本嘅登入頁仍然喺度，商家唔會「撳一下下載就唔見咗個登入畫面」。
 */

/** 公開 API 回傳嘅精簡版本物件（同 `/api/release/versions/active` 一致）。 */
type PublicRelease = {
  platform: ReleasePlatform;
  version: string;
  downloadUrl: string;
  fileSize: number | null;
  notes: string | null;
};

type ActivePayload = {
  ok?: boolean;
  available?: boolean;
  releases?: Partial<Record<ReleasePlatform, PublicRelease | null>>;
};

/** 由 API 回應抽出「呢個平台」嘅版本；任何唔對路嘅形狀一律當「冇」。 */
function pickRelease(payload: ActivePayload | null, platform: ReleasePlatform): PublicRelease | null {
  const candidate = payload?.releases?.[platform];
  if (!candidate || typeof candidate !== "object") return null;
  if (!isReleasePlatform(candidate.platform)) return null;
  const url = typeof candidate.downloadUrl === "string" ? candidate.downloadUrl.trim() : "";
  // 🔴 只接受 http(s)：呢個值直接落 <a href>，`javascript:` 就係 XSS 載荷。
  if (!/^https?:\/\//i.test(url)) return null;
  if (typeof candidate.version !== "string" || !candidate.version.trim()) return null;
  return {
    platform,
    version: candidate.version.trim(),
    downloadUrl: url,
    fileSize: typeof candidate.fileSize === "number" ? candidate.fileSize : null,
    notes: typeof candidate.notes === "string" ? candidate.notes : null,
  };
}

export function AppDownloadButton() {
  /** `null` ＝ 未偵測（SSR／首次 render）⇒ 唔出任何嘢，避免 hydration mismatch。 */
  const [platform, setPlatform] = useState<ReleasePlatform | null>(null);
  const [release, setRelease] = useState<PublicRelease | null>(null);

  useEffect(() => {
    // 原生殼入面唔需要下載入口（已經係 installed app）。
    if (isRunningInNativeShell()) return;

    const detected = detectPlatformFromWindow();
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch("/api/release/versions/active", {
          // route 本身有 60s CDN 快取；呢度唔要瀏覽器 HTTP 快取，
          // 免得商家切換版本後自己部機仲見到舊 link。
          cache: "no-store",
        });
        if (!response.ok) return;
        const payload = (await response.json()) as ActivePayload;
        if (cancelled) return;
        setRelease(pickRelease(payload, detected));
      } catch {
        // 靜默：下載入口係增強功能，唔可以影響登入。
      } finally {
        if (!cancelled) setPlatform(detected);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // 未偵測完 / 冇 active 版本 / 砌唔到連結 → 唔出任何嘢。
  if (!platform || !release) return null;

  const label = RELEASE_PLATFORM_BUTTON_LABEL[platform];
  const kind = RELEASE_PLATFORM_FILE_LABEL[platform];
  const sizeText = formatReleaseFileSize(release.fileSize);

  return (
    <div className="mt-3 rounded-2xl border border-white/15 bg-white/10 px-4 py-3 text-left text-sm text-white/85">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-white">{kind}</span>
        <span className="rounded-full bg-black/25 px-2.5 py-1 text-xs font-semibold text-white/80">
          v{release.version}
        </span>
      </div>

      <a
        className="mt-3 block w-full rounded-2xl border border-orange-400/50 bg-orange-500/90 px-4 py-3 text-center text-sm font-semibold text-white hover:bg-orange-500"
        href={release.downloadUrl}
        // 跨網域（Supabase Storage）下 `download` 會被忽略，但同源／將來自訂網域時有用。
        download
        rel="noopener noreferrer"
        target="_blank"
      >
        {label}
      </a>

      <div className="mt-1.5 text-white/60">
        {sizeText === "—" ? "檔案大小未提供" : `檔案大小 ${sizeText}`}
        {" · "}
        下載後直接安裝即可
      </div>

      {release.notes ? (
        <div className="mt-1.5 text-xs leading-5 text-white/55">更新內容：{release.notes}</div>
      ) : null}
    </div>
  );
}
