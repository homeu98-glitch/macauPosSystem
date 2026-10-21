import "server-only";

import { NextResponse } from "next/server";

import { storeFilterFor, type AdminScope } from "@/lib/admin-scope-core";
import { resolveAdminScope } from "@/lib/admin-scope.server";
import { readAdminSessionFromRequest, type AdminSessionClaims } from "@/lib/admin-session-token";

/**
 * Admin API 統一守衛（2026-10-21 · 多店控制台 P1）。
 *
 * ## 為何要「統一」而唔係逐條 route 自己寫
 *
 * 舊版每條 route 都自己寫一次 `if (!claims) 401`，結果就係「有 token 就有全部權限」。
 * 只要有**一條** route 漏咗 scope 檢查，整個隔離就破功 —— 而漏嘅方式極容易
 * （新加一條 route、複製舊 code）。所以全部 admin route 一律經呢個入口：
 *
 *     const guard = await requireAdmin(request, { platform: true });
 *     if (!guard.ok) return guard.res;
 *
 * ## 回傳語義
 *
 * | 情況 | HTTP | 理由 |
 * |---|---|---|
 * | 冇 / 壞 / 過期 token | 401 | 同舊行為一致 |
 * | 帳號查唔到／已停用 | 401 | token 冇狀態，停用要靠呢度即時失效 |
 * | DB 未配置 | 503 | 唔可以當「冇權限」，否則好難排查 |
 * | `need.platform` 但只係店舖帳號 | 403 | D4：平台專屬功能 |
 * | 指定店唔喺 scope 內 | 403 | 唔可以靜默降級（前端會睇錯店） |
 */

export type AdminGuardOk = { ok: true; claims: AdminSessionClaims; scope: AdminScope };
export type AdminGuardFail = { ok: false; res: NextResponse };
export type AdminGuardResult = AdminGuardOk | AdminGuardFail;

export type AdminGuardNeed = {
  /**
   * 平台專屬（跨全部店）。現時：merchants 全表、停用商家、模組授權寫入、
   * 工作階段總覽、雲端用量、版本控制。
   */
  platform?: boolean;
};

function deny(message: string, status: number, code?: string): AdminGuardFail {
  return {
    ok: false,
    res: NextResponse.json(code ? { ok: false, error: message, code } : { ok: false, error: message }, {
      status,
    }),
  };
}

export async function requireAdmin(
  request: Request,
  need: AdminGuardNeed = {},
): Promise<AdminGuardResult> {
  const claims = readAdminSessionFromRequest(request);
  if (!claims) return deny("未授權，請先登入管理後台。", 401, "unauthorized");

  const resolved = await resolveAdminScope(claims.account);
  if (!resolved.ok) {
    if (resolved.reason === "unavailable") {
      console.error("[admin-guard] scope 解析失敗：DB 未配置");
      return deny("系統未正確配置資料庫，管理功能暫時停用。", 503, "supabase_not_configured");
    }
    // not_found / inactive → 401（同「token 無效」同一出口，唔洩露帳號狀態）
    return deny("登入狀態已失效，請重新登入。", 401, "session_invalid");
  }

  if (need.platform && !resolved.scope.all) {
    // 唔寫 audit（避免被刷爆表）；console 會落 Vercel log，足夠追查。
    console.warn("[admin-guard] 拒絕平台專屬操作", {
      account: claims.account,
      route: new URL(request.url).pathname,
    });
    return deny("此功能只限平台管理員。", 403, "platform_only");
  }

  return { ok: true, claims, scope: resolved.scope };
}

/**
 * 由 query / body 抽出的店 id，計出實際 SQL 過濾條件。
 * 越權 → 403（`scope.denied`）。
 */
export function storeFilterOrDeny(
  scope: AdminScope,
  requested: string | null | undefined,
  request: Request,
): { ok: true; storeIds: string[] | null } | AdminGuardFail {
  const result = storeFilterFor(scope, requested);
  if (!result.ok) {
    console.warn("[admin-guard] 越權讀取被拒", {
      route: new URL(request.url).pathname,
      requested,
      scopeAll: scope.all,
    });
    return deny("未經授權：此店舖不在你的可見範圍內。", 403, "scope.denied");
  }
  return result;
}
