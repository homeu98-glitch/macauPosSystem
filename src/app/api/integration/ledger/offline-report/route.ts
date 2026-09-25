import { NextResponse } from "next/server";

import {
  OFFLINE_REPORT_PATH,
  OFFLINE_REPORT_RATE_LIMIT,
  buildOfflineReportResponse,
  clampOfflineReportRange,
  isDateKey,
  normalizeStoreId,
  validateOfflineReportRpc,
  verifyOfflineReportSignature,
} from "@/lib/pos/offline-report";
import { getSupabaseWriteClient } from "@/lib/supabase-server";

/**
 * Ledger（會員通）→ POS：**線下營業摘要**（契約 `docs/integration/pos-offline-report-api.md` v1）
 *
 * ```
 * GET /api/integration/ledger/offline-report?storeId=<uuid>&from=YYYY-MM-DD&to=YYYY-MM-DD
 * X-Ledger-Timestamp: <unix 秒>
 * X-Ledger-Signature: HMAC-SHA256(secret, ts + "." + "GET" + "." + pathWithQuery).hex
 * ```
 *
 * ## 呢條 route 係「刻意唔行 `posRouteAuthGuard()`」嘅例外（要記入鑑權清單）
 *
 * 呼叫方係 **Ledger 伺服器**，冇店員 session、冇 POS 終端憑證 ⇒ 用 HMAC 簽名代替：
 * 簽名覆蓋 query（換 storeId／改區間要重簽）、5 分鐘時間窗、secret 只喺兩邊 server。
 * ⚠️ 唔可以「順手」加 `posRouteAuthGuard()`：會即刻 401，Ledger 整張卡變「暫時無法取得」。
 * ⚠️ 亦**唔可以** fallback 落 `LEDGER_WEBHOOK_SECRET`（唔同方向、唔同用途，共用一把等於
 *    一邊爆就兩邊爆；2026-09-04 已雙方拍板分開）。
 *
 * ## 為何讀 DB 要行 RPC 而唔係 PostgREST 加總
 *
 * `0058_pos_offline_report()`（stable、service_role-only）喺 DB 內一次過加總 ⇒
 * 90 日窗口都只係一個請求、幾個 byte；逐行拉落 Vercel 再加總會反覆踩 egress 紀律。
 *
 * ## 「唔可以渲染假零」
 *
 * 契約明文：任何欄位型別唔符 ⇒ Ledger 整包丟棄並顯示「暫時無法取得」。所以本 route 嘅原則係
 * **要麼回真資料、要麼唔回 200**：RPC 未部署／查詢失敗／回傳值驗不過 → 5xx，
 * 令 Ledger 顯示降級一行，而唔係送一張 0 元卡（假數比冇數危險）。
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ENV_SECRET = "LEDGER_OFFLINE_REPORT_HMAC_SECRET";
const TAG = "[integration/ledger/offline-report]";

/** 限流：每個 storeId 每分鐘 ≤ 30 次（in-memory，Vercel 多實例下係 best-effort）。 */
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_TRACKED_STORES = 5_000;

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  if (attempts.size > MAX_TRACKED_STORES) {
    for (const [k, v] of attempts) if (now >= v.resetAt) attempts.delete(k);
    if (attempts.size > MAX_TRACKED_STORES) attempts.clear();
  }
  const bucket = attempts.get(key);
  if (!bucket || now >= bucket.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + OFFLINE_REPORT_RATE_LIMIT.windowMs });
    return true;
  }
  if (bucket.count >= OFFLINE_REPORT_RATE_LIMIT.max) return false;
  bucket.count += 1;
  return true;
}

function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request) {
  // ── 0. secret 未設 ⇒ fail-closed（唔可以放行無簽名請求）──
  const secret = (process.env[ENV_SECRET] ?? "").trim();
  if (!secret) {
    console.error(`${TAG} ${ENV_SECRET} 未設定 ⇒ 拒絕（fail-closed）`);
    return fail("server_misconfigured", 500);
  }

  // ── 1. 驗簽（契約 §驗證順序 1–2）──
  // ⚠️ 一定要用「收到嘅原字串」：next.config 冇 rewrite／trailingSlash，URL 原樣可讀。
  const url = new URL(request.url);
  const pathWithQuery = `${url.pathname}${url.search}`;
  const signature = verifyOfflineReportSignature({
    timestampHeader: request.headers.get("x-ledger-timestamp"),
    signatureHeader: request.headers.get("x-ledger-signature"),
    pathWithQuery,
    secret,
  });
  if (!signature.ok) {
    // 唔洩漏細節：除咗「我哋自己冇 secret」之外，一律 401
    console.warn(`${TAG} 驗簽失敗 reason=${signature.reason}`);
    return fail("unauthorized", 401);
  }

  // ── 2. 參數（契約 §驗證順序 3）──
  const storeId = normalizeStoreId(url.searchParams.get("storeId"));
  const fromParam = (url.searchParams.get("from") ?? "").trim();
  const toParam = (url.searchParams.get("to") ?? "").trim();
  if (!storeId) return fail("bad_store_id", 400);
  if (!isDateKey(fromParam) || !isDateKey(toParam)) return fail("bad_range", 400);
  if (fromParam > toParam) return fail("bad_range", 400);

  // ── 3. 限流（契約 §驗證順序 6；放喺打 DB 之前保護 DB）──
  if (!checkRateLimit(storeId)) {
    console.warn(`${TAG} 限流：storeId=${storeId}`);
    return fail("too_many_requests", 429);
  }

  // ── 4. 範圍截斷（契約 §驗證順序 4）——route 自己算一次，用嚟核對 RPC 回值 ──
  const range = clampOfflineReportRange(fromParam, toParam);

  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    console.error(`${TAG} SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未配置`);
    return fail("server_misconfigured", 503);
  }

  const { data, error } = await supabase.rpc("pos_offline_report", {
    p_store_id: storeId,
    p_from: range.from,
    p_to: range.to,
  });

  if (error) {
    // 42883 / PGRST202 ＝ 未跑 0058。兩種都當上游未就緒，唔可以回 200 空數。
    const notDeployed = error.code === "42883" || error.code === "PGRST202";
    console.error(
      `${TAG} RPC 失敗 code=${error.code ?? "-"} notDeployed=${notDeployed} msg=${error.message}`,
    );
    return fail(notDeployed ? "rpc_not_deployed" : "upstream_unavailable", 503);
  }

  // ── 5. 嚴格驗證 + 組 payload ──
  const validated = validateOfflineReportRpc(data, range);
  if (!validated.ok) {
    console.error(`${TAG} RPC 回傳值驗證失敗：${validated.reason}`);
    return fail("upstream_unavailable", 503);
  }
  if (!validated.found) return fail("store_not_found", 404);

  const payload = buildOfflineReportResponse({
    storeId,
    range: { from: range.from, to: range.to, clamped: validated.clamped },
    kpi: validated.kpi,
    byPayment: validated.byPayment,
    generatedAt: new Date().toISOString(),
  });

  return NextResponse.json(payload, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      // 契約固定值；日後改回應格式一定要改呢個並事先通知 Ledger。
      "x-pos-offline-report-v": String(payload.v),
      "x-pos-offline-report-path": OFFLINE_REPORT_PATH,
    },
  });
}
