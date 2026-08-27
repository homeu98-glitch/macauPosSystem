import { NextResponse } from "next/server";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DbError = { code?: string; message?: string } | null;
function isMissingTable(err: DbError): boolean {
  if (!err) return false;
  if (err.code === "42P01") return true;
  return /relation .* does not exist/i.test(err.message ?? "");
}

/**
 * 唯讀：依 8 位帳號顯示 expenseRecorder 的收據。
 * 關聯：account → shop_users.login_id → shop_users.id
 *       收據經 user_id = shop_users.id 或 merchant_id ∈ (merchants WHERE user_id = shop_users.id)
 * 不寫入、不加表，直接沿用 expenseRecorder 原始 receipts / receipt_items 結構。
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get("account");
  if (!account) return NextResponse.json({ ok: false, error: "缺少 account" }, { status: 400 });

  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  // 1) 找 shop_users.id by login_id = account（8 位）
  const { data: shopUser, error: suErr } = await client
    .from("shop_users")
    .select("id")
    .eq("login_id", account)
    .maybeSingle();
  if (suErr) {
    if (isMissingTable(suErr))
      return NextResponse.json({ ok: true, schemaReady: false, matched: false, receipts: [] });
    return NextResponse.json({ ok: false, error: suErr.message }, { status: 500 });
  }
  if (!shopUser) {
    return NextResponse.json({
      ok: true,
      matched: false,
      receipts: [],
      message: "expenseRecorder 找不到相同帳號的店戶",
    });
  }

  // 2) 該店戶的 merchants（收據可能經 merchant_id 掛，原始結構缺表時忽略）
  const { data: merchants } = await client.from("merchants").select("id").eq("user_id", shopUser.id);
  const merchantIds = (merchants ?? []).map((m) => m.id);

  // 3) receipts（user_id 或 merchant_id）
  const orParts = [`user_id.eq.${shopUser.id}`];
  if (merchantIds.length > 0) orParts.push(`merchant_id.in.(${merchantIds.join(",")})`);
  const { data: receipts, error: rErr } = await client
    .from("receipts")
    .select("id, total_amount, receipt_date, merchant_id, raw_ocr_data, created_at")
    .or(orParts.join(","))
    .order("receipt_date", { ascending: false });
  if (rErr) {
    if (isMissingTable(rErr))
      return NextResponse.json({ ok: true, schemaReady: false, matched: true, receipts: [] });
    return NextResponse.json({ ok: false, error: rErr.message }, { status: 500 });
  }

  const ids = (receipts ?? []).map((r) => r.id);
  let items: Array<Record<string, unknown>> = [];
  if (ids.length > 0) {
    const { data: itemRows, error: iErr } = await client
      .from("receipt_items")
      .select("id, receipt_id, name, unit_price, quantity")
      .in("receipt_id", ids);
    if (iErr) {
      if (isMissingTable(iErr))
        return NextResponse.json({ ok: true, schemaReady: false, matched: true, receipts: [] });
      return NextResponse.json({ ok: false, error: iErr.message }, { status: 500 });
    }
    items = itemRows ?? [];
  }

  const itemsByReceipt = new Map<string, Array<Record<string, unknown>>>();
  for (const it of items) {
    const rid = String((it as Record<string, unknown>).receipt_id);
    const arr = itemsByReceipt.get(rid) ?? [];
    arr.push(it);
    itemsByReceipt.set(rid, arr);
  }

  const enriched = (receipts ?? []).map((r) => ({ ...r, items: itemsByReceipt.get(r.id) ?? [] }));

  return NextResponse.json({ ok: true, matched: true, receipts: enriched });
}
