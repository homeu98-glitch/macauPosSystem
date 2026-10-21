import { NextResponse } from "next/server";

import { readClientIp } from "@/lib/admin-audit.server";
import { updateAdminAccount } from "@/lib/admin-accounts.server";
import { requireAdmin } from "@/lib/admin-guard.server";

/**
 * `PATCH /api/admin/accounts/[account]` — 停用／啟用、重設 PIN、改綁店（P2，平台專屬）。
 *
 * body（全部 optional，但至少要有一項）：
 *   { active?: boolean, pin?: "1234", storeIds?: string[] }
 *
 * ⚠️ 平台總管理帳號（60000000）唔可以停用 —— 停咗就冇人有 `manageAccounts`，
 *    整個後台要入 DB 才救得返（`updateAdminAccount()` 會擋）。
 */

type RouteContext = { params: Promise<{ account: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const guard = await requireAdmin(request, { platform: true });
  if (!guard.ok) return guard.res;

  const { account } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "請求格式錯誤。" }, { status: 400 });
  }

  const payload = (body ?? {}) as { active?: unknown; pin?: unknown; storeIds?: unknown };
  if (payload.active === undefined && payload.pin === undefined && payload.storeIds === undefined) {
    return NextResponse.json({ ok: false, error: "冇任何要更新嘅項目。" }, { status: 400 });
  }

  const result = await updateAdminAccount(
    account,
    { active: payload.active, pin: payload.pin, storeIds: payload.storeIds },
    guard.claims.account,
    readClientIp(request),
  );

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }

  return NextResponse.json({ ok: true, account: result.value.account });
}
