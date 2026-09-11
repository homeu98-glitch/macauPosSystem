import { NextResponse } from "next/server";

import { defaultPosLocalSettings } from "@/lib/mock-data";
import { readNotePresets, type NotePresetsReadResult } from "@/lib/note-presets-server";
import { mapOrderRow } from "@/lib/pos-order-row";
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

  // 報表區間過濾：只回傳 created_at **或** updated_at 落在 [start, end] 內嘅訂單（OR 語義）。
  // OR 係 client 端 orderMatchesReportRange（`updatedAt || createdAt` 計數口徑）嘅超集，
  // 涵蓋「區間內開單」同「區間內結帳/更新」兩種情況，亦涵蓋 NULL updated_at 嘅 legacy row。
  // 問題 6（2026-09-06 修）：
  // - start / end 一律轉 UTC ISO（`...Z`）——避開 PostgREST 對 `+08:00` offset 值嘅解析歧義。
  // - 過濾改用 fetchOrdersInRange() 兩腿合併（見 src/lib/pos-orders-range.ts），
  //   唔再用 `.or()` nested 語法（2026-09-04 引入，無長期生產驗證），
  //   亦唔會好似中間版本嘅 AND chain 咁漏「昨日開單、今日結帳」嘅單。
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
  });

  // 報表分頁只拉訂單，跳過其餘 table。
  if (ordersOnly) {
    const ordersInRange = await ordersInRangePromise;
    return NextResponse.json({
      ok: true,
      source: "supabase",
      orders: ordersInRange.error ? [] : ordersInRange.orders.map(mapOrderRow),
    });
  }

  // 🛡️ 跨店隔離 L2（0022 migration，2026-09-06 修）：queue 一律按 store 過濾。
  // 以前呢度完全冇過濾 → 全店最新 300 條事件派發畀任何 client，loadRuntimeState()
  // merge 入本地 queue 後，flush 用當前登入 merchantId 蓋章推上雲 —— 跨店串號嘅
  // 源頭之一。冇 storeId（未登入又冇 kiosk 綁定）→ limit(0) 返空，寧願冇 queue
  // 都唔好派發其他店嘅事件（fail-safe）。歷史行 store_id IS NULL 天然被 eq 排除。
  const queueQuery = storeId
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

  return NextResponse.json({
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
  });
}
