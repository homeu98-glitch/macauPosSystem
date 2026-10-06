// POST /api/pos/grabber/ingest — **Android 商戶 APK** 抓單上送入口。
//
// 對應 APK 端 `grabber/GrabberIngest.kt` → `posrelay/RelayApi.postGrabberIngest()`。
// 認證沿用**現有堂食 POS 配對**（`x-agent-id` / `x-agent-token`），零新憑證。
//
// ══════════════════════════════════════════════════════════════════════
// 🔴 同插件路線（/api/integration/grabber/orders）嘅關係
// ══════════════════════════════════════════════════════════════════════
// 插件嗰條**照舊存在、照舊運作**（唔改、唔刪）—— 兩條路線並存：
//   · 插件 → /api/integration/grabber/orders   （共享密鑰，直接投影 pos_orders）
//   · APK  → /api/pos/grabber/ingest          （agent token，先落 inbox）
//
// 點解 APK 唔直接用插件嗰條？三個**真實**分別（唔係風格選擇）：
//   1. 認證：插件用 `GRABBER_SHARED_SECRET`（環境變數，同其他環境共用一個）。
//      APK 已有 per-store 嘅 agent token，唔應該再引入第二個全域密鑰
//      （全域密鑰一泄 = **所有店**同時中招）。
//   2. 落地：插件直接寫 `pos_orders`（DO NOTHING）。
//      APK 要先落 `pos_grabber_inbox` 帶 **raw JSON**，原因見 0064 檔頭。
//   3. 旗標：APK 有「第 1 層看不看得到」開關（`capability`），插件冇。
//
// 投影邏輯（`projectGrabberOrder`）**共用** `lib/grabber/grabber-order.ts`，
// 唔會出現「兩份投影規則」—— 呢個係最重要嘅設計要求。
import { NextResponse } from "next/server";

import {
  projectGrabberOrder,
  type GrabberOrder,
  type GrabberOrderRow,
} from "@/lib/grabber/grabber-order";
import { readAgentHeaders, verifyAgent } from "@/lib/print-agent-server";
import { getSupabaseWriteClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/** 單批上限（對齊 APK 嘅 `BATCH = 50`）。超咗要分批送，唔可以照單全收。 */
const MAX_ROWS = 200;
/** payload 大小上限（避免有人用大字串灌爆 Vercel 請求體）。 */
const MAX_BODY_BYTES = 1_000_000;

const PLATFORM_ALLOW = new Set(["mfood", "aomi", "mpay"]);
const KIND_ALLOW = new Set(["order", "settlement", "finance"]);

interface IngestRow {
  dedup_key?: unknown;
  source_id?: unknown;
  trade_no?: unknown;
  store_name?: unknown;
  amount_mop?: unknown;
  business_amount_mop?: unknown;
  status_text?: unknown;
  placed_at_ms?: unknown;
  begin_date?: unknown;
  end_date?: unknown;
  bill_date?: unknown;
  gross_amount_mop?: unknown;
  net_amount_mop?: unknown;
  is_settled?: unknown;
  raw?: unknown;
}

/** 數字欄位容錯讀取：JSON number、數字字串、null／缺欄 → undefined。 */
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}
/** epoch ms → ISO；0／負數／唔合理 → null（唔好塞 1970 落庫）。 */
function iso(ms: number | undefined): string | null {
  if (ms === undefined || ms <= 0) return null;
  const d = new Date(ms);
  const t = d.getTime();
  if (!Number.isFinite(t) || t <= 0 || t > 4102444800000) return null;
  return d.toISOString();
}

export async function POST(request: Request) {
  // ---- ① 認證（POST 路由，所以**可以** recordActivity）----
  const { agentId, token } = readAgentHeaders(request);
  const agent = await verifyAgent(agentId, token, { recordActivity: true });
  if (!agent) {
    return NextResponse.json({ ok: false, error: "agent 驗證失敗" }, { status: 401 });
  }

  // ---- ② 讀 body（帶大小上限）----
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { ok: false, error: "payload 過大，請分批" },
      { status: 413 },
    );
  }
  let payload: {
    storeId?: unknown;
    platform?: unknown;
    kind?: unknown;
    rows?: unknown;
  };
  try {
    payload = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: "JSON body 格式錯誤" }, { status: 400 });
  }

  // ---- ③ 參數校驗 ----
  // 🔴 綁店：body 嘅 storeId 同 token 對應嘅 store **必須一致**。
  //    唔可以信任 body —— 否則任何一間已配對嘅機都可以寫入其他店（跨店污染）。
  const storeId = str(payload.storeId);
  if (!storeId) {
    return NextResponse.json({ ok: false, error: "缺少 storeId" }, { status: 400 });
  }
  if (storeId !== agent.storeId) {
    console.error(
      `[grabber/ingest] 🔴 storeId 不符（token 對應 ${agent.storeId}，body ${storeId}）⇒ 拒收`,
    );
    return NextResponse.json({ ok: false, error: "storeId 不符" }, { status: 403 });
  }

  const platform = str(payload.platform);
  const kind = str(payload.kind);
  if (!platform || !PLATFORM_ALLOW.has(platform)) {
    return NextResponse.json({ ok: false, error: `未知平台：${String(payload.platform)}` }, { status: 400 });
  }
  if (!kind || !KIND_ALLOW.has(kind)) {
    return NextResponse.json({ ok: false, error: `未知 kind：${String(payload.kind)}` }, { status: 400 });
  }

  const rowsIn = Array.isArray(payload.rows) ? (payload.rows as IngestRow[]) : [];
  if (rowsIn.length === 0) {
    // 空批 = 正常情況（今日冇單）。回 200，唔好當錯誤。
    return NextResponse.json({ ok: true, inserted: 0, updated: 0, rejected: 0, warnings: [] });
  }
  if (rowsIn.length > MAX_ROWS) {
    return NextResponse.json(
      { ok: false, error: `單批上限 ${MAX_ROWS} 筆（收到 ${rowsIn.length}），請分批` },
      { status: 400 },
    );
  }

  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase 未配置" }, { status: 503 });
  }

  // ---- ④ 逐列解析 + 髒資料隔離 ----
  //
  // 🔴 **單列隔離**：一列解析唔到，只標 reject_reason，唔令成批失敗。
  //    舊插件係成批 upsert，一列爆就全批冇入 —— 嗰個係 2026-09-29 排查到嘅痛點。
  const inboxRows: Record<string, unknown>[] = [];
  const projection: { row: GrabberOrderRow; parse: Record<string, unknown> }[] = [];
  const rejected: { dedupKey: string; reason: string }[] = [];
  const warnings: string[] = [];

  for (const r of rowsIn) {
    const dedupKey = str(r.dedup_key);
    if (!dedupKey) {
      rejected.push({ dedupKey: "(無 dedup_key)", reason: "缺少 dedup_key" });
      continue;
    }
    // 防止 dedup_key 太長撐爆索引 / 令 log 難讀
    if (dedupKey.length > 200) {
      rejected.push({ dedupKey: dedupKey.slice(0, 60) + "…", reason: "dedup_key 過長" });
      continue;
    }

    const raw = (r.raw && typeof r.raw === "object" ? r.raw : null) as Record<string, unknown> | null;
    const occurredAt = iso(num(r.placed_at_ms));

    if (kind === "settlement") {
      // 對帳：inbox 落地為主，投影 pos_orders 係「之後」嘅事（唔喺呢度硬做）。
      inboxRows.push({
        store_id: storeId,
        platform,
        kind,
        dedup_key: dedupKey,
        raw,
        parse_ok: true,
        reject_reason: null,
        occurred_at: occurredAt,
        captured_at: new Date().toISOString(),
      });
      continue;
    }

    // ---- order：投影 ----
    const sourceId = str(r.source_id);
    if (!sourceId) {
      rejected.push({ dedupKey, reason: "缺少 source_id（平台單號）" });
      continue;
    }
    const amount = num(r.amount_mop);
    if (amount === undefined) {
      rejected.push({ dedupKey, reason: "缺少／非法 amount_mop" });
      continue;
    }

    // 🔴 三個金額一次過解析（同一個 row 可能重覆用）。
    const business = num(r.business_amount_mop);
    const gross = num(r.gross_amount_mop);
    const net = num(r.net_amount_mop);

    // ⚠️ 餵畀**共用**嘅投影函式。
    //
    // 🔴 形狀必須對齊 `GrabberOrder`（`lib/grabber/grabber-order.ts:39`）：
    //    金額喺 `amount` **物件**入面（`turnoverAmount` / `businessAmount` / `payAmount`），
    //    時間喺 `occurredAt`，品項喺 `items`。
    //    ⚠️ 唔可以用 `totalAmount` / `createdAt` 呢啲「想當然」嘅名 ——
    //       `GrabberOrder` 有 `[key: string]: unknown` 索引簽章，TypeScript **唔會報錯**，
    //       但投影會靜靜讀 `order.amount ?? {}`（→ 0）⇒ 單會以為「營業額 0」而照入單。
    //       呢個係最難查嗰種「編譯通過但資料全錯」。
    const order: GrabberOrder = {
      source: platform,
      externalOrderId: sourceId,
      ...(str(r.trade_no) ? { tradeNo: str(r.trade_no) } : {}),
      ...(str(r.store_name) ? { storeName: str(r.store_name) } : {}),
      // 🔴 `amount` 用物件形狀。`turnoverAmount` = 計入營業額（已扣商家活動支出），
      //    係投影函式優先讀嘅欄位，所以由 `business_amount_mop` 餵。
      //    APK 冇提供時退回 `payAmount`（= 客人實付），投影會記一個 warning。
      amount: {
        payAmount: amount,
        ...(business !== undefined ? { businessAmount: business, turnoverAmount: business } : {}),
      },
      ...(str(r.status_text) ? { orderStatus: str(r.status_text) } : {}),
      occurredAt,
      // 🔴 raw 一律帶上（0064 嘅存在意義之一）：投影函式會從入面抽
      //    餐盒費／膠袋費／服務費，所以**唔可以**只留 `__apk` 摘要。
      raw: {
        ...(raw ?? {}),
        __apk: {
          storeId,
          platform,
          kind,
          dedupKey,
          statusText: str(r.status_text),
          businessAmountMop: business,
          grossAmountMop: gross,
          netAmountMop: net,
          isSettled: bool(r.is_settled),
          beginDate: str(r.begin_date),
          endDate: str(r.end_date),
          billDate: str(r.bill_date),
        },
      },
    };

    const result = projectGrabberOrder({
      order,
      storeId,
      platformZone: null,
      defaultPrinterGroup: "kitchen",
      // 🔴 APK 路線一律 draft（待確認）—— 自動接單嗰個掣**共用緊**，
      //    而且呢度唔讀 `pos_online_order_settings`：與其猜測，寧願交返俾
      //    店員撳「接受」。後續如果 Joe 決定要支援自動接單，呢度再讀。
      autoAccept: false,
    });

    if (!result.ok || !result.row) {
      const reason = result.reason ?? "未知原因";
      rejected.push({ dedupKey, reason });
      // 🔴 髒資料**仍然要留低**：否則事後完全查唔到平台送過咩。
      inboxRows.push({
        store_id: storeId,
        platform,
        kind,
        dedup_key: dedupKey,
        raw,
        parse_ok: false,
        reject_reason: reason,
        occurred_at: occurredAt,
        captured_at: new Date().toISOString(),
      });
      continue;
    }

    for (const w of result.warnings) warnings.push(`${result.row.local_order_no}：${w}`);
    projection.push({ row: result.row, parse: { dedupKey, ok: true, reason: null } });
    inboxRows.push({
      store_id: storeId,
      platform,
      kind,
      dedup_key: dedupKey,
      local_order_no: result.row.local_order_no,
      raw,
      parse_result: [result.row.local_order_no ? { dedupKey, ok: true } : { dedupKey, ok: true }],
      parse_ok: true,
      reject_reason: null,
      occurred_at: occurredAt,
      captured_at: new Date().toISOString(),
    });
  }

  // ---- ⑤ 寫 inbox（冪等：ON CONFLICT DO NOTHING）----
  //
  // 🔴 為什麼用 `ignoreDuplicates`（DO NOTHING）而唔係 upsert：
  //    同插件路線一致 —— 已經存在嘅單**唔可以**覆蓋，否則店員已推進嘅
  //    狀態（已接受／製作中／完成）會被打返「待確認」。
  //    APK 會重複送同一單（每次重查都送）⇒ 冇呢個就會炸出幾百張重複單。
  let inserted = 0;
  if (inboxRows.length > 0) {
    const { error } = await supabase
      .from("pos_grabber_inbox")
      .upsert(inboxRows, {
        onConflict: "store_id,platform,kind,dedup_key",
        ignoreDuplicates: true,
      });
    if (error) {
      const status = error.code === "42P01" ? 503 : 500;
      console.error("[grabber/ingest] inbox 寫入失敗", error.code, error.message);
      return NextResponse.json(
        {
          ok: false,
          error:
            status === 503
              ? "POS 側 grabber 未初始化（請 Joe 執行 migration 0064）"
              : `inbox 寫入失敗：${error.message}`,
        },
        { status },
      );
    }
  }

  // ---- ⑥ 投影入 pos_orders ----
  //
  // ⚠️ **只有新插入嘅可以投影**。用 `.select("id, external_order_id")` 回讀
  //    今次真正新增嘅（DO NOTHING 會跳過已存在）⇒ 唔會重複投影，
  //    亦唔會覆蓋店員改過嘅單。
  let projected = 0;
  if (projection.length > 0) {
    const orderRows = projection.map((p) => p.row);
    const { data: ins, error: pErr } = await supabase
      .from("pos_orders")
      .upsert(orderRows, {
        onConflict: "store_id,source,external_order_id",
        ignoreDuplicates: true,
      })
      .select("id");
    if (pErr) {
      // 🔴 入單係主業、inbox 係稽核。但唔可以因為投影失敗就話「成功」。
      console.error("[grabber/ingest] pos_orders 投影失敗", pErr.code, pErr.message);
      return NextResponse.json(
        {
          ok: false,
          error: `投影失敗：${pErr.message}`,
          // 已經安全落地，APK 可以顯示「已落地但未入單」
          landed: inboxRows.length,
          rejected,
        },
        { status: 500 },
      );
    }
    projected = Array.isArray(ins) ? ins.length : 0;
  }

  // ---- ⑦ 稽核（0062 既有表）----
  //    best-effort：寫唔到都照返 ok（入單係主業）。
  let auditLogged = false;
  if (inboxRows.length > 0) {
    try {
      const { error } = await supabase.from("pos_grabber_push_log").insert({
        store_id: storeId,
        source: `apk:${platform}`,
        client_version: null,
        received_count: rowsIn.length,
        created_count: projected,
        skipped_count: Math.max(0, projection.length - projected),
        rejected_count: rejected.length,
        external_order_ids: rowsIn.map((r) => str(r.source_id)).filter((x): x is string => !!x),
        local_order_nos: projection.map((p) => p.row.local_order_no),
        rejected_detail: rejected,
        captured_at: new Date().toISOString(),
      });
      auditLogged = !error;
      if (error && error.code !== "42P01") {
        console.error("[grabber/ingest] 稽核寫入失敗（不影響入單）", error.message);
      }
    } catch (e) {
      console.error("[grabber/ingest] 稽核拋錯（不影響入單）", e);
    }
  }

  // ---- ⑧ 回應 ----
  //
  // 🔴 契約：APK `GrabberIngestResult` 讀 `ok` / `inserted` / `updated` / `rejected`。
  //    `updated` = 「inbox 冪等擋走咗幾多」（即重送重複單）。
  //    ⚠️ 唔可以將「未更新」當成新單 —— APK 端有明確註解。
  const landedOk = inboxRows.length - rejected.length;
  const updated = Math.max(0, landedOk - inserted);

  return NextResponse.json({
    ok: true,
    received: rowsIn.length,
    inserted: projection.length > 0 ? projected : 0,
    updated,
    projected,
    rejectedCount: rejected.length,
    // APK 用 `rejected`（單數）讀拒收數，兩者都提供避免日後漂移
    rejected: rejected.length,
    rejectedDetail: rejected.slice(0, 20),
    warnings: warnings.slice(0, 10),
    auditLogged,
  });
}
