import { NextResponse } from "next/server";

import { readClientIp } from "@/lib/admin-audit.server";
import { changeOwnPin } from "@/lib/admin-accounts.server";
import { requireAdmin } from "@/lib/admin-guard.server";

/**
 * `POST /api/admin/me/pin` — 改自己嘅 PIN（2026-10-21 · P2-4）。
 *
 * 用途有二：
 *   ① 首登強制改（登入回傳 `mustChangePin: true` 時，前端彈窗要求改）；
 *   ② 平時自己想換。
 *
 * 安全：必須驗舊 PIN（唔可以只靠已登入嘅 token —— token 可能係別人部機上嘅殘留）。
 * 改完會清零鎖定計數（防止之前被鎖影響）。
 */

export async function POST(request: Request) {
  // 任何已登入 admin（平台或店舖級）都可以改自己 PIN，所以唔加 platform。
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.res;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "請求格式錯誤。" }, { status: 400 });
  }

  const payload = (body ?? {}) as { oldPin?: unknown; newPin?: unknown };

  const result = await changeOwnPin(
    guard.claims.account,
    payload.oldPin,
    payload.newPin,
    readClientIp(request),
  );

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }

  return NextResponse.json({ ok: true, account: result.value.account });
}
