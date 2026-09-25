import { NextResponse } from "next/server";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";
import { isMissingColumnOrTable, resolveExpenseUserId } from "@/lib/expense-inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 🔴 expenseRecorder 會將「設定」偷藏喺 `merchants` 表，用保留名做 key：
 *   · `__shop_settings__:<userId>` → 門店設定（自訂單位、賬戶狀態）
 *   · `__global_settings__`        → 全域設定（單位清單、支付方式主檔）
 * 呢啲唔係供應商。`merchants.name` 係**全表唯一**，所以保留名唔會同真實供應商撞，
 * 但**只要查詢冇加 user_id 篩選／冇過濾**就會漏佢出嚟，變成下拉選單一項叫
 * `__shop_settings__:xxxxxxxx-...` 嘅假供應商。
 *
 * 規則：真實供應商名唔會以 `__` 開頭 ⇒ 一律當保留名濾走。
 *
 * ⚠️ 刻意喺 JS 過濾而唔用 PostgREST `.not("name","like","__%")`：
 * SQL `LIKE` 嘅 `_` 係「任一字元」通配符，`__%` 實際會 match 幾乎所有名
 * （＝會濾走全部供應商），要正確就要 escape backslash，好易靜靜搞錯。
 */
function isReservedMerchantName(name: string): boolean {
  return name.startsWith("__");
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
    if (isMissingColumnOrTable(error))
      return NextResponse.json({ ok: true, schemaReady: false, merchants: [] });
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    merchants: (data ?? [])
      .map((m) => ({ id: String(m.id), name: String(m.name ?? "") }))
      .filter((m) => m.id && m.name && !isReservedMerchantName(m.name)),
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

  // 🔴 唔畀用保留名前綴：`__` 開頭係 expenseRecorder 嘅內部設定列
  // （`__global_settings__` 等）。雖然全域 unique 會擋住覆蓋，但錯誤訊息會變成
  // 一句莫名奇妙嘅 unique 衝突；喺入口直接講清楚好過。
  if (name.startsWith("__")) {
    return NextResponse.json({ ok: false, error: "供應商名稱不可以「__」開頭。" }, { status: 400 });
  }

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
