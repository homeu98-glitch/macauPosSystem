import { NextResponse } from "next/server";

import { normalizeGrabberSource } from "@/lib/grabber/grabber-order";
import {
  grabberSecretsMatch,
  readGrabberSecretFromRequest,
  readGrabberSharedSecret,
} from "@/lib/grabber/grabber-secret";
import {
  createTradeNoIdIndex,
  groupSettlementByOrder,
  normalizePeriodAmounts,
  normalizeTradeNo,
  toAmountOrNull,
  tradeNoQueryKeys,
  type PlatformSettlementTxn,
} from "@/lib/pos/platform-settlement";
import { getSupabaseServerClient } from "@/lib/supabase-server";

/**
 * 外賣平台**結算（實收）** → POS：插件推送平台財務對帳資料嘅入站端點。
 *
 * ── 為什麼要另開一條 route（而唔係塞入 /grabber/orders）────────────────
 * `orders` route 係 **`ON CONFLICT DO NOTHING`**（刻意唔覆蓋，保護店員已推進嘅狀態）。
 * 但結算資料**必須係 UPDATE** —— 同一張單「先入單、後對帳」，
 * 對帳時要補寫實收金額落**已存在嘅列**。語意完全相反，唔可以共用一條 route。
 *
 * ── 🔴 只寫三個欄位，其他一律唔碰 ─────────────────────────────────────
 *   `platform_net_amount` / `platform_subsidy_net` / `platform_settled_at`
 *   絕對唔可以順手寫 `status` / `total` / `items` —— 呢條 route 冇任何
 *   業務狀態嘅權威（平台對帳資料只有錢，冇「訂單做到邊」嘅資訊）。
 *   一次覆蓋就會把店員已推進嘅狀態打返，係最嚴重嘅一種資料損壞。
 *
 * ── 配對鍵 ──────────────────────────────────────────────────────────
 *   platform `tradeNo` ↔ `pos_orders.external_order_id`
 *   🔴 兩個口徑差一個前綴（2026-09-29 SQL 截圖確診）：
 *      · 接單列表 `id` ＝ `202609250937046870290`（純數字）＝ external_order_id
 *      · 財務頁明細 `tradeNo` ＝ `CRD202609250937046870290`（多 `CRD`）
 *      ⇒ 一定要經「前綴無關」配對（`createTradeNoIdIndex`，見 platform-settlement.ts）；
 *        攞 `tradeNo` 直接 `.in(external_order_id)` 會**一條都唔中** ⇒ 全部 notFound。
 *   ⚠️ 唔可以用 `local_order_no`（`#1` / `#2`）—— 嗰個係 POS 本地序號，
 *      平台完全唔知呢個號，兩邊配對唔上。
 *
 * ── 密鑰 ────────────────────────────────────────────────────────────
 *   同 `orders` route 共用 `GRABBER_SHARED_SECRET`（見 `grabber-secret.ts`）。
 */

/** 限流：每分鐘 30 次（對帳係低頻動作，唔似訂單列表要密抓）。 */
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 30;
const attempts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const bucket = attempts.get(key);
  if (!bucket || now >= bucket.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (bucket.count >= MAX_ATTEMPTS) return false;
  bucket.count += 1;
  return true;
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return request.headers.get("x-real-ip") ?? "unknown";
}

/**
 * 把 payload 嘅 `transactions` 逐筆正規化成 `PlatformSettlementTxn`。
 *
 * ⚠️ 欄位名係**平台原始名**（`tradeNo` / `storeReceiveAmtn` / `subsidyStoreReceiveAmtn`），
 *    用戶提供嘅真實 payload 就係呢啲名。插件直接原樣送過嚟，
 *    呢度負責改名 → 唔可以要求插件先改名（插件嗰邊冇 TS 型別保護，易漏）。
 */
function readTxns(raw: unknown): PlatformSettlementTxn[] {
  if (!Array.isArray(raw)) return [];
  const out: PlatformSettlementTxn[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    out.push({
      // 支援兩種寫法：平台原始名 tradeNo，或者插件已改名 externalOrderId。
      externalOrderId:
        normalizeTradeNo(r.tradeNo) ?? normalizeTradeNo(r.externalOrderId),
      netAmount: toAmountOrNull(r.storeReceiveAmtn ?? r.netAmount),
      subsidyNet: toAmountOrNull(r.subsidyStoreReceiveAmtn ?? r.subsidyNet),
      businessAmount: toAmountOrNull(r.storeBusinessAmtn ?? r.businessAmount),
      serviceFee: toAmountOrNull(r.platformServiceFee ?? r.serviceFee),
    });
  }
  return out;
}

/**
 * 讀插件送嚟嘅**帳期級**金額（`payload.periodAmounts`）。
 *
 * ── 為什麼要有（2026-09-28 真機實證）────────────────────────────────
 * 逐單配對（上面 `readTxns` ＋ `external_order_id`）當年**實測配對唔上**：
 * 平台 transaction 嘅 `tradeNo` 同 POS 記錄嘅平台單號唔一致 ⇒ 全部 `notFound`
 * ⇒ 報表三格永遠「待對帳」。
 * （真因 2026-09-29 確診：`tradeNo` 多一個 `CRD` 前綴，見 `tradeNoCore` —— 已修。
 *   呢筆帳期保底照留：帳期數字平台一定有，唔受逐單配對成敗影響。）
 * 但平台財務頁**一載入就已經有**帳期級金額（`_list` 回應自帶）。
 * ⇒ 呢筆係報表嘅**保底**：逐單配唔上，三格仍然有數。
 *
 * 正規化用 `normalizePeriodAmounts()`（純函式、有單測）—— route 唔可以自己再寫一套。
 *
 * @returns `null` ＝ 插件冇送 / 送咗但唔可用（冇 period 或者金額全空）。
 *          呢種情況**唔會**寫 DB（免得落一筆假帳期）。
 */
function readPeriodAmounts(raw: unknown) {
  const n = normalizePeriodAmounts(raw);
  if (!n) return null;
  return {
    period: n.period,
    should: n.should,
    receive: n.receive,
    subsidy: n.subsidy,
    fee: n.fee,
    // 原始物件原樣存落 `raw` jsonb（審計用：事後核對數字點嚟）
    raw: raw && typeof raw === "object" ? raw : null,
  };
}

export async function POST(request: Request) {
  const expected = readGrabberSharedSecret();
  if (!expected) {
    console.error("[integration/grabber/settlement] GRABBER_SHARED_SECRET 未設定");
    return NextResponse.json({ ok: false, error: "伺服器未設定共享密鑰。" }, { status: 500 });
  }

  if (!grabberSecretsMatch(readGrabberSecretFromRequest(request), expected)) {
    return NextResponse.json({ ok: false, error: "密鑰驗證失敗。" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await request.text()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ ok: false, error: "JSON body 格式錯誤。" }, { status: 400 });
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON body 格式錯誤。" }, { status: 400 });
  }

  const storeId = typeof payload.storeId === "string" ? payload.storeId.trim() : "";
  if (!storeId) {
    return NextResponse.json(
      { ok: false, error: "缺少 storeId（請在插件填 Store ID）。" },
      { status: 400 },
    );
  }

  const source = normalizeGrabberSource(payload.source);
  if (!source) {
    return NextResponse.json(
      { ok: false, error: `未知來源：${String(payload.source)}` },
      { status: 400 },
    );
  }

  const txns = readTxns(payload.transactions);
  const periodAmounts = readPeriodAmounts(payload.periodAmounts);

  // 🔴 兩者都冇才當「冇資料」。
  //    舊寫法係 `txns.length === 0` 就 early return —— 但零重放路徑（v1.61）
  //    抓唔到 transaction 明細、只有帳期金額，會被呢句靜默丟棄
  //    ⇒ 報表三格永遠冇數（正是商家最介意嘅靜默失敗）。
  if (txns.length === 0 && !periodAmounts) {
    return NextResponse.json({ ok: true, received: 0, updated: 0, message: "冇結算資料。" });
  }

  if (!checkRateLimit(`${storeId}:${clientIp(request)}`)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "Supabase 伺服器端未配置，無法寫入結算資料。" },
      { status: 503 },
    );
  }

  // ── 帳期級：upsert（同一店 + 來源 + 帳期 = 一筆，重抓覆蓋）────────────
  //    呢步同逐單 UPDATE 完全獨立：逐單配唔上唔影響呢筆寫入。
  let periodSaved = false;
  if (periodAmounts) {
    const { error: periodError } = await supabase
      .from("pos_platform_settlements")
      .upsert(
        {
          store_id: storeId,
          source,
          period: periodAmounts.period,
          should_amount: periodAmounts.should,
          receive_amount: periodAmounts.receive,
          subsidy_amount: periodAmounts.subsidy,
          service_fee: periodAmounts.fee,
          raw: periodAmounts.raw,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: "store_id,source,period" },
      );

    if (periodError) {
      // 🔴 唔可以靜默 —— 帳期金額係報表三格嘅保底，寫唔入要即刻知
      console.error("[integration/grabber/settlement] 帳期金額寫入失敗", periodError.message);
    } else {
      periodSaved = true;
    }
  }

  // 冇 transaction 明細：帳期寫成功就可以收工（唔係錯誤）
  if (txns.length === 0) {
    return NextResponse.json({
      ok: true,
      received: 0,
      orders: 0,
      updated: 0,
      notFound: [],
      failed: [],
      unmatchedCount: 0,
      periodSaved,
      period: periodAmounts?.period ?? null,
      periodShould: periodAmounts?.should ?? null,
      periodReceive: periodAmounts?.receive ?? null,
      // 帳期寫入失敗時，訊息要明講（唔可以報「成功但冇數」）
      message: periodSaved
        ? "已寫入帳期金額（冇逐單明細）。"
        : "帳期金額寫入失敗（請查看伺服器日誌）。",
    });
  }

  // 同一 tradeNo 多筆 transaction → 加總（拆單／部分退款會出現）。
  const { byOrder, unmatchedCount } = groupSettlementByOrder(txns);

  // ── 逐單配對：一定要「前綴無關」（2026-09-29 確診，見 `tradeNoCore`）────
  //
  // 🔴 舊寫法攞 `tradeNo` 直接 `.in("external_order_id", …)`：mfood 接單 `id`
  //    係純數字、財務頁 `tradeNo` 多一個 `CRD` ⇒ 一條都唔中 ⇒ 全部 notFound
  //    ⇒ 訂單詳情永遠「待平台對帳」（下面嘅帳期級 upsert 就係嗰陣嘅繞路）。
  //
  // 查詢用「原值 ＋ 核心」兩種鍵；配對 exact 優先、核心兜底 ——
  // 全部收喺 `createTradeNoIdIndex()`（純函式、有單測），route 唔可以自己再寫一套。
  const tradeNos = [...byOrder.keys()];
  const queryKeys = tradeNoQueryKeys(tradeNos);
  const CHUNK = 200;
  const idIndex = createTradeNoIdIndex();

  for (let i = 0; i < queryKeys.length; i += CHUNK) {
    const chunk = queryKeys.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("pos_orders")
      .select("id,external_order_id")
      .eq("store_id", storeId)
      .eq("source", source)
      .in("external_order_id", chunk);

    if (error) {
      // 🔴 冇跑 0060 migration 時，error 唔會係呢句（select 唔涉及新欄位），
      //    真正會撞係下面 update。呢度純粹係查唔到。
      console.error("[integration/grabber/settlement] 查訂單失敗", error.message);
      return NextResponse.json({ ok: false, error: `查訂單失敗：${error.message}` }, { status: 500 });
    }

    idIndex.add(data ?? []);
  }

  const settledAt = new Date().toISOString();
  const updated: { tradeNo: string; orderId: string; netAmount: number; subsidyNet: number }[] = [];
  const notFound: string[] = [];
  const failed: { tradeNo: string; reason: string }[] = [];

  for (const [tradeNo, s] of byOrder) {
    const orderId = idIndex.get(tradeNo);
    if (!orderId) {
      // 平台有、POS 冇 → 可能係「未抓到嘅單」或者「已作廢／已刪」。
      // 🔴 一定要回報，唔可以靜默掉 —— 商家要靠呢個數字判斷抓取係唔係完整。
      notFound.push(tradeNo);
      continue;
    }

    // 🔴 只寫三個結算欄位。絕對唔可以順手寫 status / total / items。
    const { error } = await supabase
      .from("pos_orders")
      .update({
        platform_net_amount: s.netAmount,
        platform_subsidy_net: s.subsidyNet,
        platform_settled_at: settledAt,
      })
      .eq("id", orderId)
      .eq("store_id", storeId);

    if (error) {
      failed.push({ tradeNo, reason: error.message });
      continue;
    }
    updated.push({
      tradeNo,
      orderId,
      netAmount: s.netAmount,
      subsidyNet: s.subsidyNet,
    });
  }

  return NextResponse.json({
    ok: true,
    received: txns.length,
    // 加總後嘅訂單數（同 received 唔同：多筆 transaction 可能屬同一張單）
    orders: byOrder.size,
    updated: updated.length,
    notFound,
    failed: failed.slice(0, 10),
    // 冇 tradeNo 嘅 transaction（無法配對）—— 唔好靜默掉
    unmatchedCount,
    settledAt,
    // 帳期級寫入結果（報表三格嘅保底來源；唔受 notFound 影響）
    periodSaved,
    period: periodAmounts?.period ?? null,
    periodShould: periodAmounts?.should ?? null,
    periodReceive: periodAmounts?.receive ?? null,
  });
}
