import { NextResponse } from "next/server";

import { readClientIp, writeAdminAudit } from "@/lib/admin-audit.server";
import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
import { getBackofficeStoreDetailFromServer, updateBackofficeStoreActiveOnServer } from "@/lib/backoffice-server";
import { isPosDeviceAuthRequired, readPosDeviceTokenFromRequest } from "@/lib/pos/pos-device-token";

type RouteContext = {
  params: Promise<{ storeId: string }>;
};

/**
 * `/api/backoffice/stores/[storeId]`
 *
 * 🔴 2026-10-21（多店控制台 P0-3）：**以前兩個 method 都完全冇鑑權**。
 *    PATCH 可以直接改任何一間店的 `admin_stores.active`（＝停用店舖），
 *    而 `/backoffice` 嘅 `AuthGuard` 只係前端 localStorage，繞過成本 = 0。
 *    同一個資料夾裡面 `overview` 有閘、`stores/[storeId]` 冇閘 —— 兩套標準。
 *
 * 現時口徑（P0，未做 scope）：
 *   - **GET**：admin session **或** POS 終端憑證（同 `overview` 一致；商戶用 POS 帳號
 *     登入時未必有 adminSessionToken）。但用終端憑證時**只准讀自己那間店**，
 *     否則任何一台 POS 機都可以列舉其他店的帳號清單。
 *   - **PATCH（停用／啟用店舖）**：**只准 admin session**。呢個係平台級寫操作，
 *     店內收銀機無論如何都唔應該有權停用店舖。P1 會再加 `need.platform`。
 */

export async function GET(request: Request, context: RouteContext) {
  const { storeId } = await context.params;

  const adminAccount = readAdminSessionFromRequest(request)?.account ?? null;
  const device = readPosDeviceTokenFromRequest(request);

  if (isPosDeviceAuthRequired() && !adminAccount && !device) {
    console.warn("[backoffice/store] 拒絕未授權讀取", { storeId });
    return NextResponse.json(
      { ok: false, error: "未經授權：需要登入後台或 POS 終端憑證。" },
      { status: 401 },
    );
  }

  // POS 終端憑證只覆蓋自己那間店（admin session 才可跨店）。
  if (!adminAccount && device && device.storeId !== storeId) {
    console.warn("[backoffice/store] 終端憑證越店讀取被拒", {
      tokenStoreId: device.storeId,
      requestedStoreId: storeId,
    });
    return NextResponse.json(
      { ok: false, error: "未經授權：此終端憑證不涵蓋指定店舖。" },
      { status: 403 },
    );
  }

  const result = await getBackofficeStoreDetailFromServer(storeId);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 404 });
  }

  return NextResponse.json(result);
}

export async function PATCH(request: Request, context: RouteContext) {
  const { storeId } = await context.params;

  // 停用／啟用店舖 = 平台級寫操作。POS 終端憑證一律拒絕。
  const adminAccount = readAdminSessionFromRequest(request)?.account ?? null;
  if (!adminAccount) {
    console.warn("[backoffice/store] 拒絕未授權的店舖狀態變更", { storeId });
    return NextResponse.json({ ok: false, error: "未經授權：需要管理員登入。" }, { status: 401 });
  }

  const payload = (await request.json()) as { active?: boolean };
  if (typeof payload.active !== "boolean") {
    return NextResponse.json({ ok: false, error: "缺少 active 狀態。" }, { status: 400 });
  }

  const result = await updateBackofficeStoreActiveOnServer(storeId, payload.active);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }

  // 審計：邊個帳號、幾時、停／啟用邊間店。失敗唔影響結果（見 admin-audit 鐵律）。
  await writeAdminAudit({
    account: adminAccount,
    action: "write",
    target: "store.active",
    storeIds: [storeId],
    detail: { active: payload.active },
    ip: readClientIp(request),
  });

  return NextResponse.json({ ok: true });
}
