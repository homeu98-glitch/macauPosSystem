/**
 * POS 客戶端 Realtime「連線目標」解析 + 一次性探測 —— **零依賴純模組**。
 *
 * 為何抽獨立檔（同 `self-order-notice.ts` 同一理由）：
 *   `supabase-client.ts` 一 import 就會拉起 `@supabase/supabase-js`，
 *   單元測試（`node --test`）唔想連帶載入成個 SDK。呢度只依賴 `fetch` / `setTimeout`
 *   兩個 runtime 內建，Node 22 同瀏覽器都行，所以可以直接測。
 *
 * 背景（2026-09-10 P0，詳見 `docs/reviews/qr-self-order-audit-2026-09-10.md` 附錄 B.6）：
 *   server 寫 `pos_orders` 用 `SUPABASE_URL`（POS 專案），但瀏覽器 Realtime 訂閱用
 *   `NEXT_PUBLIC_SUPABASE_URL`（Ledger 專案，冇 pos_orders）→ 訂單**永遠唔會即時推送**，
 *   而 Supabase **唔會報錯**（channel 照樣 SUBSCRIBED）→ 靜默失效。
 *   唯一可靠嘅判斷方法：直接問 PostgREST「呢個專案有冇 pos_orders」。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1) 連線目標解析
// ─────────────────────────────────────────────────────────────────────────────

/** 客戶端 POS Realtime 連線目標係邊個來源。 */
export type PosRealtimeSource = "pos" | "ledger-fallback";

export interface PosRealtimeConfig {
  url: string;
  anonKey: string;
  /** `pos` = 已設 POS 專用變數（正確）；`ledger-fallback` = 退回舊變數（**大概率訂錯專案**）。 */
  source: PosRealtimeSource;
}

/**
 * 純函式：由 env 決定客戶端 POS 連線目標。
 *
 * 優先次序：
 *   1. `NEXT_PUBLIC_POS_SUPABASE_URL` / `NEXT_PUBLIC_POS_SUPABASE_ANON_KEY`（POS 專案，正確）
 *   2. `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`（Ledger 專案，舊行為，只為兼容）
 */
export function resolvePosRealtimeConfig(
  env: Record<string, string | undefined>,
): PosRealtimeConfig | null {
  const posUrl = env.NEXT_PUBLIC_POS_SUPABASE_URL?.trim();
  const posAnon = env.NEXT_PUBLIC_POS_SUPABASE_ANON_KEY?.trim();
  if (posUrl && posAnon) return { url: posUrl, anonKey: posAnon, source: "pos" };

  const ledgerUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const ledgerAnon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (ledgerUrl && ledgerAnon) {
    return { url: ledgerUrl, anonKey: ledgerAnon, source: "ledger-fallback" };
  }

  return null;
}

/** 由 URL 抽 host；抽唔到就回原字串（唔會拋錯、唔會漏 key —— 佢只收 URL）。 */
export function safeHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 120);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) 一次性探測（唔係 polling）
// ─────────────────────────────────────────────────────────────────────────────

export type PosRealtimeProbeStatus =
  | "ok"
  /** 冇配置 / 配置唔齊（Realtime 唔會著）。 */
  | "unconfigured"
  /** PGRST205 / 404：專案冇 pos_orders → **訂錯專案**（頭號病因）。 */
  | "table_missing"
  /**
   * 401「Invalid API key」/「No API key found」：**key 本身唔啱**。
   *
   * ⚠️ 呢個一定要同 `unauthorized` 分開：PostgREST 未認證之前**唔會**查表，
   * 所以錯 key 時**判斷唔到**表存在與否 —— 唔可以講成「表存在但被拒」（會誤導排查方向）。
   */
  | "bad_key"
  /** 401 / 403 / 42501（key 有效）：anon 冇 select 權 → RLS 收得太緊或漏 grant。 */
  | "unauthorized"
  /** 網絡 / 其他 4xx-5xx。 */
  | "error";

export interface PosRealtimeProbe {
  status: PosRealtimeProbeStatus;
  source: PosRealtimeSource | null;
  /** 只顯示 host（例：`xxxx.supabase.co`），**唔會**帶出 anon key。 */
  host: string | null;
  detail?: string;
}

/** 探測結果 → 收銀員睇得明嘅一句話（純函式，可測）。 */
export function describePosRealtimeProbe(probe: PosRealtimeProbe): string {
  switch (probe.status) {
    case "ok":
      return "即時通知正常";
    case "unconfigured":
      return "未設定即時連線，訂單要重新載入先會出現";
    case "table_missing":
      return "即時連線指向嘅資料庫冇訂單表（設定指錯專案），訂單要重新載入先會出現";
    case "bad_key":
      return "即時連線嘅金鑰唔正確，訂單要重新載入先會出現";
    case "unauthorized":
      return "即時連線被資料庫拒絕（讀取權限不足），訂單要重新載入先會出現";
    default:
      return "即時連線連唔上，訂單要重新載入先會出現";
  }
}

/** 探測結果係咪代表「即時推送可用」。 */
export function isPosRealtimeHealthy(probe: PosRealtimeProbe | null): boolean {
  return probe?.status === "ok";
}

/**
 * PostgREST 回應係咪「key 唔啱」（未認證 → 查唔到表，唔可以推論表存在與否）。
 *
 * 實測（2026-09-11）：錯 anon key → 401 `{"message":"Invalid API key", ...}`；
 * 完全冇 key → 401 `{"message":"No API key found in request", ...}`。
 * 而「key 有效但 anon 冇 select」→ 400/401 帶 `42501` / `permission denied`。
 */
export function isBadApiKeyBody(body: string): boolean {
  return /invalid api key|no api key|invalid jwt|jwt expired|invalid signature/i.test(body);
}

/** 探測用嘅 REST URL（PostgREST 打一張表最輕嘅查詢：`select=id&limit=1`）。 */
export function buildPosOrdersProbeUrl(url: string): string {
  return `${url.replace(/\/+$/, "")}/rest/v1/pos_orders?select=id&limit=1`;
}

/**
 * 一次性探測「客戶端 Realtime 目標專案有冇 `pos_orders`」。
 *
 * - 唔會 throw（任何失敗都收成 `status: "error"`）。
 * - 只讀，唔會改任何資料。
 * - 用 `AbortController` + `setTimeout`（唔用 `AbortSignal.timeout`，因為舊 iPad Safari 未支援）。
 */
export async function probePosRealtimeTarget(
  config: PosRealtimeConfig | null,
  timeoutMs = 6000,
): Promise<PosRealtimeProbe> {
  if (!config) return { status: "unconfigured", source: null, host: null };

  const host = safeHost(config.url);
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(buildPosOrdersProbeUrl(config.url), {
      headers: { apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}` },
      signal: controller.signal,
      cache: "no-store",
    });
    if (response.ok) return { status: "ok", source: config.source, host };

    const body = await response.text().catch(() => "");
    const detail = body.slice(0, 180);
    if (response.status === 404 || body.includes("PGRST205")) {
      return { status: "table_missing", source: config.source, host, detail };
    }
    // ⚠️ 次序要緊：錯 key 時 PostgREST 未認證就回 401，**唔會**查到表 →
    // 一定要先判 bad_key，否則會誤報「表存在但被拒」，帶錯排查方向。
    if (isBadApiKeyBody(body)) {
      return { status: "bad_key", source: config.source, host, detail };
    }
    if (response.status === 401 || response.status === 403 || body.includes("42501")) {
      return { status: "unauthorized", source: config.source, host, detail };
    }
    return { status: "error", source: config.source, host, detail: `${response.status} ${detail}` };
  } catch (error) {
    return {
      status: "error",
      source: config.source,
      host,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    globalThis.clearTimeout(timer);
  }
}
