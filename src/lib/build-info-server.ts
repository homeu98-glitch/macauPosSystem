import "server-only";

import { NextResponse } from "next/server";

import { readServerBuildId } from "@/lib/build-info";
import { POS_BUILD_HEADER } from "@/lib/pos/session-record";

/**
 * 為 POS API 回應加上「線上最新版本」標頭（2026-09-23）。
 *
 * ## 為何要（零請求成本嘅版本偵測）
 *
 * `build-stale-banner.tsx` 要有「本機 JS 版本 ≠ 線上最新」先會出現，而「線上最新」
 * 只可以經**回應標頭** `x-pos-build` 話俾 client 知。
 *
 * 原本只有 `/api/pos/state` 帶呢個標頭，但 `/api/pos/state` 係**純事件驅動、
 * 冇週期輪詢**（mount／Realtime 重連／手動／撞 limit 才會打；實測靜置 20 秒只打 1 次）
 * ⇒ 一部開住嘅收銀機可能**幾個鐘**都唔會再拉 state ⇒ 明明跑住舊 bundle，
 * 橫幅一直唔出 —— 而「開住舊分頁燒 egress」正正係呢個橫幅想防嘅事（09-21 事故）。
 *
 * ## 🔴 零新增請求、零額外流量（硬性要求）
 *
 * 呢個做法**只係喺已經要回嘅回應上加一個標頭**：
 *   · **唔新增任何 `fetch()`** —— 用返 `/api/pos/sync`（有 pending 時每 30 秒）
 *     同 `/api/pos/shift`（每 180 秒）**本來已經會打**嘅請求；
 *   · **唔新增任何 DB 查詢** —— `readServerBuildId()` 只讀 `process.env`（記憶體）；
 *   · **唔新增任何輪詢** —— 呢個專案對請求數／egress 極敏感（見 docs/113 同
 *     `src/lib/pos/egress-meter-server.ts`），所以**永遠唔可以**為咗令橫幅快啲出
 *     而加一個版本檢查 endpoint 或者加快輪詢間隔。
 *
 * 標頭本身約 20 bytes，相對 response body（`pos/state` 一次 35 KB）完全可忽略。
 *
 * ## 為何包成 `buildJson()` 而唔係喺每個 `return` 手動 `headers.set()`
 *
 * `/api/pos/sync` 有 13 個 `return`、`/api/pos/shift` 有 28 個 —— 手動加一定會漏，
 * 而漏咗嘅後果係**靜默**（橫幅唔出，冇任何錯誤）。
 * ⇒ 整個 route 一律用 `buildJson()`，**任何新增嘅 return 都自動帶標頭**。
 * 守衛測試會禁絕 route 內再出現裸 `NextResponse.json(`。
 */
export function buildJson<T>(body: T, init?: ResponseInit): NextResponse<T> {
  const response = NextResponse.json(body, init);
  // 標頭名同 `/api/pos/state` 完全一致（`src/lib/pos/session-record.ts` 嘅 POS_BUILD_HEADER），
  // client 側同一個讀法，唔會出現兩套口徑。
  response.headers.set(POS_BUILD_HEADER, readServerBuildId());
  return response;
}
