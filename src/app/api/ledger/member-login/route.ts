import { NextResponse } from "next/server";

import { memberLoginLimiter } from "@/lib/ledger/member-login-limit";
import { CustomerLoginError, loginCustomer } from "@/lib/ledger/member-login.server";
import { isValidMacauPhone, normalizePhone } from "@/lib/ledger/phone";
import { clientIp } from "@/lib/pos/rate-limit";

/**
 * 顧客會員登入（Ledger 契約 §4.5）—— **POS 側新開嘅 route**。
 *
 * 🔴 呢個 route 同 `/api/ledger/login`（店員）係兩套：
 *    - 店員 route 登入後查 `merchant_staff`、簽 `posDeviceToken`、讀 `allowedModules`；
 *      一般會員冇 staff 列 → 用嗰條路一定會被 403 擋死。
 *    - 契約 §4.5.2 步驟 2 明文：「若現有店員 `/api/ledger/login` 硬查 `merchant_staff`，
 *      **另開**顧客 route，**勿改壞店員登入**」。所以呢個檔唔可以順手改去共用。
 *
 * 🔴 回應**唔可以**含任何 token（access / refresh）。線 A（Kiosk 店員代扣）用唔到
 *    顧客 JWT，而 Kiosk 係共用平板 —— 將顧客憑證放落共用裝置係純風險、零收益。
 *    契約 §4.5.2 步驟 4 講嘅「回 access_token」係為咗「顧客自助讀 §5.11」，
 *    我哋改為喺 server 側一次過讀完（步驟 6「按需讀 §5.11」）。
 *
 * 🔴 個資紅線（契約 §7.2）：`displayName` / 餘額只准「當次 UI 渲染」，
 *    前端**禁**寫入 `localStorage` / POS Supabase / analytics / console。
 */

const STORE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

type Body = {
  phone?: unknown;
  account?: unknown;
  pin?: unknown;
  storeId?: unknown;
};

function fail(
  code: string,
  message: string,
  status: number,
  extra?: { remainingAttempts?: number; retryAfterSec?: number },
) {
  return NextResponse.json({ ok: false, code, message, ...extra }, { status });
}

export async function POST(request: Request) {
  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return fail("bad_request", "請求格式不正確。", 400);
  }

  const storeId = typeof payload.storeId === "string" ? payload.storeId.trim() : "";
  if (!STORE_ID_PATTERN.test(storeId)) {
    return fail("bad_request", "缺少店鋪識別碼，請重新掃碼或重新綁定。", 400);
  }

  // 確認稿寫「帳號」、契約寫「電話」—— 兩者其實同一樣嘢（normalize 後 8 位）。
  // 兩個欄名都收，避免新舊前端版本唔對接。
  const phoneRaw = payload.phone ?? payload.account;
  const phone = normalizePhone(typeof phoneRaw === "string" ? phoneRaw : "");
  const pin = String(payload.pin ?? "").trim();

  // ── 格式驗證：唔消耗嘗試次數（唔涉及帳號存在性，唔係枚舉面）──
  if (!isValidMacauPhone(phone)) {
    return fail("bad_request", "請輸入 8 位數字電話號碼。", 400);
  }
  if (!/^\d{4}$/.test(pin)) {
    return fail("bad_request", "請輸入 4 位數字 PIN。", 400);
  }

  // ── 雙維度限流（契約 §4.5.2：同 IP／同電話）──
  // 一定要兩個都做：只鎖電話 → 換號碼即繞過；只鎖 IP → 同一部機試遍全店電話。
  const ipKey = `member-login:ip:${clientIp(request)}`;
  const phoneKey = `member-login:phone:${phone}`;

  const ipState = memberLoginLimiter.check(ipKey);
  if (!ipState.allowed) {
    return fail("rate_limited", "嘗試過於頻繁，請稍後再試。", 429, {
      retryAfterSec: ipState.retryAfterSec,
    });
  }
  const phoneState = memberLoginLimiter.check(phoneKey);
  if (!phoneState.allowed) {
    // 對應確認稿 S3b：帳號鎖定 + 「請於 HH:MM 後再試」；同時提示「仍然可以點餐」。
    return fail("locked", "此帳號嘗試次數過多，已暫時鎖定。", 429, {
      retryAfterSec: phoneState.retryAfterSec,
    });
  }

  try {
    const result = await loginCustomer({ phone, pin, merchantId: storeId });

    // 成功即清掉失敗紀錄（唔可以跨成功保留，否則客人偶爾打錯一次會累積到鎖）。
    memberLoginLimiter.clear(phoneKey);

    return NextResponse.json({
      ok: true,
      member: {
        customerId: result.customerId,
        displayName: result.displayName,
        balanceAvos: result.wallet.balanceAvos,
        paidBalanceAvos: result.wallet.paidBalanceAvos,
        giftBalanceAvos: result.wallet.giftBalanceAvos,
      },
    });
  } catch (err) {
    if (err instanceof CustomerLoginError) {
      if (err.reason === "bad_credential") {
        // 帳號唔存在 / 未設 PIN / PIN 錯 —— 一律同一句（防枚舉，契約 §4.5.2 尾段）。
        const next = memberLoginLimiter.recordFailure(phoneKey);
        return fail("bad_credential", "電話號碼或 PIN 不正確。", 401, {
          remainingAttempts: next.remaining,
          retryAfterSec: next.allowed ? 0 : next.retryAfterSec,
        });
      }
      if (err.reason === "not_configured") {
        return fail("not_configured", "會員登入服務尚未設定，請聯絡管理員。", 503);
      }
      // upstream：**唔計失敗次數** —— Ledger 打嗝唔應該鎖死客人。
      return fail("upstream", "連線不穩定，請稍後再試。", 502);
    }
    console.error("[ledger/member-login] 非預期錯誤:", err);
    return fail("upstream", "系統暫時無法處理，請稍後再試。", 500);
  }
}
