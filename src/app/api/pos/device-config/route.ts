import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const payload = await request.json();

  return NextResponse.json({
    ok: true,
    message: "已接收設備設定事件",
    receivedAt: new Date().toISOString(),
    payload,
  });
}
