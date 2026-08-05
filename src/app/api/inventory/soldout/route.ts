import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const payload = (await request.json()) as {
    menuItemId?: string;
    name?: string;
    storeId?: string;
    soldOutAt?: string;
  };

  // TODO: 之後接主系統（例如 inventory/soldout）做真正同步
  return NextResponse.json({
    ok: true,
    received: payload,
  });
}

