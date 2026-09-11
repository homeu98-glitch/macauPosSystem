import { NextResponse } from "next/server";

import { getSupabaseWriteClient } from "@/lib/supabase-server";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";
import { readPosDeviceTokenFromRequest } from "@/lib/pos/pos-device-token";
import { isLegacyNonStation } from "@/lib/kds/stations";
import { authorizeKdsRequest, isMissingKdsTable, loadKdsOrderForWrite } from "@/lib/kds/kds-server";
import type { PosOrder } from "@/lib/types";

/**
 * 標記單品「已出幾多份」（docs/116 §6.3）。
 *
 *   POST /api/pos/kds/items
 *   { "storeId": "…", "orderId": "…", "itemKey": "…", "doneQty": 3 }
 *
 * ## 幾條硬規則
 *
 * 1. **一定要驗 `itemKey` 真係存在**。唔驗就會有人亂掉 key 落去，
 *    `pos_kds_item_state` 慢慢積累一堆永遠對唔返訂單嘅垃圾行。
 * 2. **`doneQty` 要 clamp 到 `[0, quantity]`**。減件之後舊值可能大過新數量。
 * 3. **絕對唔可以喺呢條路寫 `pos_orders`**。單品狀態同訂單係兩個寫入者，
 *    混埋一齊就會互相覆蓋（docs/116 §5.2）。「確認出餐」係另一條端點。
 * 4. **`done_by` 由終端憑證拎，唔信 body** —— 否則可以冒名。
 *
 * ⚠️ 呢條路係「**樂觀 UI 嘅落點**」：客戶端撳 ✓ 已經即刻本地 +1，
 * 呢度失敗就要**回滾 + 出紅橫幅**，唔可以靜靜當成功（docs/116 §3.3）。
 */
export const dynamic = "force-dynamic";

interface ItemBody {
  storeId?: unknown;
  orderId?: unknown;
  itemKey?: unknown;
  doneQty?: unknown;
}

/** 由訂單嘅 items + itemKeys 揾出目標 key 嘅**合併後**數量同工位。 */
function resolveItem(
  order: PosOrder,
  itemKeys: string[],
  target: string,
): { quantity: number; station: string; name: string } | null {
  let quantity = 0;
  let station = "";
  let name = "";
  order.items.forEach((item, index) => {
    // 退菜嗰行唔算數（同 kds-board.ts 嘅口徑一致）
    if (item.voided) return;
    if (itemKeys[index] !== target) return;
    quantity += Math.trunc(Number(item.quantity ?? 0));
    station = String(item.printerGroup ?? "").trim();
    name = String(item.name ?? "");
  });
  return quantity > 0 ? { quantity, station, name } : null;
}

export async function POST(request: Request) {
  const ip = clientIp(request);
  if (!rateLimit(`pos-kds-items:${ip}`, 600, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const body = (await request.json().catch(() => null)) as ItemBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "請求格式錯誤。" }, { status: 400 });
  }

  const storeId = String(body.storeId ?? "").trim();
  const orderId = String(body.orderId ?? "").trim();
  const itemKey = String(body.itemKey ?? "");
  const rawDone = Number(body.doneQty);

  if (!storeId || !orderId || !itemKey) {
    return NextResponse.json({ ok: false, error: "缺少 storeId / orderId / itemKey。" }, { status: 400 });
  }
  if (!Number.isFinite(rawDone)) {
    return NextResponse.json({ ok: false, error: "doneQty 必須係數字。" }, { status: 400 });
  }

  const auth = authorizeKdsRequest(request, storeId);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  // 審計用：由憑證拎帳號，唔信 body
  const by = readPosDeviceTokenFromRequest(request)?.account ?? null;

  // 寫入一定要 service role（0016 之後業務表全部收做 service_role-only）
  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "Supabase 寫入未配置（缺少 service role key），確認出餐無法保存。" },
      { status: 503 },
    );
  }

  const found = await loadKdsOrderForWrite(supabase, storeId, orderId);
  if (found.error) {
    return NextResponse.json({ ok: false, error: found.error.message }, { status: 500 });
  }
  if (!found.order) {
    return NextResponse.json({ ok: false, code: "order_not_found", error: "搵唔到呢張單。" }, { status: 404 });
  }

  const resolved = resolveItem(found.order, found.itemKeys, itemKey);
  if (!resolved) {
    return NextResponse.json(
      { ok: false, code: "item_not_found", error: "呢張單冇對應嘅菜品（itemKey 唔啱）。" },
      { status: 400 },
    );
  }

  // 冇分區 / 舊資料排除項（receipt / label）唔應該有後廚屏狀態 —— 擋住唔畀寫垃圾行。
  // ⚠️ 自訂分區（後廚3、EricTest…）**一律要放行**，唔可以再收窄。
  if (!resolved.station || isLegacyNonStation(resolved.station)) {
    return NextResponse.json(
      { ok: false, code: "not_a_station", error: "呢個菜品唔屬於任何打印分區。" },
      { status: 400 },
    );
  }

  const doneQty = Math.max(0, Math.min(Math.trunc(rawDone), resolved.quantity));
  const nowIso = new Date().toISOString();

  const { error } = await supabase.from("pos_kds_item_state").upsert(
    {
      store_id: storeId,
      order_id: orderId,
      item_key: itemKey,
      station: resolved.station,
      done_qty: doneQty,
      // cooking_at 留空：P0 未用（產能看板 P3 先填）。唔好為咗填佢多打一次 DB ——
      // 呢條路係全屏最熱嘅路徑（廚房一秒撳幾下），延遲最緊要。
      done_at: doneQty >= resolved.quantity ? nowIso : null,
      done_by: by,
      updated_at: nowIso,
    },
    { onConflict: "store_id,order_id,item_key" },
  );

  if (error) {
    // ⚠️ 表未建（migration 0033 未跑）→ 一定要回非 2xx。
    // 回 200 = 客戶端會當「已上雲」，但其實乜都冇存 = 最難 debug 嘅靜默不一致。
    if (isMissingKdsTable(error)) {
      return NextResponse.json(
        {
          ok: false,
          code: "kds_state_table_missing",
          error: "後廚狀態表未建立（migration 0033 未跑），確認出餐無法保存。",
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    // 回權威值，畀客戶端即時校正樂觀 UI（唔使等 realtime 行返嚟）
    item: {
      orderId,
      itemKey,
      station: resolved.station,
      name: resolved.name,
      quantity: resolved.quantity,
      doneQty,
    },
    serverTime: nowIso,
  });
}
