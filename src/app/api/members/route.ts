import { NextResponse } from "next/server";

import { defaultMembers } from "@/lib/mock-data";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const phone = (searchParams.get("phone") ?? "").trim();

  const supabase = getSupabaseServerClient();

  if (!supabase) {
    const members = phone
      ? defaultMembers.filter((member) => member.phone.includes(phone))
      : defaultMembers;

    return NextResponse.json({
      ok: true,
      members,
    });
  }

  let query = supabase.from("pos_members").select("*").order("updated_at", { ascending: false }).limit(200);
  if (phone) {
    query = query.ilike("phone", `%${phone}%`);
  }

  const [{ data: membersData, error: membersError }, { data: couponsData, error: couponsError }] = await Promise.all([
    query,
    supabase.from("pos_member_coupons").select("*").order("created_at", { ascending: false }).limit(500),
  ]);

  if (membersError || couponsError) {
    return NextResponse.json(
      { ok: false, error: membersError?.message ?? couponsError?.message ?? "讀取會員失敗" },
      { status: 500 },
    );
  }

  const couponMap = new Map<string, typeof couponsData>();
  (couponsData ?? []).forEach((coupon) => {
    const list = couponMap.get(coupon.member_id) ?? [];
    list.push(coupon);
    couponMap.set(coupon.member_id, list);
  });

  return NextResponse.json({
    ok: true,
    members:
      membersData?.map((member) => ({
        id: member.id,
        name: member.name,
        phone: member.phone,
        balance: Number(member.balance ?? 0),
        level: member.level ?? undefined,
        coupons:
          couponMap.get(member.id)?.map((coupon) => ({
            id: coupon.id,
            title: coupon.title,
            type: coupon.type,
            amountOff: coupon.amount_off ?? undefined,
            percentOff: coupon.percent_off ?? undefined,
            maxOff: coupon.max_off ?? undefined,
            minSpend: coupon.min_spend ?? undefined,
            stackable: Boolean(coupon.stackable),
            expiresAt: coupon.expires_at ?? undefined,
            usedAt: coupon.used_at ?? undefined,
          })) ?? [],
      })) ?? [],
  });
}

export async function POST(request: Request) {
  const payload = (await request.json()) as {
    action?: "recharge" | "create";
    memberId?: string;
    amount?: number;
    name?: string;
    phone?: string;
    level?: string;
  };

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ ok: true });
  }

  if (payload.action === "create") {
    const name = (payload.name ?? "").trim();
    const phone = (payload.phone ?? "").trim();
    if (!name || !/^\d{8}$/.test(phone)) {
      return NextResponse.json({ ok: false, error: "姓名或手機號碼不正確" }, { status: 400 });
    }

    const memberId = crypto.randomUUID();
    const { data, error } = await supabase
      .from("pos_members")
      .insert({
        id: memberId,
        store_id: "macau-store-a",
        name,
        phone,
        balance: 0,
        level: payload.level ?? null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select("*")
      .maybeSingle();

    if (error || !data) {
      return NextResponse.json({ ok: false, error: error?.message ?? "新增會員失敗" }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      member: {
        id: data.id,
        name: data.name,
        phone: data.phone,
        balance: Number(data.balance ?? 0),
        level: data.level ?? undefined,
        coupons: [],
      },
    });
  }

  if (payload.action !== "recharge" || !payload.memberId) {
    return NextResponse.json({ ok: false, error: "不支援的操作" }, { status: 400 });
  }

  const { data: member, error: readError } = await supabase
    .from("pos_members")
    .select("*")
    .eq("id", payload.memberId)
    .maybeSingle();

  if (readError || !member) {
    return NextResponse.json({ ok: false, error: readError?.message ?? "會員不存在" }, { status: 500 });
  }

  const nextBalance = Number(member.balance ?? 0) + Number(payload.amount ?? 0);
  const { data, error } = await supabase
    .from("pos_members")
    .update({ balance: nextBalance, updated_at: new Date().toISOString() })
    .eq("id", payload.memberId)
    .select("*")
    .maybeSingle();

  if (error || !data) {
    return NextResponse.json({ ok: false, error: error?.message ?? "充值失敗" }, { status: 500 });
  }

  const { data: coupons } = await supabase.from("pos_member_coupons").select("*").eq("member_id", payload.memberId);

  return NextResponse.json({
    ok: true,
    member: {
      id: data.id,
      name: data.name,
      phone: data.phone,
      balance: Number(data.balance ?? 0),
      level: data.level ?? undefined,
      coupons:
        coupons?.map((coupon) => ({
          id: coupon.id,
          title: coupon.title,
          type: coupon.type,
          amountOff: coupon.amount_off ?? undefined,
          percentOff: coupon.percent_off ?? undefined,
          maxOff: coupon.max_off ?? undefined,
          minSpend: coupon.min_spend ?? undefined,
          stackable: Boolean(coupon.stackable),
          expiresAt: coupon.expires_at ?? undefined,
          usedAt: coupon.used_at ?? undefined,
        })) ?? [],
    },
  });
}
