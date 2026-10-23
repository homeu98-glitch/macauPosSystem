import { NextResponse } from "next/server";

import { requireStoreOwner } from "@/lib/pos/owner-guard.server";
import { validatePosStaffDraft } from "@/lib/pos/staff-core";
import { deactivatePosStaff, updatePosStaff } from "@/lib/pos/staff-server";

/**
 * `/api/pos/staff/[staffId]` —— 修改／停用店員（**店主專屬**）。
 *
 * | Method | 用途 |
 * |---|---|
 * | PATCH  | 改名／改角色／改權限／改 PIN／啟用停用 |
 * | DELETE | 停用（軟刪除；保留歷史，唔真刪 row） |
 *
 * ⚠️ PIN 留空 = **不改**；只有真係填咗新 PIN 才重設 hash。
 */

type RouteContext = { params: Promise<{ staffId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const { staffId } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "請求格式錯誤。" }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const storeId = String(payload.storeId ?? "").trim();

  const guard = await requireStoreOwner(request, storeId);
  if (!guard.ok) return guard.res;

  if (!staffId) {
    return NextResponse.json({ ok: false, error: "缺少店員 id。" }, { status: 400 });
  }

  const parsed = validatePosStaffDraft(payload, { requirePin: false });
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }

  const result = await updatePosStaff({
    storeId,
    staffId,
    draft: parsed.value,
    actor: guard.account,
  });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, tableReady: result.tableMissing ? false : undefined },
      { status: result.status },
    );
  }

  return NextResponse.json({ ok: true, staff: result.staff });
}

export async function DELETE(request: Request, context: RouteContext) {
  const { staffId } = await context.params;

  const url = new URL(request.url);
  let storeId = (url.searchParams.get("storeId") ?? "").trim();
  if (!storeId) {
    const body = (await request.json().catch(() => ({}))) as { storeId?: unknown };
    storeId = String(body.storeId ?? "").trim();
  }

  const guard = await requireStoreOwner(request, storeId);
  if (!guard.ok) return guard.res;

  if (!staffId) {
    return NextResponse.json({ ok: false, error: "缺少店員 id。" }, { status: 400 });
  }

  const result = await deactivatePosStaff({ storeId, staffId, actor: guard.account });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, tableReady: result.tableMissing ? false : undefined },
      { status: result.status },
    );
  }

  return NextResponse.json({ ok: true, staff: result.staff });
}
