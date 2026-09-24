import { NextResponse } from "next/server";

import { defaultPosLocalSettings } from "@/lib/mock-data";
import { jsonWithEgressLog } from "@/lib/egress-log-server";
import { readNotePresets, type NotePresetsReadResult } from "@/lib/note-presets-server";
import { mapOrderRow, POS_ORDER_DB_COLUMNS } from "@/lib/pos-order-row";
import { fetchOrdersInRange } from "@/lib/pos-orders-range";
import { isMissingColumnError } from "@/lib/supabase-errors";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { normalizeDeviceConfig, normalizePosLocalSettings, normalizePrintTemplateSet } from "@/lib/storage";
import {
  DEFAULT_SHIFT_TEMPLATE_PRESET_ID,
  normalizeShiftTemplatePresets,
} from "@/lib/escpos-template";
import { isIncrementalTruncated } from "@/lib/pos/state-sync-watermark";
import { printOnceScopeFromDbKey } from "@/lib/pos/print-dedupe";
import { cloudRowToPrintJobStatus } from "@/lib/pos/print-job-status";
import { isPosDeviceAuthRequired, readPosDeviceTokenFromRequest } from "@/lib/pos/pos-device-token";
import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";
import { readServerBuildId } from "@/lib/build-info";
import { touchPosSession } from "@/lib/pos/session-registry-server";
import {
  POS_BUILD_HEADER,
  POS_SESSION_CLOSED_HEADER,
  POS_SESSION_HEADER,
  SESSION_STATE_TOUCH_THROTTLE_MS,
  sanitizeBuildId,
  sanitizeSessionKey,
} from "@/lib/pos/session-record";

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

/** 訂單查詢嘅寬鬆結果形狀（supabase thenable await 完嘅 {data,error} 子集）。 */
type OrderQueryResult = {
  data: unknown;
  error: { code?: string | null; message?: string | null } | null;
};

/**
 * 42703 降級（2026-09-24 · 0057 `settled_at` 起嘅標準寫法）。
 *
 * 投影清單（`POS_ORDER_DB_COLUMNS`）帶咗 DB 未有嘅欄（migration 未跑）時，
 * PostgREST 回 42703。**唔可以將個錯漏出去**：
 *   · `legacyThrottled` 路：error → 回空 `orders` ⇒ 舊 bundle 孤兒對賬會將
 *     本機全部未結帳單移入隔離區（下面 `legacyThrottled` 段嘅災難級註釋）；
 *   · incremental 路：error → `truncated` ⇒ client 每 30s 清水位重拉全量（流量爆升）。
 *
 * 所以 server 側即刻用 `select("*")` 重試一次：42703 錯誤回應得 ~100 B，
 * 重試先係真正嘅數據。migration 跑咗之後呢段自然唔會再觸發（零成本）。
 * （`fetchOrdersInRange()` 嘅三腿路徑本身已有同款三級降級，呢度係兩條裸查詢嘅保險。）
 */
async function runOrderQueryWithColumnFallback(
  run: (columns: string) => PromiseLike<OrderQueryResult>,
): Promise<OrderQueryResult> {
  const first = await run(POS_ORDER_DB_COLUMNS.join(","));
  if (first.error && isMissingColumnError(first.error)) {
    console.warn('[pos/state] pos_orders 投影撞 42703（migration 未跑）→ 降級 select("*") 重試');
    return run("*");
  }
  return first;
}

/**
 * 「未結帳」狀態集合（同 `pos-order-filters.ts` 嘅 open 口徑一致）。
 *
 * 🔴 2026-09-22 修（實案：**雲端有未結帳單、收銀終端完全見唔到**）：
 *
 * 病徵：訂單19（A01，MOP 99）雲端 17:33:11 開單、`sent_to_kitchen`、至今未結帳；
 *   但收銀終端嘅桌台總覽喺 18:38 顯示 A01 係「訂單24 / 應收 46」——
 *   即係**部機根本唔知有 19 存在**，於是不但搵唔到（搜尋／列表都冇），
 *   更喺同一張 A01 上面再開一張新單（訂單24、訂單29），無人發現嗰 99 蚊未收。
 *
 * 成因：增量拉取（`since`）只回 `updated_at > since`。只要水位被推過（該機
 *   離線一輪、或第一批 flush 完成後水位已 commit），一張**未結帳**單就會
 *   永久跌出增量窗口 —— 之後每次拉都唔會再見到佢（`truncated` 亦唔會觸發，
 *   因為行數根本冇撞 limit）。Realtime 只推「變更」，補唔返歷史。
 *
 * 修法（**最終版，2026-09-22**）：舊 client 唯一會撞到嘅「假全集」係下面
 *   `legacyThrottled` 空骨架 —— 嗰條路改為**回本店全部未結帳單**（0–5 行）就足夠，
 *   因為舊 client 永遠唔會傳 `since`（增量路徑只服務新 bundle，而新 bundle 尊重
 *   `incremental` 旗標、唔會跑孤兒對賬）。
 *   ⇒ **增量之下唔再額外查詢**（每條增量拉取少一次 DB round trip）。
 *   終態單冇呢個問題：本機唔見都唔影響收錢，而且報表本身係純雲端、永不 merge。
 */
const OPEN_ORDER_STATUSES = ["draft", "sent_to_kitchen", "paid", "reopened"] as const;

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
  /**
   * 🔎 呼叫來源標記（2026-09-21 診斷用，**純記錄、零行為影響**）。
   *
   * ## 為咩需要
   *
   * 全量 state 拉取係本專案最大嘅 egress 來源（單次 424 KB）。2026-09-21 一度見到
   * **每 4.49 秒一次、連續 435 秒**嘅爆發，但**冇辦法由 log 分辨係邊個入口觸發**
   * —— `/api/pos/state` 有四個呼叫點（mount／`queue` 依賴效應／realtime 重連補拉／
   * 手動更新），佢哋喺 Supabase log 入面**長得一模一樣**。
   *
   * 所以 client 用請求標頭 `x-pos-state-src` 報上自己嘅身分，
   * 呢度只係**讀入嚟寫落 `[egress]` log**：
   *
   * ```
   * [egress] pos/state bytes=424181 mode=full src=queue-dep orders=200 …
   * ```
   *
   * ## 為何零行為影響
   *
   * · 標頭**唔參與任何查詢、授權或回應內容** —— 只做字串 slice 後入 log。
   * · 舊 client／其他 caller 唔傳 → 落 `-`，回應**逐位元不變**。
   * · 用標頭而唔用 query string，係避免污染 URL（URL 一變就可能繞過任何
   *   CDN／快取鍵，雖然本 route 係 `force-dynamic`，但唔想留一個隱性依賴）。
   * · `.slice(0, 24)` 防止有人用呢個欄位塞大字串去膨脹 log。
   */
  const stateSrc = (request.headers.get("x-pos-state-src") ?? "").trim().slice(0, 24) || "-";
  /**
   * 🔴 舊版 bundle 偵測（2026-09-21，**只加一條 log，唔改任何行為**）。
   *
   * ## 為何要
   *
   * 2026-09-21 實測：**一個開了一整日冇 reload 嘅 Mac Safari 分頁**，
   * 仍然跑住 17:18 之前嘅舊 JS（唔識傳 `skipQueue=1`），結果
   * **26 分鐘拉 147 次全量 state、每次 846 KB（`queue=300` 多咗 ≈500 KB）
   * ⇒ 122 MB / 26 分鐘 ≈ 650 MB/小時**，佔該窗口全部 egress **96.6%**。
   * 而同一部機另一個新分頁（有 `skipQueue=1`）29.6 分鐘只拉 **1 次、90 KB**。
   *
   * 呢種「舊分頁靜靜燒流量」**唔會報錯、唔會 crash**，只可以由 log 反推
   * —— 所以索性令系統自己講出嚟。
   *
   * ## 判準（要精準，唔可以誤報）
   *
   * `skipQueue` 由 client 喺 `isOutboxV2Enabled()` 為 true 時才傳（預設 true）
   * ⇒ **全新 bundle 嘅全量拉取一定有 `skipQueue`**。
   * 而 `ordersOnly=1` 嘅呼叫（報表 / 交班 / 對賬守護 / 本機訂單面板）**本身唔傳**
   * ⇒ 一定要排除，否則每次開報表都出假警報。
   *
   * 所以：**「非 ordersOnly 且冇 skipQueue」＝ 舊版全量拉取**（唯一呼叫者係 `pos-app`）。
   * 實際判斷寫喺下面 `const skipQueue = …` 之後（避免重複 parse 同一個 query param）。
   *
   * ## 為何唔會嘈
   *
   * 用 `rateLimit(key, 1, 60_000)` ⇒ **每個 IP 每分鐘最多一條**。
   * 舊 client 每分鐘會打 ~13 次，但 log 只出 1 條。
   *
   * ## 為何零功能影響
   *
   * 只係 `console.warn` ＋ 多一個 egress log 維度（`legacy=1`）；
   * 唔改查詢、唔改授權、唔改回應內容。
   * 要還原：刪走下面嗰段偵測（其餘不受影響）。
   */
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

  // ── 工作階段續期（2026-09-22，**零新增請求**）────────────────────────────
  //
  // 背景：`pos_sessions`（migration 0047）要知「邊個分頁仲活住」。收銀機開住但冇人
  // 掂嘅時段，唯一仲會出聲嘅就係呢支 state —— 所以喺呢度順手續期。
  //
  // 三個刻意的限制：
  //   · **只續期、唔建立**（`allowCreate: false`）⇒ 保持「GET 唔創造狀態」嘅語義。
  //     row 由 `/api/ledger/login`（權威）或 `POST /api/pos/sync` 建立。
  //   · **5 分鐘節流**（＝同一支 API 嘅輪詢節奏）：一有上報就一定夠新鮮，
  //     而成本係每部機 12 次/小時嘅單行 UPDATE。
  //   · 舊 client 唔傳 `x-pos-session` ⇒ **完全唔查、完全唔寫**，行為逐位元不變。
  //
  // ⚠️ 唔可以因為呢段而阻擋任何讀取：`touchPosSession()` 永遠唔 throw，
  //    失敗（未跑 migration 等）只會回 `found: false`。
  const sessionKey = sanitizeSessionKey(request.headers.get(POS_SESSION_HEADER));
  const sessionTouch =
    sessionKey && storeId
      ? await touchPosSession({
          storeId,
          sessionKey,
          buildId: sanitizeBuildId(request.headers.get(POS_BUILD_HEADER)),
          account: deviceClaims?.account ?? null,
          role: deviceClaims?.role ?? null,
          ip,
          userAgent: request.headers.get("user-agent"),
          throttleMs: SESSION_STATE_TOUCH_THROTTLE_MS,
          allowCreate: false,
        })
      : null;
  /**
   * 回應標頭：`x-pos-session-closed: 1` ＝ 呢個分頁已被管理員強制關閉。
   *
   * POS 端見到就出橫幅 + 停輪詢（**唔會自動 reload** —— 結帳中途 reload 會出事）。
   * 呢個就係「軟踢」嘅回傳路徑：server 唔可能關掉別人嘅分頁，只可以通知佢。
   */
  const sessionClosed = Boolean(sessionTouch?.revokedAt);
  const withSessionHeaders = <T extends NextResponse>(response: T): T => {
    if (sessionClosed) response.headers.set(POS_SESSION_CLOSED_HEADER, "1");
    return response;
  };

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

  // 🔴 舊版 bundle 偵測（2026-09-21）——**只加一條 log，唔改任何行為**。
  // 完整說明見上面 `stateSrc` 之前嘅大段註釋。判準：非 `ordersOnly` 且冇 `skipQueue`。
  // 只為咗令「有部機靜靜跑住舊分頁、每分鐘燒 ~650 MB/小時 egress」呢種事**自己講出嚟**。
  const isLegacyFullState = !ordersOnly && !skipQueue;
  if (isLegacyFullState && rateLimit(`pos-state-legacy:${ip}`, 1, 60_000)) {
    console.warn(
      `[pos/state] 🔴 偵測到疑似舊版 bundle 嘅全量拉取（冇 skipQueue）ip=${ip} —— ` +
        `每次會多拉約 500 KB queue；請該裝置**重新載入頁面**。`,
    );
  }

  /**
   * 🩹 2026-09-22 **P0 止血**：舊版全量拉取一律**唔回 queue**（＝ `limit(0)`）。
   *
   * ## 為何
   *
   * 2026-09-22 實測：一部跑舊 bundle 嘅分頁 **每 4.6 秒**拉一次，
   * `bytes=903 KB`（`orders=200 queue=300 printJobs=200`）⇒ **690 MB/小時**。
   * 而新 bundle 同樣係全量，只係`queue=0`，bytes = **412 KB**
   * ⇒ 兩者相減，**queue 一條就佔 502 KB（56%）**。
   *
   * ## 為何安全（唔會令舊分頁壞）
   *
   * · client 側嘅 merge 係**由本地為底再加上 server 事件**
   *   （`pos-app.tsx`：`for (const e of payload.queue) {...}` 之後
   *   `for (const e of localQueue) if (!seen.has(e.id)) mergedQueue.push(e)`）
   *   ⇒ `payload.queue = []` 嘅結果係「**完整保留本地 queue**」，唔會清走任何未同步事件。
   * · v2 outbox 之下 client 本來就唔 merge server queue（`skipQueue=1` 同呢個一模一樣）。
   * · 舊分頁失去嘅只係「其他裝置嘅 queue 事件」呢個**次要**來源
   *   （訂單／打印任務仍然照拉，兩者才是應用層真源）。
   *
   * ## 回滾
   *
   * 刪走 `legacyQueueSuppressed` 呢個條件即可（`queueQuery` 一行）。
   */
  const legacyQueueSuppressed = isLegacyFullState;

  /**
   * 🩹🩹 2026-09-22 **P0b 節流**（第二次覆核後加，比 P0 更重要）。
   *
   * ## 實測（2026-09-22 17:30 覆核，14:05 部署 P0 之後）
   *
   * P0 成功把舊分頁每次由 **843 KB → 404 KB（−52%）**，但——
   * 🔴 **拉取頻率完全冇變**：仍係 **1.79 次/分鐘（約每 33 秒）**，
   * 即 **43.5 MB/小時**，佔該時段全部 egress **51%**。
   * 原因：舊 JS 冇輪詢閘（2026-09-21 修好嘅自激迴圈只喺新 bundle 生效），
   * 所以「減 bytes」只係一半答案，**必須同時絞住頻率**。
   *
   * ## 做法：同一部機 90 秒內再次做 legacy 全量拉取 → 回**空骨架**
   *
   * 空骨架對 client 係 **no-op**（實測 merge 語義）：
   *   · `orders: []` → `mergeOrderLists(local, current, [])` ＝ 不變；
   *   · `queue: []` → client 保留本地 queue（見 `pos-app` 嘅 merge 迴圈）；
   *   · `printJobs: []` → `persistPrintJobs([])` 早退 ＝ 不變；
   *   · `localSettings / deviceConfig / 模板 / 備註: null` → 全部有 `if (…)` 守門，跳過。
   *
   * 🔴🔴 **一定要帶 `incremental: true`**：否則客戶端會以為「雲端真係冇呢啲單」，
   * 而**孤兒單對賬會把全店未變更過嘅單一次過隔離**（收銀枱面清空）。
   * 呢個正係 `state-incremental-contract.test.ts` 守住嗰條鐵律。
   *
   * ## 為何 key 用 `ip + user-agent` 而唔係淨 IP
   *
   * 店內多部裝置通常共用同一個對外 IP（NAT）⇒ 淨用 IP 會誤鎖新版裝置。
   * 加上 UA 之後，同一部機／同一個瀏覽器才互相節流。
   * （新 bundle 唔受影響：佢傳 `skipQueue=1` ⇒ `isLegacyFullState` 為 false。）
   *
   * ## 回滾
   *
   * 刪走 `legacyThrottled` 嘅判斷（或把 `LEGACY_FULL_MIN_GAP_MS` 設成 0）。
   */
  const LEGACY_FULL_MIN_GAP_MS = 90_000;
  const legacyThrottled =
    legacyQueueSuppressed &&
    // 🔴 一定要有 storeId：冇 storeId 就砌唔出「安全骨架」（見下面 legacyThrottled 分支），
    //    寧願唔節流都唔可以回一個會被舊 client 當成「雲端冇單」嘅回應。
    Boolean(storeId) &&
    !rateLimit(
      `pos-state-legacy-pull:${ip}:${(request.headers.get("user-agent") ?? "").slice(0, 40)}`,
      1,
      LEGACY_FULL_MIN_GAP_MS,
    );

  /**
   * 🆕 2026-09-22 **P1 增量拉取**：`since=<ISO>` ⇒ 只回「變更過」嘅差量。
   *
   * ## 為何
   *
   * 全量拉取每次 **412 KB**（新 bundle）—— 但 POS 本身已經有齊本機 orders / printJobs，
   * 開頁真正需要嘅只係差量。決策（幾時可以信 `since`）收喺**純函式**
   * `@/lib/pos/state-sync-watermark`（12 條單測），呢度只負責執行查詢。
   *
   * ## 安全設計（三條）
   *
   * ① **`ordersOnly` 一律唔做增量**（報表／交班／對賬守護要完整區間，唔可以只回差量）。
   * ② 增量查詢係**獨立一條腿**（單表 `updated_at > since`）——
   *    唔會經 `fetchOrdersInRange()` 嘅三腿 OR 邏輯，避免兩套口徑互相污染。
   * ③ 撞到 `limit` ⇒ 回 `truncated: true`，client 會即刻清水位（下次走全量）。
   *    唔可以靜默截斷 —— 漏單比多拉幾 KB 嚴重得多。
   *
   * ## 新舊並存
   *
   * 唔傳 `since` ＝ **完全等於**未加呢個功能之前嘅行為（舊 client 零影響）。
   */
  const sinceRaw = searchParams.get("since")?.trim() || null;
  const since = sinceRaw ? toUtcIso(sinceRaw) : null;
  /**
   * 🩹 2026-09-22 覆核修（**我上一版嘅 bug**）：`ordersOnly` 之下**有 `since` 都要做增量**。
   *
   * 原本寫 `Boolean(since) && !ordersOnly`，但訂單頁 backfill 正正係
   * `ordersOnly=1&since=…`（`local-orders-panel.tsx`，P3 改動）⇒ `since` 被無視，
   * **P3 完全失效**：實測仍然每次拉 200 張完整訂單 = **289 KB × 0.37 次/分 ≈ 6.4 MB/小時**。
   *
   * 安全論證：**只有主動傳 `since` 嘅 caller 才受影響**。
   * 報表／交班／對賬守護一律唔傳 `since`（佢哋要完整區間）⇒ 行為逐位元不變。
   * 「完整區間」嘅語義由「唔傳 since」保證，而唔係由 `ordersOnly` 保證。
   */
  const incremental = Boolean(since);

  /**
   * 🩹 舊分頁節流（P0b）命中 → 回**空骨架**，即刻結束。
   *
   * 空骨架 ＝ 對 client no-op（見 `legacyThrottled` 嘅長註釋），
   * 所以舊分頁照樣運作（Realtime 推送嘅新單仍然會到），只係唔會每 33 秒重拉全世界。
   */
  // ⚠️ 一定要帶 `&& supabase`：呢個分支排喺下面 `if (!supabase)`（mock 模式）**之前**，
  //    而下面要真查 DB。冇 supabase 就唔節流、直接交返 mock 分支（唔可以 `supabase.from` 撞 null）。
  if (legacyThrottled && supabase) {
    /**
     * 🔴🔴 2026-09-22 **修（實案：下單 iPad「未結帳單又不見了」）** —— 原本回 `orders: []`。
     *
     * 原設計嘅安全論證係：「帶咗 `incremental: true`，client 就唔會跑孤兒對賬」。
     * ⚠️ 但呢條路**只會發生喺舊 bundle**（新 bundle 傳 `skipQueue=1` ⇒ `isLegacyFullState` 為 false），
     * 而**舊 bundle 根本唔識 `incremental` 呢個欄位**（今日 P1 才加）⇒ 佢照跑孤兒對賬，
     * 而孤兒判準係「雲端 `payload.orders` 冇呢張單」（`computeOrphanLocalOrders`）。
     * ⇒ 空陣列等於「雲端一張單都冇」⇒ **本機所有未結帳單一次過移入隔離區**，
     *   收銀台列表即刻清空（呢個正是 `pos-app.tsx` 1504 行註釋自己寫嘅「災難級誤判」）。
     * 一個契約**唔可以要求舊 client 遵守一個佢唔認識嘅新欄位**。
     *
     * 修法：唔回空陣列，改回「**本店全部未結帳單**」（通常 0–5 行 ≈ 1–3 KB）——
     *   · 舊 client 嘅孤兒判準即刻變 no-op（本機未結帳單全部喺 server 名單內）；
     *   · 終態單照樣唔回（舊 client 嘅孤兒邏輯本身唔理終態單）；
     *   · 節流目標（唔回 300 條 queue ＋ 200 張單 ≈ 500 KB）**完全保留**。
     */
    const openRes = await runOrderQueryWithColumnFallback((columns) =>
      supabase
        .from("pos_orders")
        .select(columns)
        .eq("store_id", storeId as string)
        .in("status", [...OPEN_ORDER_STATUSES])
        .order("created_at", { ascending: false })
        .limit(100),
    );
    const throttleOrders = (openRes.error ? [] : (openRes.data ?? [])) as unknown as Parameters<
      typeof mapOrderRow
    >[0][];
    return withSessionHeaders(
      jsonWithEgressLog(
        "pos/state",
        {
          ok: true,
          source: "supabase",
          orders: throttleOrders.map(mapOrderRow),
          queue: [],
          printJobs: [],
          deviceConfig: null,
          localSettings: null,
          printTemplatesServer: null,
          notePresetsServer: null,
          // 🔴 新 client 靠呢個 flag 停用孤兒對賬；舊 client 唔識，所以上面仍要回未結帳單。
          incremental: true,
          legacyThrottled: true,
        },
        {
          mode: "legacyThrottled",
          orders: throttleOrders.length,
          queue: 0,
          printJobs: 0,
          skipQueue: 1,
          legacy: 1,
          legacyQueueOff: 1,
          incr: 1,
          limit,
          ip,
          src: stateSrc,
        },
        { storeId },
      ),
    );
  }

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

  // 訂單查詢即刻啟動（唔等下面 queue/printJobs/deviceConfig），保持並行度。
  // · **增量**（有 `since`）→ 單腿 `updated_at > since`（1 條 query；最省）
  // · 其餘（全量／報表／守護）→ 原本三腿區間查詢（語義完全不變）
  //
  // ⚠️ 兩條路刻意**唔互通**：`fetchOrdersInRange()` 係「區間 OR 三腿」，
  // 增量係「單調水位」——撈埋一齊會產生「唔知邊條條件贏」嘅隱性行為。
  const incrementalOrdersPromise =
    incremental && storeId
      ? runOrderQueryWithColumnFallback((columns) =>
          supabase
            .from("pos_orders")
            .select(columns)
            .eq("store_id", storeId)
            .gt("updated_at", since as string)
            .order("updated_at", { ascending: false })
            .limit(limit),
        )
      : null;
  const ordersInRangePromise = incrementalOrdersPromise
    ? null
    : fetchOrdersInRange({
        supabase,
        storeId,
        start: rangeStart,
        end: rangeEnd,
        limit,
        offset,
        // undefined = 用預設投影（＝ mapper 會讀嘅全部欄，語義等同 select("*")）。
        columns: ordersColumns,
      });

  /**
   * 增量之下嘅「未結帳單兜底腿」（見 `OPEN_ORDER_STATUSES` 嘅完整病歷）。
   *
   * 只喺 incremental 時開（全量／報表區間本身已經係完整超集，唔使多一條 query）。
   * 上限 100：未結帳單係「枱面／外賣尚在進行」嘅工作清單，正常單位數；
   * 真係撞到 100 亦只會「少兜底」，唔會令請求失敗（唔參與 truncated 判定，
   * 免得 false positive 令 client 每次都被迫走全量）。
   */
  /**
   * 🚫 2026-09-22 **已移除「增量之下嘅未結帳單兜底腿」**（原本每條增量拉取多打一條查詢）。
   *
   * 移除理由（兩點，都係實測）：
   *   ① **對目標客戶冇用**：`incremental` 只可能出現喺**新 bundle** 嘅請求
   *      （`since` 係 P1 新增參數；舊 bundle 永遠唔會傳）——但需要兜底嘅**正正係舊 bundle**
   *      （佢唔識 `incremental`，會誤跑孤兒對賬）。舊 bundle 走嘅係下面
   *      `legacyThrottled` 骨架路徑，嗰邊已經改為**回未結帳單**（真正有用嘅修法）。
   *   ② **新 bundle 唔需要**：新 bundle 尊重 `incremental` 旗標、唔會跑孤兒對賬；
   *      加上 client 側水位已收緊為「只喺真係收到 `orders` 陣列時才推進」（見 `pos-app.tsx`），
   *      增量窗口唔會再被錯誤跳過。
   *
   * ⇒ 淨影響：**每條增量拉取少一次 DB 查詢**（對商家「唔可以增加任何流量」嘅要求係負數，即減）。
   */

  // 報表分頁／訂單頁 backfill 只拉訂單，跳過其餘 table。
  if (ordersOnly && incrementalOrdersPromise) {
    // 🩹 增量（訂單頁 backfill 傳 `since`）→ 單腿 `updated_at > since`，通常 0–3 行。
    const { data, error } = await incrementalOrdersPromise;
    const rows = error ? [] : ((data ?? []) as unknown as OrderRow[]);
    const truncated = Boolean(error) || isIncrementalTruncated(rows.length, limit);
    return withSessionHeaders(
      jsonWithEgressLog(
        "pos/state",
        {
          ok: true,
          source: "supabase",
          orders: rows.map(mapOrderRow),
          incremental: true,
          ...(truncated ? { truncated: true } : {}),
        },
        {
          mode: "ordersOnly",
          orders: rows.length,
          limit,
          offset,
          columns: ordersColumns ?? "default",
          start: rangeStartRaw ?? "-",
          end: rangeEndRaw ?? "-",
          incr: 1,
          truncated: truncated ? 1 : 0,
          // 🔎 2026-09-22 覆核加：ordersOnly 原本冇記 ip／src ⇒ 38 MB 無法歸因。
          ip,
          src: stateSrc,
        },
        { storeId },
      ),
    );
  }
  if (ordersOnly && ordersInRangePromise) {
    const ordersInRange = await ordersInRangePromise;
    const orders = ordersInRange.error ? [] : ordersInRange.orders.map(mapOrderRow);
    return withSessionHeaders(
      jsonWithEgressLog(
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
          incr: 0,
          // 🔎 見上：冇 ip／src 就追唔到「邊條路徑／邊部機」食咗流量。
          ip,
          src: stateSrc,
        },
        { storeId },
      ),
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
  //
  // 2026-09-22 **P0**：`legacyQueueSuppressed`（舊版全量拉取）同 `incremental`
  // 亦一律 limit(0) —— 前者每次省 502 KB（見上面註釋），後者本來就只需要差量。
  const queueQuery = !skipQueue && !legacyQueueSuppressed && !incremental && storeId
    ? supabase.from("pos_queue_events").select("*").eq("store_id", storeId).order("created_at", { ascending: false }).limit(300)
    : supabase.from("pos_queue_events").select("*").limit(0);
  // 🛡️ 加固（db review §4.1 #3）：print jobs 同 device config 一律按 store 過濾。
  // 冇 storeId（未登入又冇 kiosk 綁定）→ limit(0) 返空，寧可無 print job / 無遠端 config，
  // 都唔好派發別店嘅打印任務或 terminal 設定（fail-safe；歷史行 store_id IS NULL 天然被 eq 排除）。
  //
  // 2026-09-22 P1：增量之下只回 `created_at > since` 嘅 print job ——
  // 跨終端「內容唯一鍵」去重（`print-dedupe.ts`）只需要**新出現**嗰批，
  // 舊嘅本機已經有（merge 係由本地為底）。
  const printJobsBase = supabase.from("pos_print_jobs").select("*").eq("store_id", storeId);
  const printJobsQuery = storeId
    ? (incremental
        ? printJobsBase.gt("created_at", since as string)
        : printJobsBase
      )
        .order("created_at", { ascending: false })
        .limit(incremental ? Math.min(limit, 200) : 200)
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

  // 增量：單腿查詢結果；全量：原本三腿結果。兩者都係**未 map** 嘅 DB row。
  // 型別用 `mapOrderRow` 嘅入參（＝映射真源），避免 supabase 泛型推導出 error union。
  type OrderRow = Parameters<typeof mapOrderRow>[0];
  const incrementalResult = incrementalOrdersPromise ? await incrementalOrdersPromise : null;
  const ordersInRange = ordersInRangePromise ? await ordersInRangePromise : null;
  const orders: OrderRow[] = incrementalResult
    ? incrementalResult.error
      ? []
      : ((incrementalResult.data ?? []) as unknown as OrderRow[])
    : ordersInRange && !ordersInRange.error
      ? ordersInRange.orders
      : [];

  // 🚫 2026-09-22：原本呢度會喺增量之下多拉一條「未結帳單兜底腿」再合併 —— 已移除，
  //    理由見上面（對舊 bundle 冇用、新 bundle 唔需要、而且係每條增量拉取多一次查詢）。
  //    ⇒ 增量之下保持**單腿零額外查詢**。

  /**
   * 增量結果係咪**唔完整**（查詢失敗／撞到 `limit`）⇒ client 要清水位、下次走全量。
   *
   * 🔴 唔可以靜默截斷：`updated_at > since` 撞 200 張，代表本地會永久缺嗰批單，
   * 而且下一次（水位已更新）更加拉唔返 —— 「漏單」比多拉幾十 KB 嚴重得多。
   */
  const incrementalPrintJobLimit = incremental ? Math.min(limit, 200) : 200;
  const incrementalTruncated = incremental
    ? Boolean(incrementalResult?.error) ||
      isIncrementalTruncated(orders.length, limit) ||
      isIncrementalTruncated(printJobs?.length ?? 0, incrementalPrintJobLimit)
    : false;

  const deviceConfigRow = deviceConfigs?.[0] ?? null;

  const response = withSessionHeaders(
    jsonWithEgressLog(
      "pos/state",
    {
    ok: true,
    source: "supabase",
    orders: orders?.map(mapOrderRow) ?? [],
    /**
     * 🆕 2026-09-22 P1：今次係增量拉取（只回差量）。
     * 舊 client 唔識呢個欄 → 完全忽略；新 client 見到就**唔可以**跑孤兒單對賬
     * （佢嘅判準係「雲端冇呢張單」，增量回傳只係子集 —— 見 state-sync-watermark.ts）。
     */
    ...(incremental ? { incremental: true } : {}),
    /** 🆕 增量結果唔完整（撞 limit／查詢失敗）⇒ client 要清水位並即刻重拉全量。 */
    ...(incrementalTruncated ? { truncated: true } : {}),
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
        //
        // 🔴 2026-09-24：由呢日起 server 寫入 DB 嘅係 **composed 鍵**
        // （`orderId|onceScope|printerId`，見 `printOnceDbKey`）。返落本機之前一定要
        // **還原做原始 onceKey**，否則本機 `printOnceKey()` 會再 compose 一次 → 永遠對唔上
        // → 換機／重載之後跨終端去重失效。舊格式（raw `receipt:0`）原樣返回 ⇒ 零迴歸。
        onceKey: printOnceScopeFromDbKey(job.once_key, job.order_id, job.printer_id),
        items: Array.isArray(job.items) ? job.items : [],
        // 🔴 2026-09-24：經白名單轉換，唔可以裸透傳 —— 雲端 `printing`（認領未回報）
        // 過渡態若原樣落到本機，會被 `normalizePrintJobStatus()` 標成「狀態欄位異常」失敗。
        status: cloudRowToPrintJobStatus(job.status),
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
      // 🔴 舊版 bundle 全量拉取（無 skipQueue）＝ 每次多約 500 KB。見 `isLegacyFullState`。
      legacy: isLegacyFullState ? 1 : 0,
      // 🆕 2026-09-22 P0：舊版拉取已被強制 `queue=0`（止血，每次省 ~502 KB）。
      legacyQueueOff: legacyQueueSuppressed ? 1 : 0,
      // 🆕 2026-09-22 P1：增量拉取（`since`）—— 呢個係「幾時傳 since」嘅診斷依據。
      incr: incremental ? 1 : 0,
      since: sinceRaw ?? "-",
      truncated: incrementalTruncated ? 1 : 0,
      printJobs: printJobs?.length ?? 0,
      limit,
      ip,
      // 🔎 呼叫來源（mount / queue-dep / resubscribe / manual / -）；見 `stateSrc` 嘅說明。
      src: stateSrc,
    },
    // 🆕 2026-09-22：記入 `pos_egress_daily`（admin「雲端用量」頁按店統計）。
    // 只係量度，唔改回應內容；migration 未跑會自動停用。
    { storeId },
    ),
  );

  /**
   * 🔎 建置識別碼（2026-09-22）—— 畀設置頁顯示「線上最新部署」用。
   *
   * 點解要有：設置頁會顯示**客戶端內聯**嘅版本（＝呢部機跑緊嘅 JS）。
   * 兩者一對照就知道**呢個分頁有冇過期** —— 呢個正是
   * 「有商家長期掛住舊版、靜靜燒 egress」嘅客戶端對應（server log 側係 `legacy=1`）。
   *
   * ⚠️ 純**附加**回應標頭：唔改 body、唔改 status、唔加查詢，舊 client 完全唔理。
   */
  response.headers.set("x-pos-build", readServerBuildId());
  /**
   * 🩹 `x-pos-legacy-pull: 1` ＝ 呢個請求係舊版全量拉取，server 已經**強制 `queue=0`**。
   *
   * 純診斷用：舊分頁跑住舊 JS，唯一可以令佢停嘅方法係「重新載入頁面」
   * （收銀台已經有「版本過期」橫幅，見 `build-stale-banner.tsx`）。
   * 標頭本身唔改任何行為，只令將來的排查唔需要再推斷。
   */
  if (legacyQueueSuppressed) response.headers.set("x-pos-legacy-pull", "1");
  return response;
}
