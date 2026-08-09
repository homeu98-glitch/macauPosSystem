import { NextResponse } from "next/server";

import { listBackofficeOverviewFromServer } from "@/lib/backoffice-server";

export async function GET() {
  const result = await listBackofficeOverviewFromServer();
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }

  return NextResponse.json(result);
}
