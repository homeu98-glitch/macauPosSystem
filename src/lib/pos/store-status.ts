/**
 * 「店內營業」開關（線下營業狀態）—— 真源 = POS DB `pos_store_status`（migration 0039）。
 *
 * ── 同「線上接單」係兩個獨立開關（🔴 唔可以撈埋）──────────────────────────
 * | 開關 | 真源 | 擋咩 |
 * |---|---|---|
 * | 線上接單（`merchant_enabled`） | **Ledger**（RPC ＋ 0036 鏡像） | 只擋會員通線上落單 |
 * | 店內營業（本檔 `isOpen`） | **POS DB `pos_store_status`** | 擋掃碼點餐（`/menu`、`/quick`）＋ kiosk（`/order`） |
 *
 * 兩者**單向連動**（2026-09-14 J 拍板）：關「店內營業」→ 前端順手暫停「線上接單」；
 * 但切換「線上接單」唔會影響「店內營業」，而且**重開**「店內營業」**唔會**自動開返
 * 「線上接單」（原本暫停可能係店主刻意決定）。
 *
 * ── 三個讀者，全部走同一支 /api/pos/store-status ────────────────────────
 * 1. **收銀機 pill**（`useStoreStatus` module store）—— 讀 + 寫（寫要 POS 憑證）
 * 2. **客人端入頁提示**（`useOrderingCore` 開頁讀一次）—— 只讀，匿名
 * 3. **server 硬閘**（`/api/pos/sync`）—— 權威，唔經本檔（直接讀 DB）
 *
 * ⚠️ 客人端**唔可以**因為讀唔到就當「已暫停」：離線 / 未跑 migration / 讀取失敗
 * 一律 fallback `true`（營業中），由 server 硬閘把守。反過來就會變成「一斷網全店停業」。
 *
 * ── 禁 polling ──────────────────────────────────────────────────────────
 * 收銀機側靠 Realtime（`useStoreStatus`）；客人端只喺**入頁**同**落單前**讀，
 * 冇 `setInterval`（全專案禁 polling，見 docs/52）。
 */

export type StoreStatusSource = "cache" | "server" | "realtime";

export type StoreStatus = {
  storeId: string;
  isOpen: boolean;
  updatedAt: string | null;
  /** `true` = 呢個值真係由 server 嚟；`false` = 讀唔到，用緊 fallback。 */
  fromServer: boolean;
};

/**
 * 未設定過 row → **營業中**。
 *
 * ⚠️ 呢個 default 唔可以改 false：舊店 / 未跑 0039 嘅店一上線就會全店
 * 掃碼 + kiosk 落唔到單 ＝ 誤停業。同 `auto_accept`（DEFAULT false）刻意相反。
 */
export const DEFAULT_STORE_OPEN = true;

/** 防禦式讀 boolean：型別唔啱（`"false"` / `0` / 缺欄）一律 fallback。 */
export function normalizeStoreOpen(value: unknown, fallback: boolean = DEFAULT_STORE_OPEN): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * 解析 `GET /api/pos/store-status` 嘅回應（**零依賴純函式**，`node --test` 覆蓋）。
 *
 * `fromServer` 只在「payload 真係帶 boolean `isOpen`」時為 true ——
 * 靠佢分清楚「server 話營業中」同「讀唔到所以當營業中」。
 */
export function readStoreOpenFromPayload(
  payload: unknown,
  fallback: boolean = DEFAULT_STORE_OPEN,
): { isOpen: boolean; updatedAt: string | null; fromServer: boolean } {
  if (typeof payload !== "object" || payload === null) {
    return { isOpen: fallback, updatedAt: null, fromServer: false };
  }
  const row = payload as Record<string, unknown>;
  if (row.ok === false) return { isOpen: fallback, updatedAt: null, fromServer: false };

  const hasBoolean = typeof row.isOpen === "boolean";
  return {
    isOpen: hasBoolean ? (row.isOpen as boolean) : fallback,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    fromServer: hasBoolean,
  };
}

/**
 * 讀營業狀態（客人端 / 收銀機共用）。
 *
 * 離線 / 失敗 / 未跑 migration → `fromServer: false` + 營業中，**唔會 throw**
 * （客人端唔可以因為讀設定失敗而入唔到餐牌；硬閘喺 server）。
 */
export async function fetchStoreStatus(
  storeId: string,
  opts?: { timeoutMs?: number },
): Promise<StoreStatus> {
  const base: StoreStatus = {
    storeId,
    isOpen: DEFAULT_STORE_OPEN,
    updatedAt: null,
    fromServer: false,
  };
  if (!storeId) return base;

  const timeoutMs = opts?.timeoutMs ?? 6000;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(`/api/pos/store-status?storeId=${encodeURIComponent(storeId)}`, {
      method: "GET",
      cache: "no-store",
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res.ok) return base;
    const payload = (await res.json()) as unknown;
    return { storeId, ...readStoreOpenFromPayload(payload) };
  } catch {
    // 離線 / 逾時：維持營業中（fail-open），由 server 硬閘把守
    return base;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 寫營業狀態（**只限收銀端**）。
 *
 * `headers` 係 caller 嘅責任，而且要用 `posDeviceAuthHeadersFresh()`
 * 先續期再取 header（token TTL 12h，過夜必爆）—— 同 `saveKioskSettings` 一致。
 *
 * 失敗會 **throw**：呢粒係開關，靜默失敗會令收銀以為關咗店其實冇關
 * （最壞情況：以為停業、實際照收單）。
 */
export async function saveStoreStatus(
  storeId: string,
  isOpen: boolean,
  headers: Record<string, string> = {},
): Promise<StoreStatus> {
  const res = await fetch("/api/pos/store-status", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ storeId, isOpen }),
  });
  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !payload || payload.ok === false) {
    const message = typeof payload?.error === "string" ? payload.error : "保存營業狀態失敗。";
    throw new Error(message);
  }
  const parsed = readStoreOpenFromPayload(payload, isOpen);
  return {
    storeId,
    isOpen: parsed.fromServer ? parsed.isOpen : isOpen,
    updatedAt: parsed.updatedAt,
    fromServer: parsed.fromServer,
  };
}
