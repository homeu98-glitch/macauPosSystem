import { NextResponse } from "next/server";

import { defaultPosLocalSettings } from "@/lib/mock-data";
import { jsonWithEgressLog } from "@/lib/egress-log-server";
import { readNotePresets, type NotePresetsReadResult } from "@/lib/note-presets-server";
import { mapOrderRow, POS_ORDER_DB_COLUMNS } from "@/lib/pos-order-row";
import { fetchOrdersInRange } from "@/lib/pos-orders-range";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { normalizeDeviceConfig, normalizePosLocalSettings, normalizePrintTemplateSet } from "@/lib/storage";
import {
  DEFAULT_SHIFT_TEMPLATE_PRESET_ID,
  normalizeShiftTemplatePresets,
} from "@/lib/escpos-template";
import { isPosDeviceAuthRequired, readPosDeviceTokenFromRequest } from "@/lib/pos/pos-device-token";
import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";

/** UTC ISO 轉換（lossless）：`2026-09-06T00:00:00+08:00` → `2026-09-05T16:00:00.000Z`。 */
function toUtcIso(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toISOString();
}

/**
 * `?fields=` 嘅白名單（2026-09-21 egress 優化）。
 *
 * 直接由 `POS_ORDER_DB_COLUMNS` 派生 ⇒ **物理上唔可能**請求一個唔存在嘅欄
 * （否則 PostgREST 會 42703 令整個請求失敗）。
 *
 * 用途：對賬守護只需要 `id,status,updated_at` 去核實狀態，但舊版會拉齊 30 欄
 * （每行 1 469 B，其中 `items` 佔大部分）—— 投影後每行 91 B（**16×**），
 * 而核實結果完全等價（`sync-reconcile-daemon.ts` 只比對 `status`）。
 */
const ORDER_FIELD_WHITELIST: ReadonlySet<string> = new Set<string>(POS_ORDER_DB_COLUMNS);

export async function GET(request: Request) {
  const supabase = getSupabaseServerClient();
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  // ── 授權閘（2026-09-10 掃碼點餐審查 P0-4）──
  // 之前呢支 API **完全無鑑權**：知道 storeId（枱 QR 內容已公開）就可以 GET 走
  // 全店訂單（枱號、菜品、備註、金額、時間）+ 打印任務 + 店級設定。
  // 家陣要求 POS 終端憑證（`/api/ledger/login` 簽發）或 admin session token。
  // 應急回滾：設定 `POS_REQUIRE_DEVICE_AUTH=0`。
  const ip = clientIp(request);
  if (!rateLimit(`pos-state:${ip}`, 240, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }
  const authEnforced = isPosDeviceAuthRequired();
  const deviceClaims = readPosDeviceTokenFromRequest(request);
  const adminClaims = readAdminSessionFromRequest(request);
  const authorized = !authEnforced || Boolean(adminClaims) || Boolean(deviceClaims && deviceClaims.storeId === storeId);
  if (!authorized) {
    console.warn(`[pos/state] 拒絕未授權讀取（store=${storeId ?? "?"}, ip=${ip}）`);
    return NextResponse.json(
      {
        ok: false,
        error: "未經授權：讀取店舖資料需要 POS 終端憑證，請重新登入 POS 帳號。",
      },
      { status: 401 },
    );
  }

  // 訂單回傳上限：收銀工作台用預設 200（最新 200 單已足夠），
  // 報表頁需要更完整嘅歷史（今天/7天/30天/全部），可傳 `limit` 拉多啲。
  // 夾喺 [1, 5000]，超出即回報 400，避免惡意超大查詢。
  const rawLimit = searchParams.get("limit");
  let limit = 200;
  if (rawLimit !== null) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 5000) {
      return NextResponse.json({ ok: false, error: "limit 必須為 1–5000 的整數。" }, { status: 400 });
    }
    limit = parsed;
  }

  // 分頁偏移（0-based）。報表「全部/30天」需要分頁拉全量訂單；收銀工作台唔傳 offset（=0）。
  const rawOffset = searchParams.get("offset");
  let offset = 0;
  if (rawOffset !== null) {
    const parsed = Number.parseInt(rawOffset, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100000) {
      return NextResponse.json({ ok: false, error: "offset 必須為 0–100000 的整數。" }, { status: 400 });
    }
    offset = parsed;
  }

  // 報表分頁時只需要訂單，跳過 queue/printJobs/deviceConfig 查詢，省時省流量。
  const ordersOnly = searchParams.get("ordersOnly") === "1";

  // ── 欄位投影（2026-09-21 egress 優化，**optional、唔傳 ＝ 舊行為**）────────
  // 只喺 ordersOnly 生效（全量 state 需要完整 row 做 merge）。
  // 未在白名單嘅欄一律靜默丟棄（唔會 400）—— 寧願回多幾欄，都好過令舊 client 爆。
  const requestedFields = (searchParams.get("fields") ?? "")
    .split(",")
    .map((field) => field.trim())
    .filter((field) => ORDER_FIELD_WHITELIST.has(field));
  const ordersColumns = ordersOnly && requestedFields.length > 0 ? requestedFields.join(",") : undefined;

  // ── 跳過 queue 查詢（2026-09-21 egress 優化，**optional**）──────────────
  // 背景：v2 outbox 之下 client **完全唔 merge server queue**
  //（見 `pos-app.tsx` `if (Array.isArray(payload.queue) && !isOutboxV2Enabled())`），
  // 但呢支 API 每次都照查 300 條 `pos_queue_events`（每條 `payload` 係完整訂單快照
  // ≈1 668 B，合共 ≈500 KB）→ 純浪費。
  // v2 client 會傳 `skipQueue=1`；v1（回溯舊行為）唔傳 = 照查，語義不變。
  const skipQueue = searchParams.get("skipQueue") === "1";

  // 報表區間過濾：只回傳 created_at **或** updated_at **或** reopened_at 落在 [start, end]
  // 內嘅訂單（OR 語義）。
  // OR 係 client 端 orderMatchesReportRange（2026-09-19 起改用 `orderEventInstant()`：
  // `reopenedAt → originalSettledAt → updatedAt → createdAt`）嘅超集，涵蓋
  // 「區間內開單」「區間內結帳/更新」「區間內返結重結」三種情況，
  // 亦涵蓋 NULL updated_at 嘅 legacy row。
  // 問題 6（2026-09-06 修）：
  // - start / end 一律轉 UTC ISO（`...Z`）——避開 PostgREST 對 `+08:00` offset 值嘅解析歧義。
  // - 過濾改用 fetchOrdersInRange() 三腿合併（見 src/lib/pos-orders-range.ts），
  //   唔再用 `.or()` nested 語法（2026-09-04 引入，無長期生產驗證），
  //   亦唔會好似中間版本嘅 AND chain 咁漏「昨日開單、今日結帳」嘅單。
  // 🔴 2026-09-19：加 `reopened_at` 腿 —— 返結唔一定刷新 `updated_at`，
  //   兩腿版本會令「昨日開、今日返結」嘅單靜默消失（報表少錢）。
  const rangeStartRaw = searchParams.get("start")?.trim() || null;
  const rangeEndRaw = searchParams.get("end")?.trim() || null;
  const rangeStart = rangeStartRaw ? toUtcIso(rangeStartRaw) : null;
  const rangeEnd = rangeEndRaw ? toUtcIso(rangeEndRaw) : null;

  if (!supabase) {
    if (ordersOnly) {
      return NextResponse.json({ ok: true, source: "mock", orders: [] });
    }
    return NextResponse.json({
      ok: true,
      source: "mock",
      orders: [],
      queue: [],
      printJobs: [],
      localSettings: defaultPosLocalSettings,
      deviceConfig: null,
      printTemplatesServer: null,
    });
  }

  // 訂單兩腿查詢即刻啟動（唔等下面 queue/printJobs/deviceConfig），保持並行度。
  const ordersInRangePromise = fetchOrdersInRange({
    supabase,
    storeId,
    start: rangeStart,
    end: rangeEnd,
    limit,
    offset,
    // undefined = 用預設投影（＝ mapper 會讀嘅全部欄，語義等同 select("*")）。
    columns: ordersColumns,
  });

  // 報表分頁只拉訂單，跳過其餘 table。
  if (ordersOnly) {
    const ordersInRange = await ordersInRangePromise;
    const orders = ordersInRange.error ? [] : ordersInRange.orders.map(mapOrderRow);
    return jsonWithEgressLog(
      "pos/state",
      { ok: true, source: "supabase", orders },
      {
        mode: "ordersOnly",
        orders: orders.length,
        limit,
        offset,
        columns: ordersColumns ?? "default",
        start: rangeStartRaw ?? "-",
        end: rangeEndRaw ?? "-",
      },
    );
  }

  // 🛡️ 跨店隔離 L2（0022 migration，2026-09-06 修）：queue 一律按 store 過濾。
  // 以前呢度完全冇過濾 → 全店最新 300 條事件派發畀任何 client，loadRuntimeState()
  // merge 入本地 queue 後，flush 用當前登入 merchantId 蓋章推上雲 —— 跨店串號嘅
  // 源頭之一。冇 storeId（未登入又冇 kiosk 綁定）→ limit(0) 返空，寧願冇 queue
  // 都唔好派發其他店嘅事件（fail-safe）。歷史行 store_id IS NULL 天然被 eq 排除。
  //
  // 2026-09-21 egress 優化：`skipQueue=1`（v2 client 會傳）同樣走 limit(0) ——
  // v2 之下 client 唔 merge server queue，呢 300 條 × 1 668 B（≈500 KB）係純浪費。
  // 沿用既有 limit(0) 寫法（同「冇 storeId」同一條路），語義同 fail-safe 一致。
  const queueQuery = !skipQueue && storeId
    ? supabase.from("pos_queue_events").select("*").eq("store_id", storeId).order("created_at", { ascending: false }).limit(300)
    : supabase.from("pos_queue_events").select("*").limit(0);
  // 🛡️ 加固（db review §4.1 #3）：print jobs 同 device config 一律按 store 過濾。
  // 冇 storeId（未登入又冇 kiosk 綁定）→ limit(0) 返空，寧可無 print job / 無遠端 config，
  // 都唔好派發別店嘅打印任務或 terminal 設定（fail-safe；歷史行 store_id IS NULL 天然被 eq 排除）。
  const printJobsQuery = storeId
    ? supabase.from("pos_print_jobs").select("*").eq("store_id", storeId).order("created_at", { ascending: false }).limit(200)
    : supabase.from("pos_print_jobs").select("*").limit(0);
  const deviceConfigQuery = storeId
    ? supabase.from("pos_device_configs").select("*").eq("store_id", storeId).order("updated_at", { ascending: false }).limit(1)
    : supabase.from("pos_device_configs").select("*").limit(0);
  // 0027 pos_print_templates（店級模板新真源）：有記錄就夾落 payload，等收銀台 sync merge
  // 喺「server 較新」時採納（LWW）；冇 storeId / 未設定 → null，client 保留本機模板。
  const printTemplatesQuery = storeId
    ? supabase
        .from("pos_print_templates")
        .select("receipt, label, kitchen, kiosk, shift, shift_presets, updated_at")
        .eq("store_id", storeId)
        .maybeSingle()
    : Promise.resolve({ data: null, error: null });
  // 0028 pos_note_presets（店級備註真源）：同 printTemplates 一樣，有記錄就夾落 payload，
  // client 喺「server 較新」時採納；冇 storeId / 未設定 → null，client 保留本機備註。
  // 讀取集中喺 `@/lib/note-presets-server`：0034 未跑（42703）會自動降級讀舊欄位，
  // 唔會因為「折扣備註」呢條新欄拖冧既有三個備註清單。
  const notePresetsPromise: Promise<NotePresetsReadResult | null> = storeId
    ? readNotePresets(supabase, storeId)
    : Promise.resolve(null);

  const [{ data: queue }, { data: printJobs }, { data: deviceConfigs }, { data: printTemplatesRow }, notePresetsResult] =
    await Promise.all([queueQuery, printJobsQuery, deviceConfigQuery, printTemplatesQuery, notePresetsPromise]);

  const ordersInRange = await ordersInRangePromise;
  const orders = ordersInRange.error ? [] : ordersInRange.orders;

  const deviceConfigRow = deviceConfigs?.[0] ?? null;

  return jsonWithEgressLog(
    "pos/state",
    {
    ok: true,
    source: "supabase",
    orders: orders?.map(mapOrderRow) ?? [],
    queue:
      queue?.map((event) => ({
        id: event.id,
        type: event.type,
        entityId: event.entity_id,
        payload: event.payload,
        status: event.status,
        createdAt: event.created_at,
        // 🛡️ 跨店隔離：client loadRuntimeState 靠呢個欄 skip 外店事件（L3 第二道閘）。
        storeId: event.store_id ?? undefined,
      })) ?? [],
    printJobs:
      printJobs?.map((job) => ({
        id: job.id,
        orderId: job.order_id,
        orderNo: job.order_no ?? undefined,
        tableName: job.table_name ?? undefined,
        ticketType: job.ticket_type,
        printerGroup: job.printer_group,
        printerName: job.printer_name,
        // 2026-09-21 補：冇 `printerId` 令本機 backfill 落嚟嘅 job 冇打印機身分，
        // 「內容唯一鍵」只能退回 printerName 拼鍵 → 同新建 job（用 printerId）
        // 拼唔埋 → 跨終端去重失效（見 `@/lib/pos/print-dedupe`）。
        printerId: job.printer_id ?? undefined,
        // 內容唯一鍵（migration 未跑時 undefined，無害）：本機 job 帶返鍵，
        // `seenKeysFromJobs()` 就認得出「呢件事已經出過紙」。
        onceKey: job.once_key ?? undefined,
        items: Array.isArray(job.items) ? job.items : [],
        status: job.status,
        createdAt: job.created_at,
      })) ?? [],
    deviceConfig: deviceConfigRow
      ? normalizeDeviceConfig({
          deviceId: deviceConfigRow.device_id,
          terminalName: deviceConfigRow.terminal_name,
          storeId: deviceConfigRow.store_id,
          printers: Array.isArray(deviceConfigRow.printers) ? deviceConfigRow.printers : [],
          updatedAt: deviceConfigRow.updated_at,
        })
      : null,
    localSettings: normalizePosLocalSettings(deviceConfigRow?.local_settings ?? defaultPosLocalSettings),
    printTemplatesServer: printTemplatesRow
      ? {
          templates: normalizePrintTemplateSet({
            receipt: printTemplatesRow.receipt,
            label: printTemplatesRow.label,
            kitchen: printTemplatesRow.kitchen,
            kiosk: printTemplatesRow.kiosk,
            // 交班模板（2026-09-10，0030 migration）：舊 row 冇呢欄 → undefined →
            // normalize 會補出廠預設，唔會令 client 收到殘缺結構。
            shift: printTemplatesRow.shift,
          }),
          // 交班模板範本庫 + 上次套用 id。舊 row / 未跑 0030 → undefined → null，
          // client 見到 null 就保留本地範本（唔會清空）。
          shiftPresets: printTemplatesRow.shift_presets
            ? {
                presets: normalizeShiftTemplatePresets(
                  (printTemplatesRow.shift_presets as { presets?: unknown })?.presets,
                ),
                activeId:
                  typeof (printTemplatesRow.shift_presets as { activeId?: unknown })?.activeId === "string"
                    ? (printTemplatesRow.shift_presets as { activeId: string }).activeId
                    : DEFAULT_SHIFT_TEMPLATE_PRESET_ID,
              }
            : null,
          updatedAt: printTemplatesRow.updated_at ?? null,
        }
      : null,
    notePresetsServer:
      notePresetsResult && notePresetsResult.ok && notePresetsResult.found
        ? {
            presets: notePresetsResult.presets,
            updatedAt: notePresetsResult.updatedAt,
            // 0034 未跑 → false：client 見到就知「server 未有折扣備註欄」，
            // 只採納舊三個槽位，唔可以用空陣列覆蓋本機折扣備註。
            hasDiscountNoteColumn: notePresetsResult.hasDiscountColumn,
          }
        : null,
    },
    {
      // egress 審計維度：之後喺 Vercel log `grep '[egress]'` 加總就知邊條路徑食流量。
      mode: "full",
      orders: orders?.length ?? 0,
      queue: queue?.length ?? 0,
      skipQueue: skipQueue ? 1 : 0,
      printJobs: printJobs?.length ?? 0,
      limit,
      ip,
    },
  );
}
