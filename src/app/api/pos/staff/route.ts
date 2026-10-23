import { NextResponse } from "next/server";

import { requireStoreOwner } from "@/lib/pos/owner-guard.server";
import { POS_STAFF_MAX_PER_STORE, validatePosStaffDraft } from "@/lib/pos/staff-core";
import { createPosStaff, listPosStaff } from "@/lib/pos/staff-server";

/**
 * `/api/pos/staff` —— 店員清單／新增（**店主專屬**）。
 *
 * | Method | 用途 |
 * |---|---|
 * | GET  | 列出本店店員（永不回 PIN） |
 * | POST | 新增店員（工號＋PIN＋角色＋權限） |
 *
 * 鑑權：`requireStoreOwner()`（admin token 或 Ledger owner token 雙通道）。
 * 表未建（migration 0072 未跑）→ 回 **200 + `tableReady:false`**，
 * 令 UI 可以顯示「請先執行 migration」而唔係一片 500。
 */

export async function GET(request: Request) {
  const url = new URL(request.url);
  const storeId = (url.searchParams.get("storeId") ?? "").trim();

  const guard = await requireStoreOwner(request, storeId);
  if (!guard.ok) return guard.res;

  const result = await listPosStaff(storeId);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, tableReady: result.tableMissing ? false : undefined },
      { status: result.status },
    );
  }

  return NextResponse.json({
    ok: true,
    staff: result.staff,
    tableReady: true,
    maxPerStore: POS_STAFF_MAX_PER_STORE,
  });
}

export async function POST(request: Request) {
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

  const parsed = validatePosStaffDraft(payload, { requirePin: true });
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }

  const result = await createPosStaff({
    storeId,
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
