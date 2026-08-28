import { NextResponse } from "next/server";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";
import { resolveExpenseUserId } from "@/lib/expense-inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 新增供應商（mirror save-receipt 的 merchants upsert）。 */
export async function POST(request: Request) {
  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  const body = (await request.json()) as { account?: string; name?: string };
  const resolved = await resolveExpenseUserId(client, body.account ?? null);
  if ("error" in resolved) return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  const userId = resolved.userId;

  if (!body.name || !body.name.trim()) return NextResponse.json({ ok: false, error: "缺少 name" }, { status: 400 });

  const { data, error } = await client
    .from("merchants")
    .upsert({ name: body.name.trim(), user_id: userId }, { onConflict: "user_id, name" })
    .select("id")
    .single();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, id: data.id });
}
