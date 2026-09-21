/**
 * 《輪詢閘》—— 「幾時唔應該再 call」嘅**純決策**（2026-09-21）。
 *
 * ── 核心原則：Push 優先，Polling 只做兜底 ─────────────────────────────────
 *
 * J 2026-09-21：「不應該不停的 polling，這個完全錯。」
 *
 * 本專案**已經有**完整嘅 push 基建，所以週期輪詢唔應該係主力：
 *
 * | 對象 | 已有嘅 push | 週期輪詢應該係 |
 * |---|---|---|
 * | POS 網頁 | Realtime 4 條 channel（`pos_orders` / `pos_print_jobs` / `pos_soldout` / `pos_store_status`）＋ 手勢 ＋ `visibilitychange` | **慢兜底**（5 分鐘），Realtime 唔通才回落到 60 秒 |
 * | 打印中繼 APK | `PosRealtimeSubscriber`（訂 `pos_print_jobs` INSERT → `onRealtimeWake()` → claim → 出紙） | 兜底（60s → 建議 300s） |
 *
 * ⚠️ **為何唔可以真係「零輪詢」**：本專案有「Realtime **靜默失效**」前科
 * （`use-store-status.ts:38-43` 明確記錄：訂錯 Supabase 專案會照樣 `SUBSCRIBED`
 * 但**永遠收唔到事件**，而且 Supabase 唔會報錯）。零輪詢＝將「全日收唔到單」
 * 呢個災難級風險押上。所以**保留極慢兜底**（5 分鐘），將最壞情況由「全日」
 * 壓到「5 分鐘」。要真零輪詢：把 `POLL_INTERVAL_PUSHED_MS` 設成 `Infinity`。
 *
 * ── 四條正交軸（唔可以壓成一條）──────────────────────────────────────────
 * | 軸 | 真源 | 停唔停 |
 * |---|---|---|
 * | 登入 | auth session | 冇 session → **即停** |
 * | 可見 | `document.visibilityState` | 背景分頁 → **停** |
 * | 活動 | 最後一次真人互動 | 閒置 ≥ 5 分鐘 → **停** |
 * | 營業 | `pos_store_status.is_open` ＋ Ledger `merchant_enabled` | **兩條都關** → 停 |
 * | 班次 | `pos_shifts` open row | 已收工 → 停 |
 *
 * ⚠️ 營業／班次嘅 default **方向相反**：`pos_store_status` **冇 row ＝ 營業中**；
 * `pos_shifts` **冇 open row ＝ 未開工**。
 *
 * ── 紀律：一律 fail-open ─────────────────────────────────────────────────
 * `null`（未讀到）／`undefined` 一律**當未知**，照跑。反過來「讀唔到就停」
 * ＝ 一斷網就唔再同步，比多打幾個請求嚴重得多。
 *
 * ── 本模組刻意零 import ──────────────────────────────────────────────────
 * 專案 `npm test` ＝ `node --test`，**唔行 bundler、唔認 `@/` 別名**
 * ⇒ 可測模組一律唔准 import。要讀 localStorage／Supabase 嘅執行層放
 * `poll-gate-client.ts`（同 `close-gate.ts` / `close-gate-run.ts` 同一分檔法）。
 */

/** 閒置門檻：**5 分鐘**冇任何真人互動 → 停（2026-09-21 J 拍板）。 */
export const POLL_IDLE_MS = 5 * 60_000;

/**
 * Realtime **通** 時嘅最短輪詢間隔。
 *
 * 唔係 0 —— 見頂部「為何唔可以真係零輪詢」。呢個值就係「最壞情況可以差幾久」
 * 嘅上界（5 分鐘）。
 */
export const POLL_INTERVAL_PUSHED_MS = 5 * 60_000;

/**
 * Realtime **唔通**（或未知）時嘅最短輪詢間隔＝維持現行節奏嘅下限。
 * 呢個係降級路徑，唔應該係常態。
 */
export const POLL_INTERVAL_DEGRADED_MS = 60_000;

export type PollGateReason =
  /** 可以輪詢（已隔足時間）。 */
  | "ok"
  /** 冇登入 session／憑證已失效。 */
  | "no-session"
  /** 分頁隱藏。 */
  | "hidden"
  /** 閒置（店仍開，只係冇人掂）。 */
  | "idle"
  /** 線下 ＋ 線上兩條通路都關 ⇒ 唔可能再有新單。 */
  | "all-channels-closed"
  /** 已收工（`pos_shifts` 冇 open row）而且冇 pending 事件。 */
  | "shift-closed"
  /** 靠 push 就夠（Realtime 通，而且未夠兜底間隔）。 */
  | "await-push"
  /** 未夠最短間隔（降級路徑）。 */
  | "await-interval";

export type PollGateInput = {
  sessionAlive: boolean;
  /** `document.visibilityState`（用 string 而唔用 DOM 型別 → 保持零依賴）。 */
  visibilityState: string;
  lastActivityAtMs: number;
  nowMs: number;
  idleMs?: number;
  storeOpen: boolean | null;
  onlineChannelOpen: boolean | null;
  shiftOpen: boolean | null;
  hasPendingSyncEvents: boolean;
  /**
   * Realtime 通唔通。`null` ＝ 未知（未訂上／未報告）——
   * **未知一律當「唔通」** ⇒ 用返現行節奏（fail-open，唔會因為未知而少拉）。
   */
  realtimeConnected: boolean | null;
  /** 上一次真正打嘅時間（0 ＝ 從未打過）。 */
  lastPolledAtMs: number;
  /**
   * 緊急（有本機事件要即刻推上雲，例如 `sync-flush`）。
   * `true` ＝ 只要唔係 `no-session` / `hidden` 就即刻放行，唔理最短間隔。
   * ⚠️ 閒置／關店**唔可以**擋住推單上雲（否則未上雲嘅單會永遠上唔到）。
   */
  urgent?: boolean;
  /**
   * 呼叫性質（2026-09-21）。
   *
   * | 值 | 意思 | 受邊啲閘限制 |
   * |---|---|---|
   * | `"periodic"`（預設）| **週期性輪詢**（timer 驅動）| 全部（idle／關店／收工／最短間隔）|
   * | `"triggered"` | **事件驅動嘅一次性拉取**（mount backfill、realtime 重連補拉、手勢）| 只受 `no-session` / `hidden` |
   *
   * 🔴 **點解要分**：J 嘅要求係「**不應該不停的 polling**」——
   * 針對嘅係**週期**呼叫。而 mount 一次嘅 backfill、重連補一次，本身
   * **自帶頻率上界**（事件驅動），唔係輪詢；如果用 `periodic` 嘅閘去擋，
   * 就會出現「未開工嘅收銀台連今日訂單都拉唔到」呢種嚴重倒退。
   */
  kind?: "periodic" | "triggered";
};

export type PollGateDecision = {
  poll: boolean;
  reason: PollGateReason;
  /** 今次適用嘅最短間隔（診斷用；`poll === true` 時亦等於「下次之前要隔幾久」）。 */
  minIntervalMs: number;
};

/** 距離最後一次互動幾久（ms）。從未互動過 → 0（當剛活躍，唔可以誤判閒置）。 */
export function idleForMs(input: Pick<PollGateInput, "lastActivityAtMs" | "nowMs">): number {
  if (!Number.isFinite(input.lastActivityAtMs) || input.lastActivityAtMs <= 0) return 0;
  return Math.max(0, input.nowMs - input.lastActivityAtMs);
}

/** Realtime 通唔通決定最短間隔；**未知／唔通 → 回落現行節奏**。 */
export function minIntervalFor(realtimeConnected: boolean | null): number {
  return realtimeConnected === true ? POLL_INTERVAL_PUSHED_MS : POLL_INTERVAL_DEGRADED_MS;
}

/**
 * 逐軸判斷。**順序有意義**（先檢查最硬嘅條件，令 `reason` 對診斷最有用）。
 */
export function decidePoll(input: PollGateInput): PollGateDecision {
  const minIntervalMs = minIntervalFor(input.realtimeConnected);

  if (!input.sessionAlive) return { poll: false, reason: "no-session", minIntervalMs };
  if (input.visibilityState !== "visible") return { poll: false, reason: "hidden", minIntervalMs };

  // 事件驅動嘅一次性拉取：只受上面兩道硬閘限制（自帶頻率上界，唔係輪詢）。
  if (input.kind === "triggered") return { poll: true, reason: "ok", minIntervalMs: 0 };

  // 🔴 緊急路徑（推本機事件上雲）只受「有 session ＋ 可見」限制。
  // 閒置、關店、收工都唔可以擋 —— 否則未上雲嘅單永遠上唔到。
  if (input.urgent) return { poll: true, reason: "ok", minIntervalMs: 0 };

  const idleMs = input.idleMs ?? POLL_IDLE_MS;
  if (idleForMs(input) >= idleMs) return { poll: false, reason: "idle", minIntervalMs };

  // 兩條通路**都**明確關咗 ⇒ 唔可能再有新單。
  // （單一通路關＝殘留通道，要繼續監察，唔可以停。）
  if (input.storeOpen === false && input.onlineChannelOpen === false) {
    return { poll: false, reason: "all-channels-closed", minIntervalMs };
  }

  // 已收工 ⇒ 客人落唔到單（server 有班次閘）。
  if (input.shiftOpen === false && !input.hasPendingSyncEvents) {
    return { poll: false, reason: "shift-closed", minIntervalMs };
  }

  const sinceLast = sinceLastPoll(input);
  if (sinceLast < minIntervalMs) {
    return {
      poll: false,
      reason: input.realtimeConnected === true ? "await-push" : "await-interval",
      minIntervalMs,
    };
  }

  return { poll: true, reason: "ok", minIntervalMs };
}

function sinceLastPoll(input: Pick<PollGateInput, "lastPolledAtMs" | "nowMs">): number {
  if (!Number.isFinite(input.lastPolledAtMs) || input.lastPolledAtMs <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, input.nowMs - input.lastPolledAtMs);
}
