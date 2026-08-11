import { NextResponse } from "next/server";

const DEPRECATED_MESSAGE =
  "此 API 已停用。會員通線上訂單請使用 Ledger Supabase（list_merchant_orders + Realtime）。見 docs/pos-ledger-client-api.md";

export async function GET() {
  return NextResponse.json({ ok: false, error: DEPRECATED_MESSAGE, deprecated: true }, { status: 410 });
}

export async function POST() {
  return NextResponse.json({ ok: false, error: DEPRECATED_MESSAGE, deprecated: true }, { status: 410 });
}
