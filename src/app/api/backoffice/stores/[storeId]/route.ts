import { NextResponse } from "next/server";

import { getBackofficeStoreDetailFromServer, updateBackofficeStoreActiveOnServer } from "@/lib/backoffice-server";

type RouteContext = {
  params: Promise<{ storeId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { storeId } = await context.params;
  const result = await getBackofficeStoreDetailFromServer(storeId);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 404 });
  }

  return NextResponse.json(result);
}

export async function PATCH(request: Request, context: RouteContext) {
  const { storeId } = await context.params;
  const payload = (await request.json()) as { active?: boolean };
  if (typeof payload.active !== "boolean") {
    return NextResponse.json({ ok: false, error: "缺少 active 狀態。" }, { status: 400 });
  }

  const result = await updateBackofficeStoreActiveOnServer(storeId, payload.active);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
