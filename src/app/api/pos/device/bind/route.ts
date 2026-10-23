import { NextResponse } from "next/server";

import { listBoundDevices, revokeBoundDevice } from "@/lib/pos/device-binding-server";
import { requireStoreOwner } from "@/lib/pos/owner-guard.server";

/**
 * `/api/pos/device/bind` —— 已授權裝置嘅**管理**（店主限定）。
 *
 * | 方法 | 用途 | 鑑權 |
 * |---|---|---|
 * | GET | 列出已授權裝置 | `requireStoreOwner()` |
 * | DELETE | 撤銷某一部裝置 | 同上 |
 *
 * ## 2026-10-23：POST 已移除（docs/161）
 *
 * 授權而家喺 `/api/ledger/login` 成功嗰一刻**自動**完成 —— 嗰度係唯一同時
 * 知道「storeId + 已驗證嘅 PIN」嘅地方，亦唔使客戶端另外打一次 API。
 * 呢個 route 只剩「睇」同「撤銷」。
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
