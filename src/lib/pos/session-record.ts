/**
 * 《POS 工作階段》純邏輯（2026-09-22）—— 門檻、分類、分組、KPI。
 *
 * ## 為何要一個獨立模組
 *
 * admin 頁要判斷「邊個工作階段係使用中／閒置／已離線／版本落後」，
 * 而**同一個判斷**喺三處要用到（admin API 回狀態、admin 頁顯示、之後可能嘅清理 cron）。
 * 判斷寫喺 route 或 component 入面就會各自漂移 —— 呢個專案已經中過好幾次
 * （時間口徑漂移 ⇒ 同一筆錢計兩次）。所以門檻同分類**只有一份**。
 *
 * ## 為何零 import
 *
 * `npm test` ＝ `node --test`（唔行 bundler、唔認 `@/` 別名、唔支援 `.tsx`）
 * ⇒ 可測模組一律唔准 import。執行層（讀 Supabase／讀 sessionStorage）另開檔案。
 *
 * ## 🔴 門檻為何係 6 分鐘而唔係 30 秒
 *
 * 打印中繼機嘅「在線」標準係 30 秒（`last_seen_at`），但 **POS 網頁唔可以照抄**：
 * 本專案有《輪詢閘》（`poll-gate.ts`），Realtime 通嘅時候**最長 5 分鐘唔會出聲**
 * （`POLL_INTERVAL_PUSHED_MS`）。如果門檻短過 5 分鐘，一部**健康但閒置**嘅收銀機
 * 會被標成「已離線」⇒ 商家見到假警報 ⇒ 呢個頁面即刻失去可信度。
 * ⇒ 門檻 ＝ 輪詢閘上限（5 分鐘）＋ 1 分鐘餘量 ＝ **6 分鐘**。
 *
 * ⚠️ 將來改 `poll-gate.ts` 嘅 `POLL_INTERVAL_PUSHED_MS`，**一定要一齊改呢度**
 * （`session-record.test.ts` 有守衛測試釘住呢個關係）。
 */

/* ────────────────────────────────────────────────────────────────────────────
 * 標頭契約（client ↔ server）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 工作階段識別碼（client → server）。值係 client 用 `sessionStorage` 產生嘅 key。
 *
 * 🔴 一定要 `sessionStorage`：`localStorage` 係**同源共用**，同一部機開兩個分頁
 * 會讀到同一個 key ⇒ 撞成同一個工作階段 ⇒ **永遠偵測唔到「多開」**，
 * 而「多開」正正係本功能要解決嘅問題。
 */
export const POS_SESSION_HEADER = "x-pos-session";

/**
 * **請求**標頭：呢個分頁實際跑緊嘅建置識別碼（`NEXT_PUBLIC_BUILD_ID`）。
 *
 * ⚠️ 同 `/api/pos/state` 嘅**回應**標頭 `x-pos-build`（＝線上最新）同名但方向相反 ——
 * 刻意用同一個名，令 log／文件唔會出現兩套叫法。server 讀請求標頭、
 * admin 頁對照 server 端嘅 `readServerBuildId()`。
 */
export const POS_BUILD_HEADER = "x-pos-build";

/**
 * **回應**標頭：`1` ＝ 呢個工作階段已被管理員強制關閉。
 *
 * POS 端見到就：① 出橫幅 ② 停輪詢 ③ **唔自動 reload**（結帳中途 reload 會出事）。
 */
export const POS_SESSION_CLOSED_HEADER = "x-pos-session-closed";

/* ────────────────────────────────────────────────────────────────────────────
 * 門檻
 * ──────────────────────────────────────────────────────────────────────────── */

/** 最後上報 ≤ 此值 ⇒ **使用中**。＝ 輪詢閘上限（5 分鐘）＋ 1 分鐘餘量。 */
export const SESSION_LIVE_WINDOW_MS = 6 * 60_000;

/** 最後上報 > 此值 ⇒ **已離線**（分頁大概已經閂咗）。 */
export const SESSION_OFFLINE_WINDOW_MS = 30 * 60_000;

/** 寫入請求（POST）續期節流：每工作階段最多 60 秒寫一次 DB。 */
export const SESSION_TOUCH_THROTTLE_MS = 60_000;

/**
 * 讀取請求（GET `/api/pos/state`）續期節流：**5 分鐘**。
 *
 * 點解 GET 都要續期：輪詢閘令一部健康嘅收銀機最多 5 分鐘出一次聲，
 * 如果只靠 POST 續期，**冇生意嘅時段工作階段會被誤標「已離線」**。
 * 5 分鐘 ＝ 同輪詢節奏一致，即「一有上報就一定夠新鮮」，而成本係每部機 12 次/小時
 * 嘅單行 UPDATE（同一間店全部加埋 ≪ 1 KB/分鐘）。
 *
 * ⚠️ GET **只續期已存在嘅 row，唔建立 row** —— 保持「GET 唔創造狀態」嘅語義。
 */
export const SESSION_STATE_TOUCH_THROTTLE_MS = 5 * 60_000;

/** 工作階段紀錄保留日數（超過就可以喺 admin 頁「清除」）。 */
export const SESSION_RETENTION_DAYS = 30;

/** 識別碼長度上限（防有人塞大字串入 header 撐爆 DB）。 */
export const SESSION_KEY_MAX_LEN = 64;

/** 一個請求最多可以帶幾長嘅 build id（合理值係 7~12 位）。 */
export const BUILD_ID_MAX_LEN = 24;

/* ────────────────────────────────────────────────────────────────────────────
 * 型別
 * ──────────────────────────────────────────────────────────────────────────── */

export type PosSessionState =
  /** 使用中（最後上報 ≤ 6 分鐘）。 */
  | "live"
  /** 閒置（6~30 分鐘無上報；可能係真閒置，亦可能被輪詢閘停）。 */
  | "idle"
  /** 已離線（> 30 分鐘無上報；分頁可能已經閂咗）。 */
  | "off"
  /** 已強制關閉（管理員已下達；POS 端未確認之前都係呢個狀態）。 */
  | "rev";

/** `pos_sessions` 一行（0047 migration）。 */
export type PosSessionRow = {
  id: string;
  store_id: string;
  session_key: string;
  account: string | null;
  role: string | null;
  build_id: string | null;
  opened_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
  closed_at: string | null;
};

/** 同一個店家嘅工作階段（admin 頁按店分組用）。 */
export type PosSessionGroup = {
  storeId: string;
  sessions: PosSessionRow[];
  /** 多過一個 ⇒ 商家可能唔為意開咗幾個分頁 ⇒ 要喺標題出警示。 */
  multiOpen: boolean;
  /** 呢組有幾多個係跑住舊版本。 */
  behind: number;
  /** 呢組最舊嗰個嘅開啟時間（ISO）。 */
  oldestOpenedAt: string;
};

/** admin 頁頂部 KPI（5 格；同既有 KPI 帶規則一致）。 */
export type PosSessionSummary = {
  total: number;
  stores: number;
  multiOpenStores: number;
  behind: number;
  oldestOpenedAt: string | null;
  /** 已下達強制關閉但**未確認生效**（＝該分頁仍然連得到）嘅數量；會自然歸零。 */
  revokedPending: number;
  /** 開啟超過 24 小時仍未關（最值得清理）。 */
  openOver24h: number;
};

/* ────────────────────────────────────────────────────────────────────────────
 * 讀取／清洗
 * ──────────────────────────────────────────────────────────────────────────── */

/** 讀 request header 值並清洗（trim + 長度上限）。唔合法 → `null`。 */
export function sanitizeSessionKey(raw: string | null | undefined): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return null;
  if (value.length > SESSION_KEY_MAX_LEN) return null;
  // 只准 URL-safe 字元：key 由 client 產生（uuid 或 fallback），會入 DB primary key。
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  return value;
}

/** 讀 build id 並清洗。唔合法 → `null`（＝未知版本，唔可以當「最新」）。 */
export function sanitizeBuildId(raw: string | null | undefined): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return null;
  if (value.length > BUILD_ID_MAX_LEN) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return null;
  return value;
}

/** 合成 `pos_sessions.id`。 */
export function sessionRowId(storeId: string, sessionKey: string): string {
  return `${storeId}:${sessionKey}`;
}

/** ISO 字串 → epoch ms；解唔到回 `null`（**唔可以**當 0，否則全部變「已離線」）。 */
export function isoToMs(iso: string | null | undefined): number | null {
  if (typeof iso !== "string" || !iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 分類
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 一個工作階段而家屬於邊個狀態。
 *
 * 優先序：**已強制關閉 > 使用中 > 閒置 > 已離線**。
 * 讀唔到 `last_seen_at` → **當「已離線」**（唯一安全方向：寧願叫管理員去查，
 * 都唔好顯示「使用中」但其實已經死咗）。
 */
export function classifyPosSession(
  row: Pick<PosSessionRow, "last_seen_at" | "revoked_at">,
  nowMs: number,
): PosSessionState {
  if (row.revoked_at) return "rev";
  const lastMs = isoToMs(row.last_seen_at);
  if (lastMs === null) return "off";
  const age = nowMs - lastMs;
  if (age <= SESSION_LIVE_WINDOW_MS) return "live";
  if (age <= SESSION_OFFLINE_WINDOW_MS) return "idle";
  return "off";
}

/** 狀態講人話（admin 頁 badge 用）。 */
export function describePosSessionState(state: PosSessionState): string {
  if (state === "live") return "使用中";
  if (state === "idle") return "閒置";
  if (state === "off") return "已離線";
  return "已強制關閉";
}

/**
 * 呢個工作階段係唔係跑住舊版本。
 *
 * ⚠️ **任一未知 → `false`**（唔可以當「落後」）。舊 client 唔會傳 `x-pos-build`
 * （`build_id = null`），標成「落後」會令 admin 頁一出街就全部紅 —— 假警報比冇警報差。
 */
export function isSessionBehind(row: Pick<PosSessionRow, "build_id">, serverBuildId: string | null | undefined): boolean {
  const client = sanitizeBuildId(row.build_id ?? null);
  const server = sanitizeBuildId(serverBuildId ?? null);
  if (!client || !server) return false;
  if (client === "dev" || server === "dev") return false;
  return client !== server;
}

/**
 * 應該續期未？
 *
 * @param lastSeenAtIso DB 現值（`null` ＝ row 唔存在 → **唔應該**喺呢度建立，
 *   caller 自己決定：login / POST 會建立，GET 唔會）。
 */
export function shouldTouchSession(
  lastSeenAtIso: string | null | undefined,
  nowMs: number,
  throttleMs: number,
): boolean {
  const lastMs = isoToMs(lastSeenAtIso);
  if (lastMs === null) return false;
  return nowMs - lastMs >= throttleMs;
}

/**
 * 相對時間（中文，唔用 `toLocaleString` —— 要**確定性**輸出，唔受執行環境影響）。
 * 例：`剛剛` / `2 分鐘前` / `3 小時前` / `2 日前`。
 */
export function describeAgo(fromIso: string | null | undefined, nowMs: number): string {
  const ms = isoToMs(fromIso);
  if (ms === null) return "—";
  const diff = Math.max(0, nowMs - ms);
  if (diff < 60_000) return "剛剛";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  const days = Math.floor(hours / 24);
  return `${days} 日前`;
}

/**
 * 已開啟幾久（中文）。例：`19 分鐘` / `2 小時 38 分` / `26 小時 38 分`。
 */
export function describeOpenDuration(openedIso: string | null | undefined, nowMs: number): string {
  const ms = isoToMs(openedIso);
  if (ms === null) return "—";
  const totalMinutes = Math.max(0, Math.floor((nowMs - ms) / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} 分鐘`;
  // 超過 24 小時**唔**換成「日」：admin 要一眼睇到「26 小時」呢種誇張數字。
  return minutes === 0 ? `${hours} 小時` : `${hours} 小時 ${minutes} 分`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 分組 / 統計
 * ──────────────────────────────────────────────────────────────────────────── */

const STATE_ORDER: Record<PosSessionState, number> = { live: 0, idle: 1, off: 2, rev: 3 };

/**
 * 排序：狀態（使用中 → 閒置 → 已離線 → 已強制關閉）→ 同級**開啟較久優先**。
 *
 * 「開啟較久優先」係刻意嘅：最需要處理嘅（開咗一整日冇關）排最前。
 */
export function comparePosSessions(a: PosSessionRow, b: PosSessionRow, nowMs: number): number {
  const sa = STATE_ORDER[classifyPosSession(a, nowMs)];
  const sb = STATE_ORDER[classifyPosSession(b, nowMs)];
  if (sa !== sb) return sa - sb;
  return (isoToMs(a.opened_at) ?? 0) - (isoToMs(b.opened_at) ?? 0);
}

/**
 * 按店家分組（admin 頁主視圖）。
 *
 * 組序：**多開店家優先**（＝商家最可能唔為意嘅情況）→ 再按「最舊工作階段」排前。
 * 組內：`comparePosSessions()`。
 */
export function groupPosSessions(
  rows: readonly PosSessionRow[],
  nowMs: number,
  serverBuildId: string | null | undefined,
): PosSessionGroup[] {
  const byStore = new Map<string, PosSessionRow[]>();
  for (const row of rows) {
    const list = byStore.get(row.store_id);
    if (list) list.push(row);
    else byStore.set(row.store_id, [row]);
  }

  const groups: PosSessionGroup[] = [];
  for (const [storeId, list] of byStore) {
    const sessions = [...list].sort((a, b) => comparePosSessions(a, b, nowMs));
    const openedTimes = sessions.map((s) => isoToMs(s.opened_at) ?? Number.MAX_SAFE_INTEGER);
    groups.push({
      storeId,
      sessions,
      multiOpen: sessions.length > 1,
      behind: sessions.filter((s) => isSessionBehind(s, serverBuildId)).length,
      oldestOpenedAt: sessions[openedTimes.indexOf(Math.min(...openedTimes))]?.opened_at ?? "",
    });
  }

  groups.sort((a, b) => {
    if (a.multiOpen !== b.multiOpen) return a.multiOpen ? -1 : 1;
    return (isoToMs(a.oldestOpenedAt) ?? 0) - (isoToMs(b.oldestOpenedAt) ?? 0);
  });
  return groups;
}

/** admin 頁 KPI（5 格）。 */
export function summarizePosSessions(
  rows: readonly PosSessionRow[],
  nowMs: number,
  serverBuildId: string | null | undefined,
): PosSessionSummary {
  const groups = groupPosSessions(rows, nowMs, serverBuildId);
  const openedMs = rows
    .map((r) => isoToMs(r.opened_at))
    .filter((ms): ms is number => ms !== null);
  return {
    total: rows.length,
    stores: groups.length,
    multiOpenStores: groups.filter((g) => g.multiOpen).length,
    behind: rows.filter((r) => isSessionBehind(r, serverBuildId)).length,
    oldestOpenedAt: openedMs.length ? new Date(Math.min(...openedMs)).toISOString() : null,
    revokedPending: rows.filter((r) => isRevokePending(r, nowMs)).length,
    openOver24h: rows.filter((r) => {
      const ms = isoToMs(r.opened_at);
      return ms !== null && nowMs - ms > 24 * 60 * 60 * 1000;
    }).length,
  };
}

/**
 * 管理員可唔可以「清除」呢一行？
 *
 * 只准清**已經離線**（> 30 分鐘無上報）或者**已強制關閉**嘅 —— 唔准清一個仲活躍嘅
 * 工作階段（否則商家明明開住，admin 頁卻乜都睇唔到，反而更危險）。
 */
export function canClearPosSession(row: Pick<PosSessionRow, "last_seen_at" | "revoked_at">, nowMs: number): boolean {
  const state = classifyPosSession(row, nowMs);
  return state === "off" || state === "rev";
}

/**
 * 「已下達強制關閉，但**仲未確認生效**」—— admin 頁 KPI「已下達待生效」用。
 *
 * ## 為何要一個獨立判準（2026-09-22 實案）
 *
 * 舊寫法係 `Boolean(revoked_at) && classify() === "rev"`。但 `classifyPosSession()` 只要
 * `revoked_at` 有值就**永遠**回 `"rev"` ⇒ 呢個 KPI **一升就永遠唔會跌**：
 * 商家強制關掉一個分頁之後，數字一直掛住「1」，睇落好似「卡住咗、未生效」
 * （商家 2026-09-22 回報：「我強制關掉後，一直都是卡在那邊」）。
 *
 * ## 口徑（三個情況都要分開）
 *
 * | 情況 | 判斷 | 理由 |
 * |---|---|---|
 * | 下達**之後**仲有上報過（`last_seen_at > revoked_at`） | **唔算**待生效 | 該分頁已經連過線 ⇒ 一定收到軟踢 header（POS 端見到就停輪詢） |
 * | 下達之後冇上報，但**仍在離線門檻內**（≤ 30 分） | **算**待生效 | 分頁可能只係下一個輪詢週期未到（輪詢閘最多 5 分鐘） |
 * | 下達之後冇上報，而且**已過離線門檻** | **唔算**待生效 | 部機根本唔喺度（分頁已閂／已斷網）⇒ 冇「等生效」可言，屬「可以清除」 |
 *
 * ⇒ 呢個 KPI 會自然歸零，唔會再長期卡住。
 */
export function isRevokePending(
  row: Pick<PosSessionRow, "last_seen_at" | "revoked_at">,
  nowMs: number,
): boolean {
  if (!row.revoked_at) return false;
  const revMs = isoToMs(row.revoked_at);
  if (revMs === null) return false;
  const lastMs = isoToMs(row.last_seen_at);
  if (lastMs === null) return false;
  if (lastMs > revMs) return false;
  return nowMs - lastMs <= SESSION_OFFLINE_WINDOW_MS;
}

/**
 * 已強制關閉嘅工作階段，仲准唔准推呢批事件上雲？
 *
 * ## 為何唔可以一律拒收（呢個係刻意嘅取捨）
 *
 * 同《寫入閘》（`write-gate.ts`）同一條紀律：**客人走唔到比多寫一筆嚴重**。
 * 強制關閉嘅目的係「止血」——停止新生意同停止無意義嘅輪詢 ——
 * 而唔係「令正在結帳嘅客人卡死」。
 *
 * ⇒ **擋**：`ORDER_CREATED`、`ORDER_UPDATED`（新單／加菜）＝ 開新生意。
 *    **放行**：結帳、退款、退菜、刪單、打印任務、純狀態推進、`ledger-` 線上鏡像。
 *
 * @param eventTypes 呢批要推嘅事件類型（去重前）
 * @returns 唔准推嘅事件類型清單（空 ＝ 全部放行）
 */
export function blockedEventTypesForRevokedSession(eventTypes: readonly string[]): string[] {
  const BLOCKED = new Set(["ORDER_CREATED", "ORDER_UPDATED"]);
  const blocked = new Set<string>();
  for (const type of eventTypes) {
    if (BLOCKED.has(type)) blocked.add(type);
  }
  return [...blocked];
}
