import { NextResponse } from "next/server";

import { clientIp, rateLimit } from "@/lib/pos/rate-limit";
import { getSupabaseWriteClient } from "@/lib/supabase-server";

/**
 * `GET /api/public/reservations/menu?storeId=xxx`
 *
 * 客人訂位頁「預點菜」用嘅**白名單餐牌**。
 *
 * ## 點解唔直接打 `/api/pos/bootstrap`
 *
 * 嗰支係 POS 終端用，一次過回 `tables` / `printerGroups` / 完整 `rules` /
 * `categories`，對客人嚟講全部係多餘嘅內部資料；而且佢 120 次/分嘅限流
 * 係同收銀台共用，客人頁一多就會拖累開枱。
 *
 * 呢度只回「可以預點嘅菜 + 會員折扣率」，並喺 server 先濾走
 * `customerOrderable:false` / 售罄 / 停售 / 時價菜 —— 同 `priceReservationItems()`
 * 嘅拒絕條件一致，客人唔會揀完先被拒絕。
 *
 * ⚠️ 仍然**唔回價錢以外嘅商業設定**，亦唔回任何客人個資。
 */

export const dynamic = "force-dynamic";

type RawMenuItem = {
  id?: unknown;
  name?: unknown;
  price?: unknown;
  memberPrice?: unknown;
  categoryId?: unknown;
  description?: unknown;
  active?: unknown;
  soldOut?: unknown;
  isMarketPrice?: unknown;
  customerOrderable?: unknown;
};

export async function GET(request: Request) {
  const ip = clientIp(request);
  if (!rateLimit(`pub-rsv-menu:${ip}`, 120, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;
  if (!storeId) return NextResponse.json({ ok: false, error: "缺少 storeId" }, { status: 400 });

  const supabase = getSupabaseWriteClient();
  if (!supabase) return NextResponse.json({ ok: false, error: "伺服器未配置 Supabase。" }, { status: 503 });

  const { data, error } = await supabase
    .from("pos_bootstrap_config")
    .select("menu_items,rules,categories")
    .eq("store_id", storeId)
    .maybeSingle();

  if (error) {
    console.error("[public/reservations/menu] 讀取失敗", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!data) return NextResponse.json({ ok: true, menuItems: [], memberDiscountRate: null, categories: [] });

  const raw = (Array.isArray(data.menu_items) ? data.menu_items : []) as RawMenuItem[];
  const menuItems = raw
    .filter((item) => {
      if (!item || typeof item.id !== "string") return false;
      if (item.active === false || item.soldOut === true || item.isMarketPrice === true) return false;
      if (item.customerOrderable === false) return false;
      const price = Number(item.price);
      return Number.isFinite(price) && price >= 0;
    })
    .map((item) => ({
      id: String(item.id),
      name: typeof item.name === "string" ? item.name : "",
      price: Number(item.price),
      memberPrice: typeof item.memberPrice === "number" ? item.memberPrice : null,
      categoryId: typeof item.categoryId === "string" ? item.categoryId : "",
      description: typeof item.description === "string" ? item.description.slice(0, 120) : "",
    }));

  const rules = (data.rules ?? {}) as { memberDiscountRate?: unknown };
  const rate = rules.memberDiscountRate;
  const memberDiscountRate =
    typeof rate === "number" && Number.isFinite(rate) && rate > 0 && rate < 100 ? rate : null;

  const categories = Array.isArray(data.categories)
    ? (data.categories as Array<{ id?: unknown; name?: unknown }>).map((c) => ({
        id: typeof c.id === "string" ? c.id : "",
        name: typeof c.name === "string" ? c.name : "",
      }))
    : [];

  return NextResponse.json({ ok: true, menuItems, memberDiscountRate, categories });
}
