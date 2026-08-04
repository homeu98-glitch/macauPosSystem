import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const payload = await request.json();

  return NextResponse.json({
    ok: true,
    syncedCount: Array.isArray(payload?.events) ? payload.events.length : 0,
    receivedAt: new Date().toISOString(),
  });
}
