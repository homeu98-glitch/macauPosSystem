import { NextResponse } from "next/server";

import { verifyMemberQrTokenFromEnv } from "@/lib/ledger/member-qr.server";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/ledger/member-qr/verify` —— 把客人出示嘅會員碼換成 8 位電話。
 *
 * ## 點解要 server
 * `AUTH_PIN_PEPPER` 只可以留喺 server；呢條 route 係 POS 端唯一嘅驗章入口，
 * 唔會打 Ledger Web Server Action（契約 §1.2 禁止）。
 *
 * ## 安全
 *  - 限流 60 次 / 15 分鐘 / IP（同 scan-debit quote 同一道閘）。
 *  - 對外**唔分**「簽章錯／過期／格式錯」，一律 `{ ok:false }`，避免變 oracle。
 *  - 唔 log token、唔 log phone；回應 `no-store`（契約 §7.2 個資唔落快取／本機）。
 *  - token 本身 120 秒到期 + HMAC 128-bit，冇有效 token 嘅請求學唔到任何嘢。
 *
 * ⚠️ 呢條係「轉換一個已有 capability」嘅唯讀端點，同 `/api/ledger/member-login`
 *    ／`scan-debit` 一樣屬匿名通道，故唔用 `posRouteAuthGuard`（要綁 storeId）。
 *    若要再收緊，可以改為由 client 帶 POS 裝置憑證 + storeId 過閘。
 */
export async function POST(request: Request) {
  if (!rateLimit(`member-qr-verify:${clientIp(request)}`, 60, 15 * 60_000)) {
    return NextResponse.json(
      { ok: false, error: "請求過於頻繁，請稍後再試。" },
      { status: 429, headers: { "Cache-Control": "no-store" } },
    );
  }

  let token: unknown;
  try {
    const body = (await request.json()) as { token?: unknown };
    token = body?.token;
  } catch {
    return verifyResponse();
  }

  const result = verifyMemberQrTokenFromEnv(token);
  if (!result.ok) {
    if (result.reason === "not_configured") {
      return NextResponse.json(
        { ok: false, error: "伺服器尚未設定會員碼驗章金鑰，請聯絡管理員。" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    return verifyResponse();
  }
  return verifyResponse(result.phone);
}

function verifyResponse(phone?: string) {
  return NextResponse.json(
    phone ? { ok: true, phone } : { ok: false },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
