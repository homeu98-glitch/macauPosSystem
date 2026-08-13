import { NextResponse } from "next/server";

const GONE_MESSAGE =
  "POS mock 會員 API 已廢棄。請使用 Ledger RPC：merchant_lookup_customer_wallet、list_customer_reward_grants、list_redeemable_grants_for_customer（讀）；merchant_apply_pos_txn、redeem_reward_grants（寫）。";

function gone() {
  return NextResponse.json(
    {
      ok: false,
      error: GONE_MESSAGE,
      migration: "ledger-rpc-v3",
    },
    { status: 410 },
  );
}

export async function GET() {
  return gone();
}

export async function POST() {
  return gone();
}
