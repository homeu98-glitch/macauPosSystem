import { NextResponse } from "next/server";

import { listAdminDataFromServer } from "@/lib/admin-account-server";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { UserRole } from "@/lib/types";

export async function GET() {
  const result = await listAdminDataFromServer();
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }
  return NextResponse.json(result);
}

export async function POST(request: Request) {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "未配置資料庫，暫時只能使用本地模式。" }, { status: 503 });
  }

  const payload = (await request.json()) as {
    name?: string;
    account?: string;
    pin?: string;
    role?: UserRole;
    permissionGroupId?: string;
    storeIds?: string[];
    note?: string;
  };

  const name = (payload.name ?? "").trim();
  const account = String(payload.account ?? "").replace(/\D/g, "").slice(0, 8);
  const pin = String(payload.pin ?? "").replace(/\D/g, "").slice(0, 4);
  const role = (payload.role ?? "cashier") as UserRole;
  const storeIds = Array.isArray(payload.storeIds) ? payload.storeIds : [];
  const permissionGroupId = payload.permissionGroupId ?? null;
  const now = new Date().toISOString();

  if (!name || !/^\d{8}$/.test(account) || !/^\d{4}$/.test(pin)) {
    return NextResponse.json({ ok: false, error: "請填寫姓名、8 位帳號與 4 位 PIN。" }, { status: 400 });
  }

  const { data: inserted, error } = await supabase
    .from("admin_account_users")
    .insert({
      account,
      pin_code: pin,
      name,
      role,
      active: true,
      permission_group_id: permissionGroupId,
      note: payload.note ?? "",
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();

  if (error || !inserted) {
    return NextResponse.json({ ok: false, error: error?.message ?? "新增帳戶失敗。" }, { status: 400 });
  }

  if (storeIds.length > 0) {
    await supabase.from("admin_account_store_bindings").insert(
      storeIds.map((storeId) => ({
        account_id: inserted.id,
        store_id: storeId,
        created_at: now,
      })),
    );
  }

  return GET();
}

export async function PUT(request: Request) {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "未配置資料庫，暫時只能使用本地模式。" }, { status: 503 });
  }

  const payload = (await request.json()) as {
    id?: string;
    name?: string;
    pin?: string;
    role?: UserRole;
    active?: boolean;
    permissionGroupId?: string | null;
    storeIds?: string[];
    note?: string;
  };

  if (!payload.id) {
    return NextResponse.json({ ok: false, error: "缺少帳戶 ID。" }, { status: 400 });
  }

  const updateData: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (typeof payload.name === "string") updateData.name = payload.name.trim();
  if (typeof payload.pin === "string" && /^\d{4}$/.test(payload.pin)) updateData.pin_code = payload.pin;
  if (payload.role) updateData.role = payload.role;
  if (typeof payload.active === "boolean") updateData.active = payload.active;
  if ("permissionGroupId" in payload) updateData.permission_group_id = payload.permissionGroupId ?? null;
  if (typeof payload.note === "string") updateData.note = payload.note;

  const { error } = await supabase.from("admin_account_users").update(updateData).eq("id", payload.id);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }

  if (Array.isArray(payload.storeIds)) {
    await supabase.from("admin_account_store_bindings").delete().eq("account_id", payload.id);
    if (payload.storeIds.length > 0) {
      await supabase.from("admin_account_store_bindings").insert(
        payload.storeIds.map((storeId) => ({
          account_id: payload.id,
          store_id: storeId,
          created_at: new Date().toISOString(),
        })),
      );
    }
  }

  return GET();
}

export async function DELETE(request: Request) {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "未配置資料庫，暫時只能使用本地模式。" }, { status: 503 });
  }

  const payload = (await request.json()) as { id?: string };
  if (!payload.id) {
    return NextResponse.json({ ok: false, error: "缺少帳戶 ID。" }, { status: 400 });
  }

  await supabase.from("admin_account_store_bindings").delete().eq("account_id", payload.id);
  const { error } = await supabase.from("admin_account_users").delete().eq("id", payload.id);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }

  return GET();
}
