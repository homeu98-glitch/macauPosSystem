import { NextResponse } from "next/server";

import { authenticateAccountFromServer } from "@/lib/admin-account-server";

export async function POST(request: Request) {
  const payload = (await request.json()) as { account?: string; pin?: string };
  const account = (payload.account ?? "").trim();
  const pin = (payload.pin ?? "").trim();
  const result = await authenticateAccountFromServer(account, pin);
  if (result.ok) {
    return NextResponse.json({
      ok: true,
      source: result.source,
      session: result.session,
    });
  }
  return NextResponse.json({ ok: false, error: result.error, source: result.source }, { status: 401 });
}
