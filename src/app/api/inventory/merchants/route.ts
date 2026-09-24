import { NextResponse } from "next/server";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";
import { resolveExpenseUserId } from "@/lib/expense-inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "42P01") return true;
  return /relation .* does not exist/i.test(err.message ?? "");
}

/**
 * 唯讀：列出本店（account → shop_users.id → merchants.user_id）的**全部**供應商。
 *
 * 🔴 2026-09-25：以前前端係由「收據反推」供應商（`inventory-view.tsx` 嘅
 * `suppliers` useMemo），後果三重：
 *   ① 冇收據嘅供應商永遠唔會出現（啱啱新增完都唔見）；
 *   ② 清單會跟住 range 篩選變化（range=today 時尋日嘅供應商全部消失）；
 *   ③ 收據 modal 嘅 datalist 因此經常係空 → 用戶以為「冇呢個供應商」→ 重複新增
 *      → 撞 unique constraint 報 duplicate key。
 * 所以改為直接讀 merchants 表（唔經收據），下拉選單先至有完整來源。
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get("account");
  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  const resolved = await resolveExpenseUserId(client, account);
  if ("error" in resolved) return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });

  const { data, error } = await client
    .from("merchants")
    .select("id, name")
    .eq("user_id", resolved.userId)
    .order("name", { ascending: true });
  if (error) {
    if (isMissingTable(error))
      return NextResponse.json({ ok: true, schemaReady: false, merchants: [] });
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    merchants: (data ?? []).map((m) => ({ id: String(m.id), name: String(m.name ?? "") })),
  });
}

/** 新增供應商（mirror save-receipt 的 merchants upsert）。 */
export async function POST(request: Request) {
  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  const body = (await request.json()) as { account?: string; name?: string };
  const resolved = await resolveExpenseUserId(client, body.account ?? null);
  if ("error" in resolved) return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  const userId = resolved.userId;

  if (!body.name || !body.name.trim()) return NextResponse.json({ ok: false, error: "缺少 name" }, { status: 400 });
  const name = body.name.trim();

  const { data, error } = await client
    .from("merchants")
    .upsert({ name, user_id: userId }, { onConflict: "user_id, name" })
    .select("id")
    .single();

  if (error) {
    // 🔴 2026-09-25：raw Postgres 訊息（英文、含 constraint 名）直接丟上 UI
    // 等於冇提示。duplicate key（23505）／冇對應 unique 約束（42P10）一律
    // 轉做「已存在」語義：
    //   - 本店已經有同名 → 回 409 + ALREADY_EXISTS + 既有 supplier（前端可 highlight）
    //   - 本店冇、但撞到**跨店**唯一（例如 merchants.name 全表唯一）→ 回 409 + NAME_TAKEN，
    //     並且**唔回傳**嗰個 id（唔可以畀本店掛起第二間店嘅 supplier）。
    const msg = error.message ?? "";
    const isConflict =
      error.code === "23505" || error.code === "42P10" ||
      /duplicate key/i.test(msg) || /no unique or exclusion constraint/i.test(msg);
    if (isConflict) {
      const { data: mine } = await client
        .from("merchants")
        .select("id, name")
        .eq("user_id", userId)
        .ilike("name", name)
        .maybeSingle();
      if (mine?.id) {
        return NextResponse.json(
          { ok: false, code: "ALREADY_EXISTS", error: `「${name}」已經存在，無需重複新增。`, merchant: { id: String(mine.id), name: String(mine.name ?? name) } },
          { status: 409 },
        );
      }
      const constraint = /constraint "([^"]+)"/.exec(msg)?.[1] ?? "未知約束";
      return NextResponse.json(
        {
          ok: false,
          code: "NAME_TAKEN",
          error: `「${name}」與資料庫既有供應商衝突（${constraint}），無法新增。請改用其他名稱，或聯絡系統管理員。`,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: data.id });
}
