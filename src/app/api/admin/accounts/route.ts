import { NextResponse } from "next/server";

import { readClientIp } from "@/lib/admin-audit.server";
import { createAdminAccount, listAdminAccounts } from "@/lib/admin-accounts.server";
import { requireAdmin } from "@/lib/admin-guard.server";

/**
 * `/api/admin/accounts` — 後台帳號管理（2026-10-21 · P2）。
 *
 * | Method | 用途 |
 * |---|---|
 * | GET  | 列出全部後台帳號（含角色／綁店／must_change_pin／最後登入） |
 * | POST | 建立帳號（`kind: "platform" \| "owner"`，owner 要 1–20 間店） |
 *
 * 🔴 **平台專屬**：呢度係唯一可以製造新後台身份嘅入口，店主帳號一律 403。
 */

export async function GET(request: Request) {
  const guard = await requireAdmin(request, { platform: true });
  if (!guard.ok) return guard.res;

  const result = await listAdminAccounts();
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    ok: true,
    accounts: result.value,
  });
}

export async function POST(request: Request) {
  const guard = await requireAdmin(request, { platform: true });
  if (!guard.ok) return guard.res;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "請求格式錯誤。" }, { status: 400 });
  }

  const payload = (body ?? {}) as {
    account?: unknown;
    pin?: unknown;
    name?: unknown;
    kind?: unknown;
    storeIds?: unknown;
  };

  const result = await createAdminAccount(
    {
      account: String(payload.account ?? ""),
      // 只接受字串：JSON number 會令 "0123" 變成 123（前導 zero 消失），安全性上要擋。
      pin: typeof payload.pin === "string" ? payload.pin : "",
      name: String(payload.name ?? ""),
      kind: payload.kind === "platform" ? "platform" : "owner",
      storeIds: payload.storeIds,
    },
    guard.claims.account,
    readClientIp(request),
  );

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }

  return NextResponse.json({ ok: true, account: result.value.account });
}
