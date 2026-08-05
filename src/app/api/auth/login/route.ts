import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const payload = (await request.json()) as { account?: string; pin?: string };
  const account = (payload.account ?? "").trim();
  const pin = (payload.pin ?? "").trim();

  // TODO: 之後接主系統驗證 API（例如 /auth/verify）
  if (account === "63936541" && pin === "1234") {
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: false, error: "帳號或密碼不正確。" }, { status: 401 });
}

