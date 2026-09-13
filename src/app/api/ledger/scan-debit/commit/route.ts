import { NextResponse } from "next/server";

import { mopToAvos } from "@/lib/ledger/member-pay";
import { ScanDebitError, commitScanDebit } from "@/lib/ledger/scan-debit.server";
import { verifyPinWindowToken } from "@/lib/ledger/scan-debit-crypto";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";
import { getSupabaseServerClient, getSupabaseWriteClient } from "@/lib/supabase-server";

/**
 * `POST /api/ledger/scan-debit/commit` —— 掃碼自助扣款：**真正扣錢**。
 *
 * 對應 v3.5 交接文檔 §Commit。
 *
 * 🔴 四條唔可以錯嘅：
 *   1. **P3 免 PIN 窗口必須由 server 驗** —— Ledger **完全唔驗 PIN**（Q5），
 *      所以「登入後 3 分鐘免再 PIN」係**唯一**二次確認防線。
 *      `pinWindowToken` 由 `/api/ledger/member-login` 簽發（綁 `customerId` + 到期時間），
 *      呢度驗簽；**冇有效票就一律要客人重新入 PIN**（回 `pin_required`，client 彈 PIN 後重試）。
 *   2. **扣款成功之後一定要寫 `pos_orders`** —— 唔寫，收銀機永遠當「未付款」→ 會再收一次錢
 *      （同 docs/130 §7.1 同一個坑）。呢度由 **server** 用 write client 寫（唔經匿名通道），
 *      令「錢扣咗」同「單標記已付」盡量原子。
 *   3. **寫庫失敗唔可以當扣款失敗** —— 錢已經過咗。回 200 + `syncPending: true`，
 *      由前端顯示「已扣款，同步中」並保留 `txnId`（Ledger 冇 lookup API，唔可以當冇扣過）。
 *   4. **重試要用同一 `quoteId` / `quoteSig`** —— Ledger 會回**同一** `txnId`（唔會雙扣）。
 */

const STORE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ID_LEN = 128;

function fail(code: string, message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, code, message, ...extra }, { status });
}

export async function POST(request: Request) {
  if (!rateLimit(`scan-debit-commit:${clientIp(request)}`, 60, 15 * 60_000)) {
    return fail("rate_limited", "請求過於頻繁，請稍後再試。", 429);
  }

  let payload: {
    storeId?: unknown;
    posOrderId?: unknown;
    quoteId?: unknown;
    quoteSig?: unknown;
    customerAccessToken?: unknown;
    pinWindowToken?: unknown;
  };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return fail("bad_request", "請求格式不正確。", 400);
  }

  const storeId = typeof payload.storeId === "string" ? payload.storeId.trim() : "";
  const posOrderId = typeof payload.posOrderId === "string" ? payload.posOrderId.trim().slice(0, MAX_ID_LEN) : "";
  const quoteId = typeof payload.quoteId === "string" ? payload.quoteId.trim() : "";
  const quoteSig = typeof payload.quoteSig === "string" ? payload.quoteSig.trim() : "";
  const customerAccessToken =
    typeof payload.customerAccessToken === "string" ? payload.customerAccessToken.trim() : "";
  const pinWindowToken = typeof payload.pinWindowToken === "string" ? payload.pinWindowToken.trim() : "";

  if (!STORE_ID_PATTERN.test(storeId)) return fail("bad_request", "缺少店鋪識別碼。", 400);
  if (!posOrderId) return fail("bad_request", "缺少訂單編號。", 400);
  if (!quoteId || !quoteSig) return fail("bad_request", "缺少報價憑證，請重新付款。", 400);
  if (!customerAccessToken) return fail("unauthorized", "請先登入會員再付款。", 401);

  // ── P3：免 PIN 票驗證（server 側）──
  const pepper = process.env.AUTH_PIN_PEPPER?.trim() ?? "";
  if (!pepper) return fail("not_configured", "系統尚未完成設定，請店員協助。", 503);

  // ⚠️ 先解 token 內嘅 customerId **僅為傳入比對用**；真正可信係「驗簽通過」之後。
  //    驗簽綁住 `customerId + expiresAtMs`，所以改任何一項都會 `bad-signature`。
  const tokenCustomerId = pinWindowToken.split(".")[0] ?? "";
  const pinCheck = verifyPinWindowToken(pinWindowToken, tokenCustomerId, pepper, Date.now());
  if (!pinCheck.valid) {
    // 客人需要重新入 PIN（client 收到呢個 code 就彈 PIN，再用新票重試 commit）。
    return fail("pin_required", "請重新輸入 PIN 確認扣款。", 428, { reason: pinCheck.reason });
  }

  const supabaseRead = getSupabaseServerClient();
  const supabaseWrite = getSupabaseWriteClient();
  if (!supabaseRead || !supabaseWrite) return fail("not_configured", "資料庫尚未設定。", 503);

  // 讀返訂單：① 確認仍然未扣款（防雙扣）② 攞 total 寫 `prepaid_amount`
  const { data: row, error: readError } = await supabaseRead
    .from("pos_orders")
    .select("id, store_id, total, member_deduct_txn_id")
    .eq("id", posOrderId)
    .maybeSingle();

  if (readError) {
    console.error("[scan-debit/commit] 讀訂單失敗:", readError.message);
    return fail("not_configured", "系統尚未完成設定，請店員協助。", 503);
  }
  if (!row) return fail("order_not_found", "找不到訂單，請重新掃碼。", 404);
  if (String(row.store_id ?? "") !== storeId) return fail("store_mismatch", "訂單不屬於本店。", 403);
  if (row.member_deduct_txn_id) {
    // Idempotent 回應：已經扣過就回同一個 txnId（客人可能只係重試）。
    return NextResponse.json({
      ok: true,
      alreadyCommitted: true,
      txnId: String(row.member_deduct_txn_id),
      balanceAfterAvos: null,
      pointsEarnedAvos: 0,
      syncPending: false,
    });
  }

  try {
    const result = await commitScanDebit({ quoteId, quoteSig, customerAccessToken });
    const nowIso = new Date().toISOString();
    const total = Number(row.total ?? 0);

    // ── 寫庫（server 權威）：扣款成功 → 單即「已付」──
    // 寫 `member_deduct_txn_id` 係關鍵：收銀機見到就知唔可以再收錢。
    const { error: writeError } = await supabaseWrite
      .from("pos_orders")
      .update({
        status: "paid",
        prepaid_amount: total,
        member_customer_id: tokenCustomerId || null,
        member_deduction_avos: mopToAvos(total),
        member_deduct_txn_id: result.txnId,
        updated_at: nowIso,
        client_updated_at: nowIso,
      })
      .eq("id", posOrderId)
      .eq("store_id", storeId);

    // 🔴 寫庫失敗**唔可以**當扣款失敗 —— 錢已經扣咗（Ledger 冇 lookup API，唔可以當冇扣過）。
    if (writeError) {
      console.error("[scan-debit/commit] 扣款成功但寫庫失敗:", writeError.message);
      return NextResponse.json({
        ok: true,
        txnId: result.txnId,
        balanceAfterAvos: result.balanceAfterAvos,
        pointsEarnedAvos: result.pointsEarnedAvos,
        amountAvos: mopToAvos(total),
        syncPending: true,
      });
    }

    return NextResponse.json({
      ok: true,
      txnId: result.txnId,
      balanceAfterAvos: result.balanceAfterAvos,
      pointsEarnedAvos: result.pointsEarnedAvos,
      amountAvos: mopToAvos(total),
      syncPending: false,
    });
  } catch (err) {
    if (err instanceof ScanDebitError) {
      return fail(err.code, err.message, err.httpStatus);
    }
    console.error("[scan-debit/commit] 非預期錯誤:", err);
    return fail("upstream", "系統暫時無法處理，請稍後再試。", 500);
  }
}
