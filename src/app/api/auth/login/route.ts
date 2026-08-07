import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const payload = (await request.json()) as { account?: string; pin?: string };
  const account = (payload.account ?? "").trim();
  const pin = (payload.pin ?? "").trim();

  // TODO: 之後接主系統驗證 API（例如 /auth/verify）
  const users = [
    {
      account: "63936541",
      pin: "1234",
      name: "店長",
      role: "manager",
      permissions: {
        refundOrder: true,
        voidItem: true,
      },
    },
    {
      account: "63936542",
      pin: "1234",
      name: "收銀員",
      role: "cashier",
      permissions: {
        refundOrder: false,
        voidItem: false,
      },
    },
  ] as const;

  const matched = users.find((user) => user.account === account && user.pin === pin);
  if (matched) {
    return NextResponse.json({
      ok: true,
      session: {
        account: matched.account,
        name: matched.name,
        role: matched.role,
        permissions: matched.permissions,
      },
    });
  }

  return NextResponse.json({ ok: false, error: "帳號或密碼不正確。" }, { status: 401 });
}
