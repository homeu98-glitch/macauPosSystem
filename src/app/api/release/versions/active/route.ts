import { NextResponse } from "next/server";

import type { ReleasePlatform } from "@/lib/release/release-core";
import { loadActiveReleases } from "@/lib/release/release-server";

/**
 * `GET /api/release/versions/active` —— **公開**（免登入）讀目前派緊嘅安裝包版本。
 *
 * ## 為何要公開
 *
 * 用喺**登入頁**（`components/login-screen.tsx`）：「呢部機係 Android 就出『下載 APK』、
 * 係桌面就出『下載安裝包』」。登入頁本身就係匿名路徑（未證明身分），
 * 所以呢條 route **唔可以**要求 admin token —— 否則功能等於冇。
 *
 * ## 為何唔直接俾瀏覽器讀 DB（anon key）
 *
 * `pos_release_versions` 已經 revoke 咗 anon／authenticated（migration 0050 §C）：
 *   · 呢張表由 admin 寫入，一旦 anon 可讀就等於公開「內部版本清單 + 備註」；
 *   · 而且 anon 直讀要 expose Supabase 專案 URL + 一張新表嘅 RLS 政策，
 *     每次加欄位都要重新審一次 RLS。
 * 走 server route 反而更細嘅攻擊面：對外**只**回兩個平台嘅 active 版本，
 * 而且**只回 5 個欄位**（見 `PublicRelease`），其餘（id / created_at / 內部備註以外的東西）
 * 一律唔出。
 *
 * ## 快取（egress）
 *
 * 呢條 route 會被**每一部未裝 App 嘅機**每次入登入頁就打一次。回應只有幾百 bytes，
 * 但本專案對 function invocation 同 egress 一向敏感（見 docs/113 同
 * `src/lib/pos/egress-meter-server.ts`），所以加 60 秒 CDN 快取：
 * 同一分鐘內所有訪客由 edge 直接回，唔會入 function。
 * 代價 ＝ admin 切換版本後**最多 60 秒**先對外生效（admin 頁有寫明）。
 *
 * ⚠️ 唔用 `force-static`：呢條要讀 DB（`getSupabaseAdminClient()`），
 *    build time 唔會有資料。
 */

export const dynamic = "force-dynamic";

/** 對外**只**出呢 5 個欄位（其餘欄位屬內部資料，唔需要俾匿名訪客）。 */
type PublicRelease = {
  platform: ReleasePlatform;
  version: string;
  /** 最終下載連結（已經由 server 砌好，client 唔使再砌）。 */
  downloadUrl: string;
  fileSize: number | null;
  notes: string | null;
};

function toPublic(release: {
  platform: ReleasePlatform;
  version: string;
  downloadUrl: string | null;
  fileSize: number | null;
  notes: string | null;
} | null): PublicRelease | null {
  // 🔴 `downloadUrl` 砌唔到就當「冇呢個版本」—— 寧願唔顯示按鈕，
  //    都唔好派一個 `null`／空字串 href（商家撳落去只會 reload 一次，零反應）。
  if (!release?.downloadUrl) return null;
  return {
    platform: release.platform,
    version: release.version,
    downloadUrl: release.downloadUrl,
    fileSize: release.fileSize,
    notes: release.notes,
  };
}

export async function GET() {
  const result = await loadActiveReleases();

  return NextResponse.json(
    {
      ok: true,
      /**
       * `false` ＝ 未配置 / 未跑 migration 0050 ⇒ 前端當「功能未啟用」，
       * **唔好**當錯誤（登入頁照樣要入得去）。
       */
      available: result.available,
      ...(result.available ? {} : { reason: result.reason }),
      releases: {
        android: toPublic(result.releases.android),
        desktop: toPublic(result.releases.desktop),
      },
    },
    {
      headers: {
        // 60 秒 CDN 快取 + 5 分鐘 stale-while-revalidate（背景刷新，訪客唔會等）。
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    },
  );
}
