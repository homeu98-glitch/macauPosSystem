import { NextResponse } from "next/server";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";
import { normalizePaymentMethod, normalizePaymentStatus } from "@/lib/inventory-stats";
import {
  buildReceiptItems,
  resolveExpenseUserId,
  resolveMerchantId,
  sanitizePhotoPaths,
  stripQuantityUnit,
  type InventoryReceiptInput,
} from "@/lib/expense-inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 🔴 2026-10-06：`receipt_items.quantity_unit` 係 expenseRecorder 側新加嘅欄位。
 * 舊環境未有 ⇒ insert 會回 `42703`。降級：剝走該欄重試（單位唔寫入但照存收據）。
 * 同 `expense-inventory.ts isMissingColumnOrTable()` 語意一致（此處只針對欄）。
 */
function isMissingColumn(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "42703") return true;
  return /column .* does not exist|Could not find the '.*' column|schema cache/i.test(err.message ?? "");
}

/**
 * 更新收據（mirror save-receipt 的 update 路徑）：表頭欄位 + 合併 raw_ocr_data；
 * 若帶 items 則先刪後插（整批取代），實現品項的新增/修改/刪除。
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  const body = (await request.json()) as InventoryReceiptInput;
  const resolved = await resolveExpenseUserId(client, body.account ?? null);
  if ("error" in resolved) return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  const userId = resolved.userId;

  let merchantId: string | null = typeof body.merchant_id === "string" && body.merchant_id ? body.merchant_id : null;
  if (!merchantId && body.merchant_name) {
    const m = await resolveMerchantId(client, userId, { merchant_name: body.merchant_name });
    if ("error" in m) return NextResponse.json({ ok: false, error: m.error }, { status: m.status });
    merchantId = m.merchantId;
  }

  const update: Record<string, unknown> = {};
  if (body.total_amount !== undefined) update.total_amount = Number(body.total_amount) || 0;
  if (body.date) update.receipt_date = body.date;
  if (merchantId) update.merchant_id = merchantId;

  const raw: Record<string, unknown> = {};
  if (body.receipt_number !== undefined) raw.receipt_number = body.receipt_number || null;
  if (body.category !== undefined) raw.category = body.category || null;
  if (body.payment_method) raw.payment_method = normalizePaymentMethod(body.payment_method);
  if (body.payment_status) raw.payment_status = normalizePaymentStatus(body.payment_status);
  /*
   * 🔴 2026-10-07（P3）：相片路徑。
   *
   * 一定要用 `!== undefined` 判斷，**唔可以**寫 `if (body.photo_paths)`：
   *   - 空陣列 `[]` 係 falsy ⇒ `if` 會令「商家主動刪光相片」靜默失效，
   *     刪完儲存再開返，相片原封不動 —— 商家會以為系統壞咗。
   *
   * 三態語意（同上面 merge 邏輯配套）：
   *   | 前端送              | 結果          | 判斷 |
   *   |---------------------|---------------|------|
   *   | 唔送（undefined）    | 保留原有      | ✅ 只改金額／品項，唔想動相片 |
   *   | `photo_paths: []`   | 覆蓋成空      | ✅ 主動刪光 |
   *   | 新陣列               | 覆蓋          | ✅ 加了新相片 |
   */
  if (body.photo_paths !== undefined) raw.photo_paths = sanitizePhotoPaths(body.photo_paths);
  if (Object.keys(raw).length > 0) {
    const { data: cur } = await client.from("receipts").select("raw_ocr_data").eq("id", id).eq("user_id", userId).maybeSingle();
    update.raw_ocr_data = { ...(cur?.raw_ocr_data ?? {}), ...raw };
  }

  const { error: uErr } = await client.from("receipts").update(update).eq("id", id).eq("user_id", userId);
  if (uErr) return NextResponse.json({ ok: false, error: uErr.message }, { status: 500 });

  if (Array.isArray(body.items)) {
    const { error: dErr } = await client.from("receipt_items").delete().eq("receipt_id", id);
    if (dErr) return NextResponse.json({ ok: false, error: dErr.message }, { status: 500 });
    const itemRows = buildReceiptItems(id, userId, body.items);
    if (itemRows.length > 0) {
      let { error: iErr } = await client.from("receipt_items").insert(itemRows);
      if (iErr && isMissingColumn(iErr)) {
        ({ error: iErr } = await client.from("receipt_items").insert(stripQuantityUnit(itemRows)));
      }
      if (iErr) return NextResponse.json({ ok: false, error: iErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  const account = new URL(request.url).searchParams.get("account");
  const resolved = await resolveExpenseUserId(client, account);
  if ("error" in resolved) return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  const userId = resolved.userId;

  /*
   * 🔴 2026-10-07（P3）：刪收據要**一併刪相片**，否則 Storage 累積孤兒檔案
   *    （J 拍板「刪除一起刪」）。免費額度 1GB、300KB/張、每日 20 張 ⇒ 約 5–6 個月就滿。
   *
   * ⚠️ 次序刻意係「先讀路徑 → 刪 DB → 最後刪 Storage」：
   *    ① 刪 DB 之前一定要讀到路徑，刪完 row 就攞唔返；
   *    ② 刪 Storage 放最後 ⇒ Storage 出錯（網絡／bucket 未建）**唔會**令
   *       「刪收據」失敗。最壞情況只係留低孤兒檔案（可事後清理），
   *       而唔係商家撳極都刪唔到單。
   */
  const { data: before } = await client
    .from("receipts")
    .select("raw_ocr_data")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  const photoPaths = sanitizePhotoPaths((before?.raw_ocr_data as Record<string, unknown> | null)?.photo_paths);

  const { error: dItemsErr } = await client.from("receipt_items").delete().eq("receipt_id", id);
  if (dItemsErr) return NextResponse.json({ ok: false, error: dItemsErr.message }, { status: 500 });

  const { error } = await client.from("receipts").delete().eq("id", id).eq("user_id", userId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // 收據已成功刪除 ⇒ 之後任何失敗都唔可以回 error（否則商家見到「刪除失敗」但其實已經刪咗）。
  if (photoPaths.length > 0) {
    // 只刪本店前綴底下嘅路徑（defense in depth，同 receipt-photos 端點一致）。
    const owned = photoPaths.filter((p) => p.startsWith(`${userId}/`));
    if (owned.length > 0) {
      const { error: rmErr } = await client.storage.from("receipt-photos").remove(owned);
      if (rmErr) console.warn("[receipts] 刪相失敗（收據已刪）", { count: owned.length, message: rmErr.message });
    }
  }

  return NextResponse.json({ ok: true, photosDeleted: photoPaths.length });
}
