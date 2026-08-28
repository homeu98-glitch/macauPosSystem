import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

export type InvProduct = {
  id: string;
  store_id: string;
  name: string;
  category: string | null;
  unit: string;
  current_qty: number;
  avg_unit_cost: number;
  last_purchase_date: string | null;
  last_supplier: string | null;
  reorder_level: number;
  note: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type InvProductInput = {
  name?: string;
  category?: string | null;
  unit?: string;
  reorder_level?: number;
  note?: string | null;
  is_active?: boolean;
};

export type SyncSummary = {
  created: number;
  updated: number;
  total_after: number;
  scanned_receipts: number;
  scanned_items: number;
};

/** 列出某店的所有庫存品（依 updated_at desc）。 */
export async function listProducts(client: SupabaseClient, storeId: string) {
  const { data, error } = await client
    .from("inv_products")
    .select("*")
    .eq("store_id", storeId)
    .order("name", { ascending: true });
  if (error) return { error: error.message, status: 500 } as const;
  return { data: (data ?? []) as InvProduct[] } as const;
}

/** 新增庫存品（依 store_id+name 唯一）。 */
export async function createProduct(
  client: SupabaseClient,
  storeId: string,
  input: { name: string; category?: string; unit?: string; reorder_level?: number; note?: string },
) {
  if (!input.name?.trim()) return { error: "缺少 name", status: 400 } as const;
  const { data, error } = await client
    .from("inv_products")
    .insert({
      store_id: storeId,
      name: input.name.trim(),
      category: input.category?.trim() || null,
      unit: input.unit?.trim() || "unit",
      reorder_level: Number(input.reorder_level) || 0,
      note: input.note?.trim() || null,
    })
    .select("*")
    .single();
  if (error) return { error: error.message, status: 500 } as const;
  return { data: data as InvProduct } as const;
}

/** 修改庫存品 meta（不動 current_qty / avg_unit_cost，這兩個由 sync / adjust 維護）。 */
export async function updateProduct(
  client: SupabaseClient,
  storeId: string,
  id: string,
  input: InvProductInput,
) {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.category !== undefined) patch.category = input.category?.trim() || null;
  if (input.unit !== undefined) patch.unit = input.unit.trim() || "unit";
  if (input.reorder_level !== undefined) patch.reorder_level = Number(input.reorder_level) || 0;
  if (input.note !== undefined) patch.note = input.note?.trim() || null;
  if (input.is_active !== undefined) patch.is_active = input.is_active;

  const { data, error } = await client
    .from("inv_products")
    .update(patch)
    .eq("id", id)
    .eq("store_id", storeId)
    .select("*")
    .single();
  if (error) return { error: error.message, status: 500 } as const;
  return { data: data as InvProduct } as const;
}

/** 刪除庫存品（cascade 刪 movements）。 */
export async function deleteProduct(client: SupabaseClient, storeId: string, id: string) {
  const { error } = await client.from("inv_products").delete().eq("id", id).eq("store_id", storeId);
  if (error) return { error: error.message, status: 500 } as const;
  return { ok: true } as const;
}

/** 盤點：設定新的 current_qty，記錄一筆 adjust 異動。 */
export async function adjustStock(
  client: SupabaseClient,
  storeId: string,
  id: string,
  newQty: number,
  reason?: string,
) {
  const qty = Number(newQty);
  if (!Number.isFinite(qty)) return { error: "new_qty 必須是數字", status: 400 } as const;

  // 讀目前值以便計算 delta
  const { data: cur, error: curErr } = await client
    .from("inv_products")
    .select("current_qty")
    .eq("id", id)
    .eq("store_id", storeId)
    .maybeSingle();
  if (curErr) return { error: curErr.message, status: 500 } as const;
  if (!cur) return { error: "找不到庫存品", status: 404 } as const;

  const prev = Number(cur.current_qty) || 0;
  const delta = Math.round((qty - prev) * 1000) / 1000;

  const { data, error } = await client
    .from("inv_products")
    .update({ current_qty: qty })
    .eq("id", id)
    .eq("store_id", storeId)
    .select("*")
    .single();
  if (error) return { error: error.message, status: 500 } as const;

  await client.from("inv_stock_movements").insert({
    store_id: storeId,
    product_id: id,
    movement_type: "adjust",
    prev_qty: prev,
    new_qty: qty,
    delta,
    reason: reason?.trim() || null,
  });

  return { data: data as InvProduct } as const;
}

type AggregatedRow = {
  name: string;
  total_qty: number;
  weighted_cost: number; // sum(unit_price*qty)
  last_date: string | null;
  last_supplier: string | null;
  category: string | null;
};

/**
 * 從 expenseRecorder 的 receipts/receipt_items 同步庫存品。
 * - 既有品：更新 avg_unit_cost / last_purchase_date / last_supplier / category（不動 current_qty）。
 * - 新品：current_qty = 累計採購量（一次性種子），avg_unit_cost = 加權平均。
 */
export async function syncFromReceipts(
  macau: SupabaseClient,
  storeId: string,
  expense: SupabaseClient,
  userId: string,
): Promise<{ error: string; status: number } | { summary: SyncSummary }> {
  // 1) 讀 expenseRecorder 的 receipts（不限日期；依 user_id 即可涵蓋此店戶的所有收據）
  const { data: receipts, error: rErr } = await expense
    .from("receipts")
    .select("id, receipt_date, merchant_id, raw_ocr_data")
    .eq("user_id", userId);
  let allReceipts: Array<{ id: string; receipt_date: string | null; merchant_id: string | null; raw_ocr_data?: unknown }> = [];
  if (rErr) {
    if (/does not exist/i.test(rErr.message)) {
      // expenseRecorder 表尚未建（42P01），等同沒有收據可同步
      allReceipts = [];
    } else {
      return { error: rErr.message, status: 500 };
    }
  } else {
    allReceipts = (receipts ?? []) as typeof allReceipts;
  }
  if (allReceipts.length === 0) {
    return { summary: { created: 0, updated: 0, total_after: 0, scanned_receipts: 0, scanned_items: 0 } };
  }

  // 2) 讀 merchants（取名稱）
  const { data: merchants } = await expense.from("merchants").select("id, name").eq("user_id", userId);
  const merchantNameById = new Map<string, string>((merchants ?? []).map((m) => [String(m.id), String(m.name ?? "")]));

  // 3) 讀 receipt_items（這些 receipts 的）
  const ids = allReceipts.map((r) => r.id);
  const { data: items, error: iErr } = await expense
    .from("receipt_items")
    .select("receipt_id, name, unit_price, quantity")
    .in("receipt_id", ids);
  if (iErr) {
    if (/does not exist/i.test(iErr.message)) {
      return { summary: { created: 0, updated: 0, total_after: 0, scanned_receipts: ids.length, scanned_items: 0 } };
    }
    return { error: iErr.message, status: 500 };
  }

  // 4) 依 name 聚合
  const agg = new Map<string, AggregatedRow>();
  const receiptById = new Map<string, (typeof allReceipts)[number]>();
  for (const r of allReceipts) receiptById.set(r.id, r);
  for (const it of items ?? []) {
    const name = String((it as { name?: unknown }).name ?? "").trim();
    if (!name) continue;
    const qty = Number((it as { quantity?: unknown }).quantity) || 0;
    const price = Number((it as { unit_price?: unknown }).unit_price) || 0;
    const rid = String((it as { receipt_id?: unknown }).receipt_id ?? "");
    const r = receiptById.get(rid);
    const supplier = r ? merchantNameById.get(String(r.merchant_id ?? "")) ?? null : null;
    const date = r?.receipt_date ?? null;
    const cat = (() => {
      const raw = (r?.raw_ocr_data ?? null) as { category?: string } | null;
      return raw?.category?.trim() || null;
    })();

    const row = agg.get(name);
    if (row) {
      row.total_qty += qty;
      row.weighted_cost += price * qty;
      if (date && (!row.last_date || date > row.last_date)) {
        row.last_date = date;
        row.last_supplier = supplier;
      }
      if (!row.category && cat) row.category = cat;
    } else {
      agg.set(name, {
        name,
        total_qty: qty,
        weighted_cost: price * qty,
        last_date: date,
        last_supplier: supplier,
        category: cat,
      });
    }
  }

  // 5) 讀既有 inv_products（依 store_id）
  const { data: existing, error: eErr } = await macau
    .from("inv_products")
    .select("*")
    .eq("store_id", storeId);
  if (eErr) return { error: eErr.message, status: 500 };
  const existingByName = new Map<string, InvProduct>();
  for (const p of (existing ?? []) as InvProduct[]) {
    existingByName.set(p.name.trim().toLowerCase(), p);
  }

  let created = 0;
  let updated = 0;

  for (const row of agg.values()) {
    const avg = row.total_qty > 0 ? Math.round((row.weighted_cost / row.total_qty) * 100) / 100 : 0;
    const hit = existingByName.get(row.name.toLowerCase());
    if (hit) {
      const { error: uErr } = await macau
        .from("inv_products")
        .update({
          avg_unit_cost: avg,
          last_purchase_date: row.last_date ?? hit.last_purchase_date,
          last_supplier: row.last_supplier ?? hit.last_supplier,
          category: row.category ?? hit.category,
        })
        .eq("id", hit.id)
        .eq("store_id", storeId);
      if (uErr) return { error: uErr.message, status: 500 };
      updated += 1;
    } else {
      const { error: iErr2 } = await macau.from("inv_products").insert({
        store_id: storeId,
        name: row.name,
        category: row.category,
        unit: "unit",
        current_qty: row.total_qty,
        avg_unit_cost: avg,
        last_purchase_date: row.last_date,
        last_supplier: row.last_supplier,
        reorder_level: 0,
      });
      if (iErr2) {
        // 名稱衝突（unique）→ 視為已存在，改走 update
        if (/duplicate key|unique constraint/i.test(iErr2.message)) {
          const { error: uErr2 } = await macau
            .from("inv_products")
            .update({
              avg_unit_cost: avg,
              last_purchase_date: row.last_date,
              last_supplier: row.last_supplier,
              category: row.category,
            })
            .eq("store_id", storeId)
            .ilike("name", row.name);
          if (uErr2) return { error: uErr2.message, status: 500 };
          updated += 1;
        } else {
          return { error: iErr2.message, status: 500 };
        }
      } else {
        created += 1;
      }
    }
  }

  const { count } = await macau.from("inv_products").select("id", { count: "exact", head: true }).eq("store_id", storeId);
  return { summary: { created, updated, total_after: count ?? 0, scanned_receipts: ids.length, scanned_items: (items ?? []).length } };
}