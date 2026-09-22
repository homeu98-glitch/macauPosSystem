import { after } from "next/server";

import { macauDayString } from "@/lib/pos/egress-usage";
import { getSupabaseWriteClient } from "@/lib/supabase-server";

/**
 * 《每家店雲端用量計量》（2026-09-22）。
 *
 * ## 為咩需要
 *
 * Supabase Dashboard 只會俾一個**專案總數**，而一個專案裡面有**多間店**
 * （`pos_*` 全部按 `store_id` 隔離）。商家想知「邊間店食咗幾多」、
 * 「加多一間店會唔會爆 5 GB 免費額」——Dashboard 答唔到。
 *
 * 所以由**我哋自己嘅 route** 記帳：每次回 response 都知 bytes（`jsonWithEgressLog`
 * 已經量好），順手累加落 `pos_egress_daily`。
 *
 * ## 計量口徑（要老實講）
 *
 * 量到嘅係「**Vercel Function → 瀏覽器／APK**」嗰段 response bytes。
 * Supabase 帳單嘅官方口徑係「**Supabase → Vercel Function**」嗰段（見
 * `egress-log.ts` 頂部）。兩者方向相反，但**數量級同趨勢一致**
 * （因為 route 回幾多，就係由 Supabase 拉返嚟嘅同一個 payload 加工而成），
 * 用嚟做「邊間店、邊條路徑食流量、有冇改善」嘅**相對比較**完全夠。
 * 要精確對帳單請用 Supabase Dashboard。呢點喺 admin 頁一定要寫明。
 *
 * ## 成本控制（唔可以令「計量」自己變成流量來源）
 *
 * · **記憶體緩衝 + 節流 flush**：同一個 `store|day|route` 最多每 60 秒、
 *   或累積 25 次、或 512 KB 才寫一次 DB ⇒ 1 個 RPC 換一大批請求。
 * · **`after()` 之後才寫**：唔佔用 response 時間（Next 16 提供）。
 * · **試一次、記住結果**：`pos_bump_egress` 唔存在（migration 未跑）→
 *   只試一次就永久停用，唔會每次請求都撞一個 42883 error。
 * · **永遠唔 throw**：計量係輔助設施，絕對唔可以影響落單／出紙／讀取。
 * · 停用方法：環境變數 `POS_EGRESS_METER=0`。
 */

/** 同一個 bucket 最多每 60 秒 flush 一次。 */
const FLUSH_AFTER_MS = 60_000;
/** 累積幾多次請求就提前 flush（畀高流量店舖避免緩衝過大）。 */
const FLUSH_AT_CALLS = 25;
/** 累積幾多 bytes 就提前 flush。 */
const FLUSH_AT_BYTES = 512 * 1024;

interface Bucket {
  calls: number;
  bytes: number;
  /** 上次成功 flush 之後嘅「首次累積時間」（0 ＝ 仲未有任何累積）。 */
  firstAt: number;
}

const buffer = new Map<string, Bucket>();
/** 邊個 key 有未寫入嘅累積。 */
let dirtyKeys = new Set<string>();
/** RPC 唔存在（migration 未跑）→ 停用，唔再試。 */
let rpcUnavailable = false;
let flushing = false;
let warnedMissing = false;

/**
 * 澳門日期（`YYYY-MM-DD`）—— 真源喺純模組 `egress-usage.ts`（有單測鎖住 +8 語義）。
 * Vercel 跑 UTC ⇒ **一定唔可以**用 `toISOString().slice(0,10)`，否則澳門 00:00–08:00
 * 嘅流量會記落前一日。
 */
export { macauDayString };

function isMeterEnabled(): boolean {
  const raw = typeof process === "undefined" ? undefined : process.env.POS_EGRESS_METER;
  if (raw === undefined) return true;
  const value = String(raw).trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "");
}

/**
 * 記一筆用量。**永遠唔 throw、唔 await**（可以喺 response 之後安全呼叫）。
 *
 * @param input.storeId 冇 storeId（未登入 / 非店舖路徑）→ 唔記（記落去只會污染報表）。
 */
export function recordEgressUsage(input: {
  storeId?: string | null;
  route: string;
  bytes: number;
  calls?: number;
  nowMs?: number;
}): void {
  try {
    if (!isMeterEnabled() || rpcUnavailable) return;
    const storeId = (input.storeId ?? "").trim();
    if (!storeId) return;
    const bytes = Number.isFinite(input.bytes) ? Math.max(0, Math.floor(input.bytes)) : 0;
    const calls = Number.isFinite(input.calls) ? Math.max(1, Math.floor(input.calls ?? 1)) : 1;
    if (bytes === 0 && calls === 0) return;

    const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
    const route = (input.route || "other").slice(0, 48);
    const key = `${storeId}|${macauDayString(nowMs)}|${route}`;

    const bucket = buffer.get(key) ?? { calls: 0, bytes: 0, firstAt: nowMs };
    if (bucket.calls === 0) bucket.firstAt = nowMs;
    bucket.calls += calls;
    bucket.bytes += bytes;
    buffer.set(key, bucket);
    dirtyKeys.add(key);

    const due =
      nowMs - bucket.firstAt >= FLUSH_AFTER_MS ||
      bucket.calls >= FLUSH_AT_CALLS ||
      bucket.bytes >= FLUSH_AT_BYTES;
    if (!due) return;

    // 喺 response 之後才寫（唔佔 response 時間）。`after()` 喺非請求環境（例如單測）會
    // 掟錯 → 兜底用 fire-and-forget，最壞情況只係嗰幾個 bucket 遲啲才寫。
    try {
      after(() => flushEgressUsage());
    } catch {
      void flushEgressUsage();
    }
  } catch {
    /* 計量係輔助設施：任何意外都唔可以影響主流程 */
  }
}

/**
 * 把所有未寫入嘅累積寫落 DB（1 個 RPC 一批，按 key 逐條）。
 *
 * 併發保護：同時只跑一個 flush；期間新累積留待下次。
 */
export async function flushEgressUsage(): Promise<void> {
  if (flushing || rpcUnavailable) return;
  if (dirtyKeys.size === 0) return;
  const supabase = getSupabaseWriteClient();
  if (!supabase) return;

  flushing = true;
  const keys = [...dirtyKeys];
  dirtyKeys = new Set<string>();
  try {
    for (const key of keys) {
      const bucket = buffer.get(key);
      if (!bucket || bucket.calls === 0) continue;
      const [storeId, day, route] = key.split("|");
      const { error } = await supabase.rpc("pos_bump_egress", {
        p_store_id: storeId,
        p_day: day,
        p_route: route,
        p_calls: bucket.calls,
        p_bytes: bucket.bytes,
      });
      if (error) {
        // migration 未跑 → 唔再試（否則每次請求都撞 error，反而製造噪音同查詢）
        if (/does not exist|42883|PGRST202/i.test(error.message)) {
          rpcUnavailable = true;
          if (!warnedMissing) {
            warnedMissing = true;
            console.warn(
              "[egress-meter] pos_bump_egress 唔存在（migration 0048 未跑）→ 停用用量計量。",
            );
          }
          return;
        }
        console.warn("[egress-meter] flush failed:", error.message);
        // 失敗就保留累積，等下次再試（有界：bucket 最多累到下一次觸發）
        buffer.set(key, bucket);
        dirtyKeys.add(key);
        continue;
      }
      // 成功：清零（保留 firstAt 語義 → 重新計時）
      buffer.set(key, { calls: 0, bytes: 0, firstAt: 0 });
    }
  } catch (err) {
    console.warn("[egress-meter] flush threw:", err);
  } finally {
    flushing = false;
  }
}

/** 測試用：清空記憶體緩衝與停用旗標。 */
export function __resetEgressMeterForTest(): void {
  buffer.clear();
  dirtyKeys = new Set<string>();
  rpcUnavailable = false;
  flushing = false;
  warnedMissing = false;
}
