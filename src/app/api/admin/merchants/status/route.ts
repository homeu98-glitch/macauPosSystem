import { NextResponse } from "next/server";

import { getLedgerServiceClient } from "@/lib/ledger/admin-server";
import { readAdminSessionFromRequest } from "@/lib/admin-session-token";

/**
 * PATCH /api/admin/merchants/status — 啟用 / 停用整個商家（admin panel 唯一寫操作）。
 *
 * 動作：Ledger DB `merchants.status` 改 "active" ⇄ "suspended"。
 * `/api/ledger/login` 已內置檢查：status = suspended（或任何非 active/pending）→
 * 該店**全部賬號**都無法登入 POS（403「商戶已停用」）。所以呢個粒度係「整個商家」，
 * 唔係個別 8 位賬號（用戶 2026-09-06 確認）。
 *
 * 把關：admin session token。動作會喺 response 入面回傳新狀態，前端更新列表。
 */

const ALLOWED_STATUS = new Set(["active", "suspended"]);

export async function PATCH(request: Request) {
  const claims = readAdminSessionFromRequest(request);
  if (!claims) {
    return NextResponse.json({ ok: false, error: "未授權，請先登入管理後台。" }, { status: 401 });
  }

  let payload: { merchantId?: string; status?: string };
  try {
    payload = (await request.json()) as { merchantId?: string; status?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "請求格式錯誤。" }, { status: 400 });
  }

  const merchantId = String(payload?.merchantId ?? "").trim();
  const status = String(payload?.status ?? "").trim().toLowerCase();

  if (!merchantId) {
    return NextResponse.json({ ok: false, error: "缺少 merchantId。" }, { status: 400 });
  }
  if (!ALLOWED_STATUS.has(status)) {
    return NextResponse.json({ ok: false, error: "status 只可以是 active 或 suspended。" }, { status: 400 });
  }

  const ledger = getLedgerServiceClient();
  if (!ledger) {
    return NextResponse.json(
      { ok: false, error: "未配置 LEDGER_SERVICE_ROLE_KEY，無法修改商家狀態。" },
      { status: 503 },
    );
  }

  const { data, error } = await ledger
    .from("merchants")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", merchantId)
    .select("id, name, status")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { ok: false, error: "更新商家狀態失敗。", detail: error?.message ?? "merchant 不存在" },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    merchant: {
      id: data.id,
      name: data.name ?? data.id,
      status: String(data.status ?? "").toLowerCase(),
    },
    updatedBy: claims.account,
    updatedAt: new Date().toISOString(),
  });
}
