import { NextResponse } from "next/server";

import { mopToAvos } from "@/lib/ledger/member-pay";
import { ScanDebitError, quoteScanDebit } from "@/lib/ledger/scan-debit.server";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";
import { getSupabaseServerClient } from "@/lib/supabase-server";

/**
 * `POST /api/ledger/scan-debit/quote` —— 掃碼自助扣款：**報價**（唔扣錢）。
 *
 * 對應 v3.5 交接文檔 §Quote。流程：客人落單（待付）→ 本 route 核價 + 向 Ledger 攞 quote
 * （~180s 有效）→ 客人確認（PIN / 免 PIN 票）→ `/commit` 真正扣款。
 *
 * 🔴 **P2 伺服器端核價（最重要嘅一點）**：
 *    Ledger **完全唔核價**（Q3 上限「無」，`amountAvos` 由 POS 傳）。
 *    所以呢個 route **一定**要由自己 DB（`pos_orders`）讀返訂單總額，
 *    **唔可以**信 client 傳上嚟嘅金額 —— 否則客人改個 request body 就可以 MOP 1 買 MOP 999。
 *
 * 🔴 三重守門（防「幫人扣錢」／重複扣款）：
 *    ① 訂單存在　② 訂單 `store_id` 同請求 `storeId` 一致　③ 訂單未有任何扣款紀錄。
 *
 * ⚠️ quote **未 commit 唔佔冪等鍵**（Q4）→ 客人可以放心重 quote（例如改單之後）。
 */

const STORE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ID_LEN = 128;

function fail(code: string, message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, code, message, ...extra }, { status });
}

export async function POST(request: Request) {
  // Ledger 本身限「每店／每顧客 15 分鐘 30 次 quote」；呢個係我哋自己嘅第一道閘。
  if (!rateLimit(`scan-debit-quote:${clientIp(request)}`, 60, 15 * 60_000)) {
    return fail("rate_limited", "請求過於頻繁，請稍後再試。", 429);
  }

  let payload: {
    storeId?: unknown;
    posOrderId?: unknown;
    customerAccessToken?: unknown;
  };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return fail("bad_request", "請求格式不正確。", 400);
  }

  const storeId = typeof payload.storeId === "string" ? payload.storeId.trim() : "";
  const posOrderId = typeof payload.posOrderId === "string" ? payload.posOrderId.trim().slice(0, MAX_ID_LEN) : "";
  const customerAccessToken =
    typeof payload.customerAccessToken === "string" ? payload.customerAccessToken.trim() : "";

  if (!STORE_ID_PATTERN.test(storeId)) return fail("bad_request", "缺少店鋪識別碼。", 400);
  if (!posOrderId) return fail("bad_request", "缺少訂單編號。", 400);
  if (!customerAccessToken) return fail("unauthorized", "請先登入會員再付款。", 401);

  // ── P2：伺服器端核價（由自己 DB 讀，唔信 client）──
  const supabase = getSupabaseServerClient();
  if (!supabase) return fail("not_configured", "資料庫尚未設定。", 503);

  const { data: row, error } = await supabase
    .from("pos_orders")
    .select("id, store_id, total, status, member_deduct_txn_id, member_deduction_avos")
    .eq("id", posOrderId)
    .maybeSingle();

  if (error) {
    // 🔻 0038 未跑 → `member_deduct_txn_id` 唔存在（42703）。
    //    呢個唔可以靜默當「未扣過」—— 咁樣會變成可以重複扣款。
    console.error("[scan-debit/quote] 讀訂單失敗:", error.message);
    return fail("not_configured", "系統尚未完成設定，請店員協助。", 503);
  }
  if (!row) return fail("order_not_found", "找不到訂單，請重新掃碼。", 404);
  if (String(row.store_id ?? "") !== storeId) {
    return fail("store_mismatch", "訂單不屬於本店。", 403);
  }
  if (row.member_deduct_txn_id) {
    // 已經扣過款（有 txn_id）→ 唔可以再 quote，否則客人會以為要再畀一次。
    return fail("already_debited", "此訂單已經完成會員扣款。", 409, {
      txnId: String(row.member_deduct_txn_id),
    });
  }

  const amountAvos = mopToAvos(Number(row.total ?? 0));
  if (amountAvos <= 0) return fail("bad_amount", "訂單金額不正確。", 400);

  try {
    const quote = await quoteScanDebit({
      merchantId: storeId,
      posOrderId,
      amountAvos,
      customerAccessToken,
    });

    return NextResponse.json({
      ok: true,
      // ⚠️ 回傳 `amountAvos` 係**我哋自己算嘅**（上面），令前端可以顯示「扣幾多」而唔使再信自己個購物車。
      amountAvos,
      quoteId: quote.quoteId,
      quoteSig: quote.quoteSig,
      expiresAt: quote.expiresAt,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** 將 `ScanDebitError` 映射成 HTTP 回應（quote / commit 共用邏輯，喺各自 route 重覆一次係刻意 —— 保持 route 自足）。 */
function toErrorResponse(err: unknown) {
  if (err instanceof ScanDebitError) {
    return fail(err.code, err.message, err.httpStatus);
  }
  console.error("[scan-debit/quote] 非預期錯誤:", err);
  return fail("upstream", "系統暫時無法處理，請稍後再試。", 500);
}
