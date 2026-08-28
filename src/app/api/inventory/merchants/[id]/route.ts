import { NextResponse } from "next/server";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";
import { resolveExpenseUserId } from "@/lib/expense-inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 修改供應商名稱（店別 scope）。 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  const body = (await request.json()) as { account?: string; name?: string };
  const resolved = await resolveExpenseUserId(client, body.account ?? null);
  if ("error" in resolved) return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  const userId = resolved.userId;

  if (!body.name || !body.name.trim()) return NextResponse.json({ ok: false, error: "缺少 name" }, { status: 400 });

  const { error } = await client.from("merchants").update({ name: body.name.trim() }).eq("id", id).eq("user_id", userId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

/** 刪除供應商（若仍有收據引用則拒絕，避免懸空 merchant_id）。 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  const account = new URL(request.url).searchParams.get("account");
  const resolved = await resolveExpenseUserId(client, account);
  if ("error" in resolved) return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  const userId = resolved.userId;

  const { count, error: cErr } = await client
    .from("receipts")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", id);
  if (cErr) return NextResponse.json({ ok: false, error: cErr.message }, { status: 500 });
  if (count && count > 0) {
    return NextResponse.json({ ok: false, error: "供應商尚有用中的收據，無法刪除", code: "CONFLICT" }, { status: 409 });
  }

  const { error } = await client.from("merchants").delete().eq("id", id).eq("user_id", userId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
