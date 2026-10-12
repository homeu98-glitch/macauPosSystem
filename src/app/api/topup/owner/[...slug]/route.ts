import { NextRequest, NextResponse } from "next/server";

import { fetchTopupShopId } from "@/lib/topup/fetch-shop-id.server";
import {
  createTopupSessionStore,
  type TopupOwnerIdentity,
} from "@/lib/topup/owner-session.server";
import {
  getTopupBaseUrl,
  isTopupSsoConfigured,
  signTopupOwnerSsoToken,
} from "@/lib/topup/sso.server";
import {
  prepareLedgerServerClient,
  resolveLedgerPublicConfig,
} from "@/lib/ledger/supabase-server-auth";

/**
 * 店主審核 API 嘅 server-side proxy。
 *
 * 目的：取代 macau-pos 入面嵌 topup 嘅 iframe —— macau-pos 原生 React UI 改為 call 呢度，
 * 呢度再簽 Site A（macau-pos）owner JWT、轉發去 topup 嘅 /api/owner/* 端點。
 *
 * ⚠️ 唔好再假設「topup 嘅 owner 端點經 resolveOwnerRequest 接受 Bearer」—— 嗰個版本
 *    從來冇進過部署 repo（只喺另一份本地副本出現過），詳情見下面第 5 步。
 *
 * 認證流程完全 mirror 現有 /api/topup/owner-embed 與 /api/topup/pending-count：
 *   1. 驗 Ledger Bearer → 2. merchant_staff → 3. fetchTopupShopId 拎 8 位編號
 *   4. signTopupOwnerSsoToken 簽 JWT → 5. 轉發去 topup。
 *
 * 🔴 第 5 步嘅關鍵（2026-10-13）：已部署嘅 topup 係 `api/index.js` catch-all → `routes/owner/*.js`，
 *   嗰啲 route 用 `readSession(req)` **只認 `topup_session` cookie**，完全唔讀 `Authorization`。
 *   直接 Bearer 轉發會 100% 返 401「請先以店主身份登入」（實測：帶同冇帶 JWT 回應完全一樣）。
 *   所以呢度要先 `POST /api/auth/sso-login {ssoToken}` 換一條 session cookie 出嚟（鏡像
 *   `public/owner.html?ssoToken=` 嘅瀏覽器行為），再用 `Cookie` 頭打 `/api/owner/*`。
 *   Bearer 仍然一併帶住：將來 topup 升級到支援 `resolveOwnerRequest` 之後可以無痛過渡。
 *
 * 靜態路徑 /api/topup/owner-embed 與 /api/topup/owner/pending-count 唔會中呢度（Next 優先靜態段）。
 */

function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

type ProxyContext = { params: Promise<{ slug: string[] }> };

/** 每個 server instance 一份 session cookie 快取（同一間舖 6 小時內唔使重複換票）。 */
const topupSessions = createTopupSessionStore();

export async function GET(request: NextRequest, ctx: ProxyContext) {
  return guard(proxyOwnerRequest(request, ctx, "GET"));
}

export async function POST(request: NextRequest, ctx: ProxyContext) {
  return guard(proxyOwnerRequest(request, ctx, "POST"));
}

/**
 * 換票／轉發失敗要出**可讀**嘅中文原因畀面板（否則只會見到 Network error，
 * 根本睇唔出係 SSO secret 唔夾定係 topup 嗰邊拒絕）。
 */
async function guard(pending: Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await pending;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return NextResponse.json(
      { ok: false, error: message || "無法連線到充值審核服務。" },
      { status: 502 },
    );
  }
}

async function proxyOwnerRequest(
  request: NextRequest,
  ctx: ProxyContext,
  method: "GET" | "POST",
) {
  if (!isTopupSsoConfigured()) {
    return NextResponse.json(
      { ok: false, error: "POS 尚未設定 TOPUP_SITEA_SSO_SECRET，無法接入充值審核。" },
      { status: 503 },
    );
  }

  const ledgerToken = readBearerToken(request);
  if (!ledgerToken) {
    return NextResponse.json({ ok: false, error: "缺少 Ledger 登入憑證。" }, { status: 401 });
  }

  const { url, anonKey } = resolveLedgerPublicConfig();
  if (!url || !anonKey) {
    return NextResponse.json({ ok: false, error: "Ledger Supabase 環境變數未設定。" }, { status: 503 });
  }

  const body = method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const refreshToken =
    (body.refreshToken as string | undefined) ??
    request.nextUrl.searchParams.get("refreshToken") ??
    null;

  const supabase = await prepareLedgerServerClient(ledgerToken, refreshToken);
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Ledger Supabase 環境變數未設定。" }, { status: 503 });
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(ledgerToken);
  if (userError || !userData.user?.id) {
    return NextResponse.json({ ok: false, error: "Ledger 登入已過期，請重新登入 POS。" }, { status: 401 });
  }

  const { data: staffRows, error: staffError } = await supabase
    .from("merchant_staff")
    .select("merchant_id, staff_role")
    .eq("user_id", userData.user.id)
    .limit(1);

  if (staffError || !staffRows?.[0]?.merchant_id) {
    return NextResponse.json(
      { ok: false, error: "此帳號未綁定 merchant_staff，無法使用充值審核。" },
      { status: 403 },
    );
  }

  const staffRow = staffRows[0];
  const { data: merchantRows } = await supabase
    .from("merchants")
    .select("name")
    .eq("id", staffRow.merchant_id)
    .limit(1);
  const merchant = merchantRows?.[0] as { name?: string } | undefined;

  const staffAccount = String(
    (body.staffAccount as string | undefined) ?? request.nextUrl.searchParams.get("staffAccount") ?? "",
  )
    .replace(/\D/g, "")
    .slice(0, 8);

  const { shopId } = await fetchTopupShopId(supabase, {
    merchantId: staffRow.merchant_id,
    staffRole: staffRow.staff_role as string | undefined,
    userEmail: userData.user.email,
    staffAccount,
  });

  if (!/^\d{8}$/.test(shopId)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "無法取得充值店舖編號。請以店主帳號登入 POS，或在 Vercel 設定 TOPUP_SHOP_ID_OVERRIDES（merchant UUID → 8 位店舖編號）。",
      },
      { status: 400 },
    );
  }

  const shopName = merchant?.name?.trim() || shopId;
  const ownerLogin = /^\d{8}$/.test(staffAccount) ? staffAccount : shopId;
  const identity = { shopId, shopName, ownerLogin };

  const slug = (await ctx.params).slug;
  const topupPath = slug.join("/");
  const topupUrl = `${getTopupBaseUrl()}/api/owner/${topupPath}${request.nextUrl.search}`;

  let sessionCookie = await topupSessions.get(identity);
  let topupRes = await callTopupOwnerApi(topupUrl, method, body, sessionCookie, identity);

  // session 過期／被踢：重新換一次票再試一次（jti 一次性，必須重簽）。
  if (topupRes.status === 401) {
    sessionCookie = await topupSessions.refresh(identity);
    topupRes = await callTopupOwnerApi(topupUrl, method, body, sessionCookie, identity);
  }

  // topup 每次成功都會 refreshSession 回一條新 cookie，順手更新快取。
  topupSessions.remember(shopId, topupRes);

  const payload = (await topupRes.json().catch(() => ({}))) as Record<string, unknown>;
  return NextResponse.json(payload, { status: topupRes.status });
}

async function callTopupOwnerApi(
  topupUrl: string,
  method: "GET" | "POST",
  body: Record<string, unknown>,
  sessionCookie: string,
  identity: TopupOwnerIdentity,
): Promise<Response> {
  return fetch(topupUrl, {
    method,
    headers: {
      // topup 嘅 /api/owner/* 靠呢條 cookie 認身分；Bearer 只係向前相容（見檔案頭註解）。
      Cookie: sessionCookie,
      Authorization: `Bearer ${signTopupOwnerSsoToken(identity)}`,
      "Content-Type": "application/json",
    },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}
