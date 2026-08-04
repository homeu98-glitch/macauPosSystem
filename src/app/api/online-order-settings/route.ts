import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    autoAccept: false,
  });
}

export async function POST(request: Request) {
  const payload = await request.json();
  return NextResponse.json({
    ok: true,
    autoAccept: Boolean(payload?.autoAccept),
    updatedAt: new Date().toISOString(),
  });
}

