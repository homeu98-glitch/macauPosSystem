import "server-only";

import { NextResponse } from "next/server";

import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
import { isPosDeviceAuthRequired, readPosDeviceTokenFromRequest } from "@/lib/pos/pos-device-token";

/**
 * POS API route 統一授權閘（2026-09-15 資安加固）。
 *
 * ## 為何要有呢個 helper
 *
 * 2026-09-15 全面審查發現：57 條 API route 之中 **44 條冇任何鑑權**，
 * 而且**全 repo 冇 `middleware.ts`** → 授權只能逐條 route 自己寫，漏一條就係一個洞。
 * 更關鍵嘅係 `getSupabaseServerClient()`（`src/lib/supabase-server.ts`）
 * **優先取 `SUPABASE_SERVICE_ROLE_KEY`，會繞過 RLS** ⇒「冇鑑權」唔係「受 RLS 保護但冇驗身分」，
 * 而係**直接裸奔資料庫**。
 *
 * 所以判準統一收歸呢度一份，`/api/pos/state` 已經用同一套口徑（見該 route 第 30-51 行）。
 *
 * ## 授權口徑（三條，任何一條成立即放行）
 *
 * 1. `POS_REQUIRE_DEVICE_AUTH=0` → 全局關閉（緊急回滾用，會寫 warn log）。
 * 2. **Admin session token** —— `/admin` 後台登入換返嚟嘅 12h HMAC token。
 *    ⚠️ 一定要接受，否則 admin 由 `/settings` 入去撳儲存會 401。
 * 3. **POS 終端憑證**，且 `claims.storeId === storeId`（**綁店**，唔可以跨店）。
 *
 * ## 用法（保持 route 改動最小、最難出錯）
 *
 * ```ts
 * const denied = posRouteAuthGuard(request, storeId);
 * if (denied) return denied;   // 已含 400 / 401 + 中文錯誤訊息 + 拒絕 log
 * ```
 *
 * ## ⚠️ 唔可以照抄去「匿名端點」
 *
 * 掃碼自助點餐／Kiosk 平板／KDS 屏係**匿名**（冇 authSession、冇 posDeviceToken）。
 * 呢啲端點（`/api/pos/bootstrap` GET、`/api/pos/sequence`、`/api/pos/sync` 嘅匿名通道、
 * `/api/ledger/member-login`、`/api/pos/order-lookup` 等）**唔可以**用呢個閘，
 * 否則客人即刻落唔到單。匿名端點嘅正確做法係白名單來源（見 `sync/route.ts` 嘅
 * `ANONYMOUS_ALLOWED_SOURCES`）。
 */
export type PosRouteAuthVia = "disabled" | "admin" | "device";

export type PosRouteAuthResult =
  | { ok: true; via: PosRouteAuthVia }
  | { ok: false; reason: "missing-store" | "unauthorized" };

/**
 * 判準本體（唔碰 Response，方便單元測試同 route 自訂回覆）。
 *
 * @param storeId 該請求宣稱要存取嘅店。**必須由 route 自己解析後傳入**（query 或 body）。
 *                傳 `null` / 空字串 → 一律當 `missing-store` 拒絕，
 *                杜絕「唔帶 storeId 就回全平台資料」呢類漏洞
 *                （2026-09-15 審查 P0：`/api/pos/orders` GET、`/api/salon/state` GET）。
 */
export function resolvePosRouteAuth(request: Request, storeId: string | null): PosRouteAuthResult {
  if (!storeId) return { ok: false, reason: "missing-store" };
  if (!isPosDeviceAuthRequired()) return { ok: true, via: "disabled" };
  if (readAdminSessionFromRequest(request)) return { ok: true, via: "admin" };

  const deviceClaims = readPosDeviceTokenFromRequest(request);
  if (deviceClaims && deviceClaims.storeId === storeId) return { ok: true, via: "device" };

  return { ok: false, reason: "unauthorized" };
}

/** 缺少 storeId 嘅統一訊息（**必須帶 storeId**，否則等於容許全平台查詢）。 */
export const MISSING_STORE_MESSAGE = "缺少 storeId：本端點必須指定店舖，唔接受全平台查詢。";

/** 未通過授權嘅統一訊息（同 `/api/pos/state` 一致，方便前端統一辨識）。 */
export const UNAUTHORIZED_MESSAGE = "未經授權：需要 POS 終端憑證，請重新登入 POS 帳號。";

/**
 * Route 用嘅一站式守衛。**通過就回 `null`**，否則回一個可以直接 `return` 嘅 `NextResponse`。
 *
 * @example
 * ```ts
 * export async function GET(request: Request) {
 *   const storeId = new URL(request.url).searchParams.get("storeId")?.trim() || null;
 *   const denied = posRouteAuthGuard(request, storeId, "pos/print-jobs/status");
 *   if (denied) return denied;
 *   ...
 * }
 * ```
 *
 * @param routeTag 只影響 log 前綴，方便事後審計（建議用 route 路徑）。
 */
export function posRouteAuthGuard(
  request: Request,
  storeId: string | null,
  routeTag = "pos-route",
): NextResponse | null {
  const result = resolvePosRouteAuth(request, storeId);
  if (result.ok) return null;

  if (result.reason === "missing-store") {
    console.warn(`[${routeTag}] 拒絕缺少 storeId 嘅請求`);
    return NextResponse.json({ ok: false, error: MISSING_STORE_MESSAGE }, { status: 400 });
  }

  console.warn(`[${routeTag}] 拒絕未授權存取（store=${storeId}）`);
  return NextResponse.json({ ok: false, error: UNAUTHORIZED_MESSAGE }, { status: 401 });
}
