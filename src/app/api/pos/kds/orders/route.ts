import { NextResponse } from "next/server";

import { getSupabaseWriteClient } from "@/lib/supabase-server";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";
import { readPosDeviceTokenFromRequest } from "@/lib/pos/pos-device-token";
import { isKdsStation } from "@/lib/kds/stations";
import {
  authorizeKdsRequest,
  isMissingKdsTable,
  loadKdsItemStates,
  loadKdsOrderForWrite,
} from "@/lib/kds/kds-server";
import type { PosOrder } from "@/lib/types";

/**
 * 出餐台屏「確認出餐 / 撤回」（docs/116 §6.4）。
 *
 *   POST /api/pos/kds/orders
 *   { "storeId": "…", "orderId": "…", "action": "ready" | "recall" }
 *
 * | action | 做乜 | 前置條件 |
 * |---|---|---|
 * | `ready` | `pos_orders.fulfillment_status = 'ready'`、`served_at = now()` | **全部非退菜單品都 `done_qty >= quantity`**，否則 409 + 欠幾多 |
 * | `recall` | 清走該單全部 `pos_kds_item_state`（`done_qty = 0`）、`fulfillment_status` 回 `preparing` | 隨時（客人退單 / 出錯） |
 *
 * ⚠️ `ready` **一定要有前置檢查**。冇嘅話出餐台可以「未齊就出餐」→
 * 客人返嚟話少咗一碟，而系統顯示「已出餐」—— 查都查唔到。
 *
 * ⚠️ `recall` **唔可以碰 `pos_orders.status`**（結帳狀態機），亦**唔可以**叫
 * `update_order_status()`。只有 `fulfillment_status` / `served_at` 係 KDS 嘅地盤。
 */
export const dynamic = "force-dynamic";

interface OrderBody {
  storeId?: unknown;
  orderId?: unknown;
  action?: unknown;
}

interface AggregatedItem {
  itemKey: string;
  name: string;
  station: string;
  quantity: number;
}

/** 合併同一 key 嘅行（同 `kds-board.ts` 同口徑：時價菜會撞 key）。 */
function aggregateOrderItems(order: PosOrder, itemKeys: string[]): AggregatedItem[] {
  const map = new Map<string, AggregatedItem>();
  order.items.forEach((item, index) => {
    if (item.voided) return;
    const key = itemKeys[index];
    if (!key) return;
    const quantity = Math.trunc(Number(item.quantity ?? 0));
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    const station = String(item.printerGroup ?? "").trim();
    if (!isKdsStation(station)) return;

    const existing = map.get(key);
    if (existing) {
      existing.quantity += quantity;
      return;
    }
    map.set(key, { itemKey: key, name: String(item.name ?? ""), station, quantity });
  });
  return [...map.values()];
}

export async function POST(request: Request) {
  const ip = clientIp(request);
  if (!rateLimit(`pos-kds-orders:${ip}`, 120, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const body = (await request.json().catch(() => null)) as OrderBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "請求格式錯誤。" }, { status: 400 });
  }

  const storeId = String(body.storeId ?? "").trim();
  const orderId = String(body.orderId ?? "").trim();
  const action = String(body.action ?? "").trim();

  if (!storeId || !orderId) {
    return NextResponse.json({ ok: false, error: "缺少 storeId / orderId。" }, { status: 400 });
  }
  if (action !== "ready" && action !== "recall") {
    return NextResponse.json(
      { ok: false, error: 'action 只可以係 "ready" 或 "recall"。' },
      { status: 400 },
    );
  }

  const auth = authorizeKdsRequest(request, storeId);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  const by = readPosDeviceTokenFromRequest(request)?.account ?? null;

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

  const aggregated = aggregateOrderItems(found.order, found.itemKeys);
  const nowIso = new Date().toISOString();

  const statesRes = await loadKdsItemStates(supabase, storeId, [orderId]);
  if (statesRes.error) {
    return NextResponse.json({ ok: false, error: statesRes.error.message }, { status: 500 });
  }

  const doneByKey = new Map(statesRes.states.map((s) => [s.item_key, s.done_qty]));

  if (action === "ready") {
    // 🔴 前置檢查：仲欠幾多？
    const shortfall = aggregated
      .map((item) => {
        const done = Math.max(0, Math.min(doneByKey.get(item.itemKey) ?? 0, item.quantity));
        return { itemKey: item.itemKey, name: item.name, station: item.station, quantity: item.quantity, doneQty: done };
      })
      .filter((item) => item.doneQty < item.quantity);

    if (shortfall.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          code: "not_all_done",
          error: "仲有菜品未完成，唔可以確認出餐。",
          shortfall,
        },
        { status: 409 },
      );
    }

    // ⚠️ 只寫 fulfillment_status / served_at。**絕對唔可以**碰 status。
    const { error } = await supabase
      .from("pos_orders")
      .update({ fulfillment_status: "ready", served_at: nowIso })
      .eq("store_id", storeId)
      .eq("id", orderId);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      action,
      fulfillmentStatus: "ready",
      servedAt: nowIso,
      serverTime: nowIso,
    });
  }

  // action === "recall"
  // 清走該單全部單品狀態（done_qty = 0）—— 用 upsert 而唔係 delete，
  // 咁 Realtime 出嘅係 UPDATE（帶完整新行），客戶端唔使靠 REPLICA IDENTITY FULL 先收到舊值。
  if (aggregated.length > 0) {
    const rows = aggregated.map((item) => ({
      store_id: storeId,
      order_id: orderId,
      item_key: item.itemKey,
      station: item.station,
      done_qty: 0,
      done_at: null,
      done_by: by,
      updated_at: nowIso,
    }));
    const { error } = await supabase
      .from("pos_kds_item_state")
      .upsert(rows, { onConflict: "store_id,order_id,item_key" });

    if (error && !isMissingKdsTable(error)) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
  }

  const { error: updateError } = await supabase
    .from("pos_orders")
    .update({ fulfillment_status: "preparing", served_at: null })
    .eq("store_id", storeId)
    .eq("id", orderId);

  if (updateError) {
    return NextResponse.json({ ok: false, error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    action,
    fulfillmentStatus: "preparing",
    clearedItems: aggregated.length,
    serverTime: nowIso,
  });
}
