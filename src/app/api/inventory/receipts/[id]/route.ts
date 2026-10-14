import { NextResponse } from "next/server";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";
import { normalizePaymentMethod, normalizePaymentStatus } from "@/lib/inventory-stats";
import {
  buildReceiptItems,
  normalizeReceiptCurrency,
  resolveExpenseUserId,
  resolveMerchantId,
  sanitizePhotoPaths,
  stripQuantityUnit,
  type InventoryReceiptInput,
} from "@/lib/expense-inventory";
import { diffReceiptItems, type ExistingReceiptItem, type ReceiptItemContent } from "@/lib/inventory-receipt-diff";

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
  // 2026-10-11：幣值（每張收據一個）。`undefined` ＝ 唔改（保留原有）；空字串＝清走。
  /*
   * 🔴 2026-10-14：`raw_ocr_data.currency` 同頂層 `receipts.currency` 要**同步**。
   *
   * Ledger 買貨報表 RPC 讀嘅係頂層欄（唔係 raw），舊版只改 raw ⇒
   * 商家喺 UI 改幣值，報表完全唔跟。三態必須一致：
   *   有值     → 兩邊都寫（同一個值）
   *   空字串   → raw 清走（null，＝ UI「未設定」）；頂層欄**落 'MOP' 降級**
   *   undefined → 兩邊都唔動
   *
   * ⚠️ 點解清走時頂層欄唔跟住落 null：一落 null／空，任何人之後 insert/update
   *    都會再跌返 schema `DEFAULT 'HKD'`（即返返去原本嘅病）；而且頂層欄若
   *    有 NOT NULL 約束，寫 null 會直接 500「儲存失敗」。
   *    頂層欄嘅不變式＝**恆有值，且等於 UI 顯示嘅幣別**。
   */
  if (body.currency !== undefined) {
    const next = normalizeReceiptCurrency(body.currency);
    raw.currency = body.currency && body.currency.trim() ? next : null;
    update.currency = next;
  }
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
    /*
     * 🔴 2026-10-11：由「先刪再插」改為 content-diff（insert → update → delete）。
     *
     * 舊做法：先 `delete().eq("receipt_id", id)` 再 `insert(itemRows)`。
     *   若 insert 失敗（例如 receipt_items.quantity_unit 欄未加 ⇒ 42703），
     *   原本嘅品項已經被 delete 清走 ⇒ 商家見到「原有品項無故消失」。
     *   呢個就係用家回報「新增品項時原有品項被莫名刪除」嘅根因。
     *
     * 新做法：先拉現有品項（帶 id），同前端送嚟嘅 desired 做 content-diff，
     *   順序**先 insert 新行 → 再 update 改動行 → 最後先 delete 多咗出嚟嘅行**。
     *   任何一步失敗都唔會丟掉已經存在嘅品項（delete 排最後，而且只刪尾段多餘行）。
     *
     *   ⚠️ 順序係鐵律：一定要 insert→update→delete，唔可以 delete 排頭。
     */
    const desiredRows = buildReceiptItems(id, userId, body.items);
    const desired: ReceiptItemContent[] = desiredRows.map((r) => ({
      name: r.name,
      unit_price: r.unit_price,
      quantity: r.quantity,
      quantity_unit: typeof r.quantity_unit === "string" ? r.quantity_unit : "",
    }));

    const { data: existingRows, error: exErr } = await client
      .from("receipt_items")
      .select("id, name, unit_price, quantity, quantity_unit")
      .eq("receipt_id", id)
      .order("id", { ascending: true });
    if (exErr) return NextResponse.json({ ok: false, error: exErr.message }, { status: 500 });

    const existing: ExistingReceiptItem[] = (existingRows ?? []).map((r) => ({
      id: String((r as Record<string, unknown>).id),
      name: String((r as Record<string, unknown>).name ?? ""),
      unit_price: Number((r as Record<string, unknown>).unit_price) || 0,
      quantity: Number((r as Record<string, unknown>).quantity) || 0,
      quantity_unit: typeof (r as Record<string, unknown>).quantity_unit === "string" ? ((r as Record<string, unknown>).quantity_unit as string) : "",
    }));

    const diff = diffReceiptItems(existing, desired);

    // ① insert（新行）
    for (const row of diff.toInsert) {
      const insertRow = { receipt_id: id, user_id: userId, ...row };
      let { error: iErr } = await client.from("receipt_items").insert(insertRow);
      if (iErr && isMissingColumn(iErr)) {
        ({ error: iErr } = await client.from("receipt_items").insert(stripQuantityUnit([insertRow])));
      }
      if (iErr) return NextResponse.json({ ok: false, error: iErr.message }, { status: 500 });
    }

    // ② update（改動行）
    for (const row of diff.toUpdate) {
      const { id: itemId, ...patch } = row;
      let { error: uErr } = await client.from("receipt_items").update(patch as Record<string, unknown>).eq("id", itemId);
      if (uErr && isMissingColumn(uErr)) {
        ({ error: uErr } = await client
          .from("receipt_items")
          .update(stripQuantityUnit([patch])[0] as Record<string, unknown>)
          .eq("id", itemId));
      }
      if (uErr) return NextResponse.json({ ok: false, error: uErr.message }, { status: 500 });
    }

    // ③ delete（多咗出嚟嘅行，排最後 → 失敗唔會動到仲要用嘅品項）
    if (diff.toDelete.length > 0) {
      const { error: dErr } = await client.from("receipt_items").delete().in("id", diff.toDelete);
      if (dErr) return NextResponse.json({ ok: false, error: dErr.message }, { status: 500 });
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
