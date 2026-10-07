import { NextResponse } from "next/server";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";
import {
  buildReceiptItems,
  resolveExpenseUserId,
  resolveMerchantId,
  stripQuantityUnit,
  type InventoryReceiptInput,
} from "@/lib/expense-inventory";
import {
  buildPurchaseSummary,
  normalizePaymentMethod,
  normalizePaymentStatus,
  receiptDateMatchesRange,
  type StatReceipt,
} from "@/lib/inventory-stats";
import type { ReportRangeArg, ReportRangeKey } from "@/lib/ledger/report-period";
import { normalizeCustomRange } from "@/lib/ledger/date-range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DbError = { code?: string; message?: string } | null;
function isMissingTable(err: DbError): boolean {
  if (!err) return false;
  if (err.code === "42P01") return true;
  return /relation .* does not exist/i.test(err.message ?? "");
}
/**
 * 🔴 2026-10-06：`receipt_items.quantity_unit` 係新增欄位（expenseRecorder 側人手 ALTER），
 * 舊環境未有 ⇒ select 該欄會回 `42703 undefined_column`，整條報表會 500。
 * 故此要**優雅降級**：偵測到缺欄就改回唔選 `quantity_unit` 嘅 select（單位一律留空），
 * 令買貨統計照出，唔好因為一個可選欄位而令成個模組掛掉。
 * ⚠️ 呢個係 `isMissingColumnOrTable()`（`expense-inventory.ts`）嘅「只針對欄」版本 ——
 *    表缺失要當 `schemaReady:false` 處理，欄缺失只係降級，兩者語意唔同，故分開。
 */
function isMissingColumn(err: DbError): boolean {
  if (!err) return false;
  if (err.code === "42703") return true;
  if (/column .* does not exist/i.test(err.message ?? "")) return true;
  // PostgREST schema cache 未刷新時會回「Could not find the 'x' column」
  return /Could not find the '.*' column|schema cache/i.test(err.message ?? "");
}

const VALID_RANGES: ReportRangeKey[] = ["today", "yesterday", "7d", "30d", "all", "custom"];

/**
 * 唯讀：依 8 位帳號顯示 expenseRecorder 的收據，並回傳買貨統計。
 * 關聯：account → shop_users.login_id → shop_users.id
 *       收據經 user_id = shop_users.id 或 merchant_id ∈ (merchants WHERE user_id = shop_users.id)
 * 不寫入、不加表，直接沿用 expenseRecorder 原始 receipts / receipt_items 結構。
 * 支援 range（today/yesterday/7d/30d/all/custom，澳門時區依 receipt_date 過濾）。
 *
 * `range=custom` 時必須同時帶 `start` / `end`（`YYYY-MM-DD`）；缺失或顛倒 → 降級 `all`。
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get("account");
  if (!account) return NextResponse.json({ ok: false, error: "缺少 account" }, { status: 400 });

  const rawRange = searchParams.get("range") as ReportRangeKey | null;
  let range: ReportRangeKey = rawRange && VALID_RANGES.includes(rawRange) ? rawRange : "all";

  // 自訂區間（server 端無法 derive，必須由 client 傳）
  const custom = normalizeCustomRange({
    start: searchParams.get("start") ?? "",
    end: searchParams.get("end") ?? "",
  });
  if (range === "custom" && !custom) range = "all";
  const rangeArg: ReportRangeArg = range === "custom" && custom ? { key: "custom", custom } : range;

  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  // 1) 找 shop_users.id by login_id = account（8 位）
  const { data: shopUser, error: suErr } = await client
    .from("shop_users")
    .select("id")
    .eq("login_id", account)
    .maybeSingle();
  if (suErr) {
    if (isMissingTable(suErr))
      return NextResponse.json({ ok: true, schemaReady: false, matched: false, receipts: [], summary: buildPurchaseSummary([]) });
    return NextResponse.json({ ok: false, error: suErr.message }, { status: 500 });
  }
  if (!shopUser) {
    return NextResponse.json({
      ok: true,
      matched: false,
      receipts: [],
      summary: buildPurchaseSummary([]),
      message: "expenseRecorder 找不到相同帳號的店戶",
    });
  }

  // 2) 該店戶的 merchants（取 id + name 做供貨商名稱對照）
  const { data: merchants, error: mErr } = await client
    .from("merchants")
    .select("id, name")
    .eq("user_id", shopUser.id);
  if (mErr) {
    if (isMissingTable(mErr))
      return NextResponse.json({ ok: true, schemaReady: false, matched: true, receipts: [], summary: buildPurchaseSummary([]) });
    return NextResponse.json({ ok: false, error: mErr.message }, { status: 500 });
  }
  const merchantIds = (merchants ?? []).map((m) => m.id);
  const merchantNameById = new Map<string, string>(
    (merchants ?? []).map((m) => [m.id, typeof m.name === "string" && m.name.trim() ? m.name.trim() : "未知供應商"]),
  );

  // 3) receipts（user_id 或 merchant_id）
  const orParts = [`user_id.eq.${shopUser.id}`];
  if (merchantIds.length > 0) orParts.push(`merchant_id.in.(${merchantIds.join(",")})`);
  const { data: receipts, error: rErr } = await client
    .from("receipts")
    .select("id, total_amount, receipt_date, merchant_id, raw_ocr_data, created_at")
    .or(orParts.join(","))
    .order("receipt_date", { ascending: false });
  if (rErr) {
    if (isMissingTable(rErr))
      return NextResponse.json({ ok: true, schemaReady: false, matched: true, receipts: [], summary: buildPurchaseSummary([]) });
    return NextResponse.json({ ok: false, error: rErr.message }, { status: 500 });
  }

  const ids = (receipts ?? []).map((r) => r.id);
  let items: Array<Record<string, unknown>> = [];
  if (ids.length > 0) {
    /*
     * 🔴 2026-10-06：先試帶 `quantity_unit`（新欄位）；若該欄未存在（舊 expenseRecorder
     * 環境）就降級為唔選該欄 —— 單位留空，貨品細項照出。唔可以因為一個可選欄位令
     * 成個買貨統計 500。
     */
    let iErr: DbError = null;
    const withUnit = await client
      .from("receipt_items")
      .select("id, receipt_id, name, unit_price, quantity, quantity_unit")
      .in("receipt_id", ids);
    if (withUnit.error && isMissingColumn(withUnit.error)) {
      const legacy = await client
        .from("receipt_items")
        .select("id, receipt_id, name, unit_price, quantity")
        .in("receipt_id", ids);
      iErr = legacy.error;
      items = legacy.data ?? [];
    } else {
      iErr = withUnit.error;
      items = withUnit.data ?? [];
    }
    if (iErr) {
      if (isMissingTable(iErr))
        return NextResponse.json({ ok: true, schemaReady: false, matched: true, receipts: [], summary: buildPurchaseSummary([]) });
      return NextResponse.json({ ok: false, error: iErr.message }, { status: 500 });
    }
  }

  const itemsByReceipt = new Map<string, Array<Record<string, unknown>>>();
  for (const it of items) {
    const rid = String((it as Record<string, unknown>).receipt_id);
    const arr = itemsByReceipt.get(rid) ?? [];
    arr.push(it);
    itemsByReceipt.set(rid, arr);
  }

  const toStatReceipt = (r: Record<string, unknown>): StatReceipt => {
    const raw = (r.raw_ocr_data ?? null) as Record<string, unknown> | null;
    const getRaw = (key: string): string => {
      const v = raw?.[key];
      return typeof v === "string" && v.trim() ? v.trim() : "";
    };
    const receiptItems = (itemsByReceipt.get(String(r.id)) ?? []).map((it) => {
      const item = it as Record<string, unknown>;
      return {
        name: typeof item.name === "string" ? item.name : "未命名品項",
        unit_price: Number(item.unit_price) || 0,
        quantity: Number(item.quantity) || 1,
        // 2026-10-05：貨品細項要顯示單位（kg／包／罐）。expenseRecorder 嘅
        // `receipt_items` 有 `quantity_unit` 就用；冇（舊資料／欄位未加）留空，
        // UI 只出數量唔出單位，**唔可以**亂填「個」之類嘅假單位。
        quantity_unit: typeof item.quantity_unit === "string" ? item.quantity_unit : "",
      };
    });
    return {
      id: String(r.id),
      merchant_name: merchantNameById.get(String(r.merchant_id ?? "")) ?? "未知供應商",
      receipt_date: typeof r.receipt_date === "string" ? r.receipt_date : "",
      total_amount: Number(r.total_amount) || 0,
      // 🔴 2026-09-25：expenseRecorder 舊資料有機會直接存中文（「月結」／「已付款」），
      // 統一正規化做 canonical key，否則付款方式篩選同 paid/unpaid 計算會靜默計錯。
      payment_status: normalizePaymentStatus(getRaw("payment_status")),
      payment_method: normalizePaymentMethod(getRaw("payment_method")),
      category: getRaw("category") || "",
      items: receiptItems,
    };
  };

  // 4) 依 range 過濾（澳門時區，in-memory）
  const statReceipts: StatReceipt[] = (receipts ?? [])
    .filter((r) => receiptDateMatchesRange(String(r.receipt_date ?? ""), rangeArg))
    .map(toStatReceipt);

  const enriched = statReceipts.map((sr) => {
    const src = (receipts ?? []).find((r) => r.id === sr.id);
    return {
      id: sr.id,
      total_amount: sr.total_amount,
      receipt_date: sr.receipt_date,
      merchant_id: src?.merchant_id ?? null,
      merchant_name: sr.merchant_name,
      payment_method: sr.payment_method,
      payment_status: sr.payment_status,
      category: sr.category ?? "",
      raw_ocr_data: src?.raw_ocr_data ?? null,
      items: sr.items,
      /*
       * 🔴 2026-10-07：`created_at` 一直有喺上面 SQL select（L116），但之前喺呢度
       * 組 enriched 時被漏掉 ⇒ 前端攞唔到。品項分析「收據時間到秒」需要佢。
       *
       * ⚠️ 語意提醒：`receipt_date` 係 date 型別（只有年月日），時分秒只能黎自
       *    `created_at` ＝ **錄入時間**，唔係單據本身嘅時間。兩者可以差幾日
       *    （例如補登舊單）。UI 必須標明，唔可以令商家以為係單據時間。
       *    舊資料／未填時回 null，前端要 fallback 只出日期。
       */
      created_at: typeof src?.created_at === "string" ? src.created_at : null,
    };
  });

  const summary = buildPurchaseSummary(statReceipts);

  return NextResponse.json({ ok: true, matched: true, range, receipts: enriched, summary });
}

/**
 * 新增收據（mirror expenseRecorder save-receipt）：解析 user_id → upsert 供應商 → 插 receipts → 批量插 receipt_items。
 * 寫入 expenseRecorder 現有 receipts / receipt_items / merchants，不新增 table。
 */
export async function POST(request: Request) {
  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  let body: InventoryReceiptInput;
  try {
    body = (await request.json()) as InventoryReceiptInput;
  } catch {
    return NextResponse.json({ ok: false, error: "無效的 JSON 內容" }, { status: 400 });
  }

  const resolved = await resolveExpenseUserId(client, body.account ?? null);
  if ("error" in resolved) return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  const userId = resolved.userId;

  if (!body.date) return NextResponse.json({ ok: false, error: "缺少 date" }, { status: 400 });
  /*
   * 🔴 2026-10-07 J 拍板：品類必填（前端 UI 已擋，呢度係 server 側第二道閘）。
   *
   * 點解要有 server 側驗證：前端驗證只保護「經 POS UI 入嘅單」，
   * 但呢支 API 係公開端點（見 `docs/` 鑑權審計），直接 POST 可以繞過 UI。
   * 而品類係品項分析／品類報表嘅分組鍵 —— 一旦有單冇品類入庫，
   * 報表就會多一個「未分類」黑洞，之後好難追。
   *
   * ⚠️ 只加喺 POST（新增）。PATCH（編輯）**唔可以**擋：舊收據本來就冇品類，
   *    若 PATCH 都硬性要求，商家連「改個金額」都做唔到 —— 變成資料鎖死。
   *    舊單嘅品類補填由前端引導（UI 顯示 * 標記 + save() 提示），
   *    呢個係漸進收斂，唔係一下子斷龍。
   */
  if (!body.category || !String(body.category).trim()) {
    return NextResponse.json({ ok: false, error: "請選擇品類（必填）" }, { status: 400 });
  }

  const merchant = await resolveMerchantId(client, userId, {
    merchant_id: body.merchant_id,
    merchant_name: body.merchant_name,
  });
  if ("error" in merchant) return NextResponse.json({ ok: false, error: merchant.error }, { status: merchant.status });

  const receiptPayload = {
    user_id: userId,
    merchant_id: merchant.merchantId,
    total_amount: Number(body.total_amount) || 0,
    receipt_date: body.date,
    raw_ocr_data: {
      receipt_number: body.receipt_number || null,
      // 2026-10-07：品類已係必填（上面驗證），所以呢度一定會有值。
      category: String(body.category).trim(),
      payment_method: normalizePaymentMethod(body.payment_method),
      payment_status: normalizePaymentStatus(body.payment_status),
      input_method: "pos_manual",
    },
  };

  const { data: receipt, error: rErr } = await client
    .from("receipts")
    .insert(receiptPayload)
    .select("id")
    .single();
  if (rErr) return NextResponse.json({ ok: false, error: rErr.message }, { status: 500 });

  const itemRows = buildReceiptItems(receipt.id, userId, body.items);
  if (itemRows.length > 0) {
    /*
     * 🔴 2026-10-06：`quantity_unit` 係 expenseRecorder 側新加嘅欄位（人手 ALTER）。
     * 舊環境未有 ⇒ insert 會回 `42703`。降級：剝走該欄重試一次（單位唔寫入但照存收據），
     * 唔可以因為一個可選欄位令整張收據插入失敗（收據本身係主體，單位係 bonus）。
     */
    let { error: iErr } = await client.from("receipt_items").insert(itemRows);
    if (iErr && isMissingColumn(iErr)) {
      const legacyRows = stripQuantityUnit(itemRows);
      ({ error: iErr } = await client.from("receipt_items").insert(legacyRows));
    }
    if (iErr) return NextResponse.json({ ok: false, error: iErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: receipt.id });
}
