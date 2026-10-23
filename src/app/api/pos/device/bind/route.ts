import { NextResponse } from "next/server";

import {
  listBoundDevices,
  revokeBoundDevice,
  upsertBoundDevice,
} from "@/lib/pos/device-binding-server";
import { requireStoreOwner } from "@/lib/pos/owner-guard.server";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";

/**
 * `/api/pos/device/bind` —— 裝置授權（店主限定）。
 *
 * | 方法 | 用途 | 鑑權 |
 * |---|---|---|
 * | POST | 授權**呢部機**（之後店員免店主帳密開機） | `requireStoreOwner()` |
 * | GET | 列出已授權裝置 | 同上 |
 * | DELETE | 撤銷某一部裝置 | 同上 |
 *
 * ## 為何要店主親自授權
 *
 * 呢個 API 等於「發一張可以長期換 session 嘅鑰匙」。如果任何人都叫得，就等於
 * 取消咗 L1。所以一定要 `staff_role = owner`（Ledger 通道）或者 admin scope 內
 * （後台通道），同「權限控制」頁同一把尺。
 *
 * ## 為何 POST 要收 `refreshToken`
 *
 * 開機之後 POS 仍然需要**真嘅 Ledger session**（會員／加值／報表／權限控制全部靠
 * `ledgerAccessToken`）。server 唔知店主密碼，唯一可以代為續期嘅材料就係
 * refresh token。佢會以 AES-256-GCM 加密後存喺 `pos_bound_devices`。
 * 冇 `POS_DEVICE_TOKEN_SECRET` / `ADMIN_SESSION_SECRET` / service key 就 fail closed。
 */

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function bad(error: string, status = 400, code?: string) {
  return NextResponse.json(code ? { ok: false, error, code } : { ok: false, error }, { status });
}

function readStoreId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readDeviceId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return DEVICE_ID_PATTERN.test(raw) ? raw : "";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const storeId = readStoreId(url.searchParams.get("storeId"));
  if (!storeId) return bad("缺少 storeId。", 400, "store_required");

  const guard = await requireStoreOwner(request, storeId);
  if (!guard.ok) return guard.res;

  const result = await listBoundDevices(storeId);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, tableReady: result.tableMissing ? false : undefined },
      { status: result.status },
    );
  }
  return NextResponse.json({ ok: true, devices: result.devices, tableReady: true });
}

export async function POST(request: Request) {
  if (!rateLimit(`pos-device-bind:${clientIp(request)}`, 20, 60_000)) {
    return bad("請求過於頻繁，請稍後再試。", 429, "rate_limited");
  }

  const body = (await request.json().catch(() => null)) as {
    storeId?: string;
    deviceId?: string;
    label?: string;
    refreshToken?: string;
  } | null;

  const storeId = readStoreId(body?.storeId);
  const deviceId = readDeviceId(body?.deviceId);
  const refreshToken = typeof body?.refreshToken === "string" ? body.refreshToken.trim() : "";
  if (!storeId) return bad("缺少 storeId。", 400, "store_required");
  if (!deviceId) return bad("裝置識別碼無效。", 400, "device_invalid");
  if (!refreshToken) return bad("缺少 Ledger 憑證，請重新登入後再試。", 400, "refresh_required");

  const guard = await requireStoreOwner(request, storeId);
  if (!guard.ok) return guard.res;

  const label = (typeof body?.label === "string" ? body.label.trim() : "").slice(0, 60);
  const result = await upsertBoundDevice({
    storeId,
    deviceId,
    label,
    boundBy: guard.account,
    refreshToken,
  });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, tableReady: result.tableMissing ? false : undefined },
      { status: result.status },
    );
  }

  return NextResponse.json({ ok: true, deviceId, storeId, secret: result.secret, tableReady: true });
}

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    storeId?: string;
    deviceId?: string;
  } | null;

  const storeId = readStoreId(body?.storeId);
  const deviceId = readDeviceId(body?.deviceId);
  if (!storeId) return bad("缺少 storeId。", 400, "store_required");
  if (!deviceId) return bad("裝置識別碼無效。", 400, "device_invalid");

  const guard = await requireStoreOwner(request, storeId);
  if (!guard.ok) return guard.res;

  const result = await revokeBoundDevice(storeId, deviceId);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, tableReady: result.tableMissing ? false : undefined },
      { status: result.status },
    );
  }
  return NextResponse.json({ ok: true });
}
