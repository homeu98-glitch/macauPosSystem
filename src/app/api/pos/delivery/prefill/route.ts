import { NextResponse } from "next/server";

import { extractPlatformCustomer } from "@/lib/pos/delivery/platform-customer";
import { posRouteAuthGuard } from "@/lib/pos/pos-route-auth";
import { getSupabaseWriteClient } from "@/lib/supabase-server";

/**
 * 平台單「客人送貨資料」預填（單張）。
 *
 * ## 為什麼要呢支 route
 *
 * 平台單（澳覓／MFOOD）嘅 `raw_json` **本身有地址同電話**（見
 * `platform-customer.ts` 頂部嘅插件行號），但 `projectGrabberOrder()` 冇投影出嚟，
 * `pos_orders` 亦冇客人欄位。商家派單時如果要重新打一次地址，係抄單、易錯。
 *
 * 呢支 route 喺**派單彈窗打開嗰一刻**讀一張單，抽返姓名／電話／地址／備註出嚟預填。
 *
 * ## 為什麼唔一次過回一批（同 `/modes` 唔同）
 *
 * `/modes` 只回 enum（幾十 bytes × N）。但呢度回嘅係**個資**（姓名、電話、地址）；
 * 一次過回晒畫面上十幾張平台單，等於將全店客人資料傾倒去前端，
 * 而商家一次只會派一張。所以刻意做成「一張一張拉」。
 *
 * ## 唔會回傳 raw payload
 *
 * 只回抽好嘅四個字串，`raw_json` 永遠留喺 server。
 *
 * ## schema 降級
 *
 * 舊 schema 冇 `raw_json`（42703 / PGRST204）→ 回空 prefill，
 * 彈窗照舊要人手填，唔會爆。
 */

export const dynamic = "force-dynamic";

function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "42703" || code === "PGRST204") return true;
  const message = String(error.message ?? "");
  return /column .*raw_json.* does not exist/i.test(message) ||
    /Could not find the 'raw_json' column/i.test(message);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;
  const orderId = searchParams.get("orderId")?.trim() || null;

  if (!storeId || !orderId) {
    return NextResponse.json({ ok: false, error: "missing_params" }, { status: 400 });
  }

  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json({ ok: true, prefill: {} });
  }

  // 🔒 同其他 POS route 一致：early-return 之後才落閘
  const denied = posRouteAuthGuard(request, storeId, "pos/delivery/prefill");
  if (denied) return denied;

  const { data, error } = await supabase
    .from("pos_orders")
    .select("id,source,raw_json")
    .eq("store_id", storeId)
    .eq("id", orderId)
    .maybeSingle();

  if (error) {
    if (isMissingColumn(error)) {
      return NextResponse.json({ ok: true, prefill: {}, reason: "raw_json_missing" });
    }
    console.error("[pos/delivery/prefill] 讀取失敗", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const row = data as { id?: string; source?: string | null; raw_json?: unknown } | null;
  if (!row) {
    return NextResponse.json({ ok: true, prefill: {} });
  }

  return NextResponse.json({
    ok: true,
    prefill: extractPlatformCustomer(row.source, row.raw_json),
  });
}
