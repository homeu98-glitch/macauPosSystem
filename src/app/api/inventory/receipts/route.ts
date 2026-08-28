import { NextResponse } from "next/server";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";
import {
  buildReceiptItems,
  resolveExpenseUserId,
  resolveMerchantId,
  type InventoryReceiptInput,
} from "@/lib/expense-inventory";
import {
  buildPurchaseSummary,
  receiptDateMatchesRange,
  type StatReceipt,
} from "@/lib/inventory-stats";
import type { ReportRangeKey } from "@/lib/ledger/report-period";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DbError = { code?: string; message?: string } | null;
function isMissingTable(err: DbError): boolean {
  if (!err) return false;
  if (err.code === "42P01") return true;
  return /relation .* does not exist/i.test(err.message ?? "");
}

const VALID_RANGES: ReportRangeKey[] = ["today", "yesterday", "7d", "30d", "all"];

/**
 * 唯讀：依 8 位帳號顯示 expenseRecorder 的收據，並回傳買貨統計。
 * 關聯：account → shop_users.login_id → shop_users.id
 *       收據經 user_id = shop_users.id 或 merchant_id ∈ (merchants WHERE user_id = shop_users.id)
 * 不寫入、不加表，直接沿用 expenseRecorder 原始 receipts / receipt_items 結構。
 * 支援 range（today/yesterday/7d/30d/all，澳門時區依 receipt_date 過濾）。
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get("account");
  if (!account) return NextResponse.json({ ok: false, error: "缺少 account" }, { status: 400 });

  const rawRange = searchParams.get("range") as ReportRangeKey | null;
  const range: ReportRangeKey = rawRange && VALID_RANGES.includes(rawRange) ? rawRange : "all";

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
      return NextResponse.json({ ok: true, schemaReady: false, matched: false, receipts: [], summary: buildPurchaseSummary([]) });
    return NextResponse.json({ ok: false, error: suErr.message }, { status: 500 });
  }
  if (!shopUser) {
    return NextResponse.json({
      ok: true,
      matched: false,
      receipts: [],
      summary: buildPurchaseSummary([]),
      message: "expenseRecorder 找不到相同帳號的店戶",
    });
  }

  // 2) 該店戶的 merchants（取 id + name 做供貨商名稱對照）
  const { data: merchants, error: mErr } = await client
    .from("merchants")
    .select("id, name")
    .eq("user_id", shopUser.id);
  if (mErr) {
    if (isMissingTable(mErr))
      return NextResponse.json({ ok: true, schemaReady: false, matched: true, receipts: [], summary: buildPurchaseSummary([]) });
    return NextResponse.json({ ok: false, error: mErr.message }, { status: 500 });
  }
  const merchantIds = (merchants ?? []).map((m) => m.id);
  const merchantNameById = new Map<string, string>(
    (merchants ?? []).map((m) => [m.id, typeof m.name === "string" && m.name.trim() ? m.name.trim() : "未知供應商"]),
  );

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
      return NextResponse.json({ ok: true, schemaReady: false, matched: true, receipts: [], summary: buildPurchaseSummary([]) });
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
        return NextResponse.json({ ok: true, schemaReady: false, matched: true, receipts: [], summary: buildPurchaseSummary([]) });
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

  const toStatReceipt = (r: Record<string, unknown>): StatReceipt => {
    const raw = (r.raw_ocr_data ?? null) as Record<string, unknown> | null;
    const getRaw = (key: string): string => {
      const v = raw?.[key];
      return typeof v === "string" && v.trim() ? v.trim() : "";
    };
    const receiptItems = (itemsByReceipt.get(String(r.id)) ?? []).map((it) => {
      const item = it as Record<string, unknown>;
      return {
        name: typeof item.name === "string" ? item.name : "未命名品項",
        unit_price: Number(item.unit_price) || 0,
        quantity: Number(item.quantity) || 1,
      };
    });
    return {
      id: String(r.id),
      merchant_name: merchantNameById.get(String(r.merchant_id ?? "")) ?? "未知供應商",
      receipt_date: typeof r.receipt_date === "string" ? r.receipt_date : "",
      total_amount: Number(r.total_amount) || 0,
      payment_status: getRaw("payment_status") || "unpaid",
      payment_method: getRaw("payment_method") || "on_delivery",
      items: receiptItems,
    };
  };

  // 4) 依 range 過濾（澳門時區，in-memory）
  const statReceipts: StatReceipt[] = (receipts ?? [])
    .filter((r) => receiptDateMatchesRange(String(r.receipt_date ?? ""), range))
    .map(toStatReceipt);

  const enriched = statReceipts.map((sr) => ({
    id: sr.id,
    total_amount: sr.total_amount,
    receipt_date: sr.receipt_date,
    merchant_id: (receipts ?? []).find((r) => r.id === sr.id)?.merchant_id ?? null,
    merchant_name: sr.merchant_name,
    payment_method: sr.payment_method,
    payment_status: sr.payment_status,
    raw_ocr_data: (receipts ?? []).find((r) => r.id === sr.id)?.raw_ocr_data ?? null,
    items: sr.items,
  }));

  const summary = buildPurchaseSummary(statReceipts);

  return NextResponse.json({ ok: true, matched: true, range, receipts: enriched, summary });
}

/**
 * 新增收據（mirror expenseRecorder save-receipt）：解析 user_id → upsert 供應商 → 插 receipts → 批量插 receipt_items。
 * 寫入 expenseRecorder 現有 receipts / receipt_items / merchants，不新增 table。
 */
export async function POST(request: Request) {
  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  let body: InventoryReceiptInput;
  try {
    body = (await request.json()) as InventoryReceiptInput;
  } catch {
    return NextResponse.json({ ok: false, error: "無效的 JSON 內容" }, { status: 400 });
  }

  const resolved = await resolveExpenseUserId(client, body.account ?? null);
  if ("error" in resolved) return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  const userId = resolved.userId;

  if (!body.date) return NextResponse.json({ ok: false, error: "缺少 date" }, { status: 400 });

  const merchant = await resolveMerchantId(client, userId, {
    merchant_id: body.merchant_id,
    merchant_name: body.merchant_name,
  });
  if ("error" in merchant) return NextResponse.json({ ok: false, error: merchant.error }, { status: merchant.status });

  const receiptPayload = {
    user_id: userId,
    merchant_id: merchant.merchantId,
    total_amount: Number(body.total_amount) || 0,
    receipt_date: body.date,
    raw_ocr_data: {
      receipt_number: body.receipt_number || null,
      payment_method: body.payment_method || "on_delivery",
      payment_status: body.payment_status || "unpaid",
      input_method: "pos_manual",
    },
  };

  const { data: receipt, error: rErr } = await client
    .from("receipts")
    .insert(receiptPayload)
    .select("id")
    .single();
  if (rErr) return NextResponse.json({ ok: false, error: rErr.message }, { status: 500 });

  const itemRows = buildReceiptItems(receipt.id, userId, body.items);
  if (itemRows.length > 0) {
    const { error: iErr } = await client.from("receipt_items").insert(itemRows);
    if (iErr) return NextResponse.json({ ok: false, error: iErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: receipt.id });
}
