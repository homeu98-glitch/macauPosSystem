/**
 * 《雲端用量匯總》—— admin「雲端用量」頁同 API 共用嘅**純邏輯**（2026-09-22）。
 *
 * ## 為咩要純模組
 *
 * `pos_egress_daily` 係「每店 × 每日 × 每路徑」一行嘅原始累加表。
 * 頁面要嘅係「今日 / 本月 / 走勢 / 頭幾條路徑 / 距離 5 GB 有幾遠」——
 * 呢啲全部係**可測嘅數學**，所以收喺零 import 模組（`node --test` 直接跑），
 * API 只回原始 row，頁面用同一份邏輯 ⇒ 兩邊口徑唔會漂移。
 *
 * ## 口徑（一定要喺頁面寫明，唔可以誤導商家）
 *
 * 記低嘅係「**Vercel Function → 瀏覽器／APK**」嘅 response bytes；
 * Supabase 帳單官方口徑係「**Supabase → Vercel Function**」。方向相反、數量級一致
 * ⇒ 用嚟做**店與店／路徑與路徑嘅相對比較**同趨勢觀察足夠；
 * 要精確對帳單請睇 Supabase Dashboard。
 *
 * ## 免費用戶配額
 *
 * Supabase Free 每**月** 5 GB egress（舊制）。呢度用同一個數字做「距離爆額有幾遠」
 * 嘅參考線 —— ⚠️ 佢係**專案總額**，唔係每店配額。所以「可容幾間店」
 * ＝ `5 GB ÷ 單店月用量`，係推算而唔係硬限制。
 */

/** Supabase Free 每月 egress（5 GB）。 */
export const EGRESS_FREE_QUOTA_BYTES = 5 * 1024 ** 3;

/** 「警告」門檻：用量到配額幾多就轉黃。 */
export const EGRESS_WARN_RATIO = 0.5;
/** 「危險」門檻：到幾多就轉紅（＝大約 3 日內會爆）。 */
export const EGRESS_DANGER_RATIO = 0.8;

export interface EgressUsageRow {
  storeId: string;
  /** 澳門日期 `YYYY-MM-DD`。 */
  day: string;
  route: string;
  calls: number;
  bytes: number;
}

export interface EgressStoreSummary {
  storeId: string;
  todayBytes: number;
  todayCalls: number;
  /** 本月（`monthPrefix` 開頭嘅日）累計。 */
  monthBytes: number;
  monthCalls: number;
  /** 窗口內（最近 N 日）累計。 */
  windowBytes: number;
  windowCalls: number;
  /** 依日升序、缺日補 0（畫走勢用）。 */
  daily: Array<{ day: string; bytes: number }>;
  /** 本月頭幾條食流量嘅路徑（降序，最多 6 條）。 */
  topRoutes: Array<{ route: string; bytes: number; calls: number }>;
  /** `monthBytes / quota`（>1 ＝ 已經超出）。 */
  quotaRatio: number;
  /**
   * 按本月至今嘅日均推算全月用量（未夠一日 → 用 1 日計，避免除以 0）。
   * 用途：月中就知「月底會唔會爆」。
   */
  projectedMonthBytes: number;
}

export interface EgressSummary {
  stores: EgressStoreSummary[];
  totals: {
    storeCount: number;
    dayCount: number;
    todayBytes: number;
    monthBytes: number;
    windowBytes: number;
    /** 本月總用量 ÷ 配額（專案層面）。 */
    quotaRatio: number;
    /** 5 GB ÷ 單店月用量 —— 估計仲可以容納幾多間同量級嘅店。 */
    affordableStores: number;
  };
  /** 窗口內嘅澳門日期（升序，`YYYY-MM-DD`）—— 走勢圖嘅 x 軸。 */
  windowDays: string[];
}

/** 澳門日期（`YYYY-MM-DD`）。一定要自己 +8：Vercel 跑 UTC。 */
export function macauDayString(nowMs: number): string {
  return new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10);
}

/** `nowMs` 所屬月份前綴（`YYYY-MM`，澳門時間）。 */
export function macauMonthPrefix(nowMs: number): string {
  return macauDayString(nowMs).slice(0, 7);
}

/** 由 `day` 往前數 `days` 個（含今日）嘅澳門日期字串，升序。 */
export function recentMacauDays(nowMs: number, days: number): string[] {
  const count = Math.max(1, Math.floor(days));
  const todayMs = Date.parse(`${macauDayString(nowMs)}T00:00:00.000Z`);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    out.push(new Date(todayMs - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

function safeNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 人類可讀位元組（1 位小數；KB／MB／GB／TB）。 */
export function formatBytes(bytes: number): string {
  const n = safeNumber(bytes);
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** 用量警示級別（頁面用嚟上色）。 */
export function quotaLevel(bytes: number, quota = EGRESS_FREE_QUOTA_BYTES): "ok" | "warn" | "danger" {
  if (!Number.isFinite(quota) || quota <= 0) return "ok";
  const ratio = safeNumber(bytes) / quota;
  if (ratio >= EGRESS_DANGER_RATIO) return "danger";
  if (ratio >= EGRESS_WARN_RATIO) return "warn";
  return "ok";
}

/**
 * 匯總原始行。
 *
 * @param rows    `pos_egress_daily` 嘅 row（任何順序、可以缺日）。
 * @param nowMs   現在時間（測試可注入）。
 * @param windowDays 走勢／窗口長度（預設 14 日）。
 */
export function summarizeEgressUsage(
  rows: readonly EgressUsageRow[],
  nowMs: number,
  windowDays = 14,
  quota = EGRESS_FREE_QUOTA_BYTES,
): EgressSummary {
  const days = recentMacauDays(nowMs, windowDays);
  const daySet = new Set(days);
  const today = days[days.length - 1];
  const monthPrefix = macauMonthPrefix(nowMs);
  const dayOfMonth = Number(today.slice(8, 10)) || 1;

  type Acc = {
    storeId: string;
    todayBytes: number;
    todayCalls: number;
    monthBytes: number;
    monthCalls: number;
    windowBytes: number;
    windowCalls: number;
    byDay: Map<string, number>;
    byRoute: Map<string, { bytes: number; calls: number }>;
  };
  const acc = new Map<string, Acc>();

  for (const row of rows ?? []) {
    const storeId = String(row?.storeId ?? "").trim();
    const day = String(row?.day ?? "").trim();
    if (!storeId || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const bytes = safeNumber(row?.bytes);
    const calls = safeNumber(row?.calls);
    const entry =
      acc.get(storeId) ??
      ({
        storeId,
        todayBytes: 0,
        todayCalls: 0,
        monthBytes: 0,
        monthCalls: 0,
        windowBytes: 0,
        windowCalls: 0,
        byDay: new Map<string, number>(),
        byRoute: new Map<string, { bytes: number; calls: number }>(),
      } satisfies Acc);
    acc.set(storeId, entry);

    if (day === today) {
      entry.todayBytes += bytes;
      entry.todayCalls += calls;
    }
    if (day.startsWith(monthPrefix)) {
      entry.monthBytes += bytes;
      entry.monthCalls += calls;
      const routeKey = String(row?.route ?? "other").trim() || "other";
      const route = entry.byRoute.get(routeKey) ?? { bytes: 0, calls: 0 };
      route.bytes += bytes;
      route.calls += calls;
      entry.byRoute.set(routeKey, route);
    }
    if (daySet.has(day)) {
      entry.windowBytes += bytes;
      entry.windowCalls += calls;
      entry.byDay.set(day, (entry.byDay.get(day) ?? 0) + bytes);
    }
  }

  const stores: EgressStoreSummary[] = [...acc.values()]
    .map((e) => {
      const daily = days.map((day) => ({ day, bytes: e.byDay.get(day) ?? 0 }));
      const topRoutes = [...e.byRoute.entries()]
        .map(([route, v]) => ({ route, bytes: v.bytes, calls: v.calls }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 6);
      return {
        storeId: e.storeId,
        todayBytes: e.todayBytes,
        todayCalls: e.todayCalls,
        monthBytes: e.monthBytes,
        monthCalls: e.monthCalls,
        windowBytes: e.windowBytes,
        windowCalls: e.windowCalls,
        daily,
        topRoutes,
        quotaRatio: quota > 0 ? e.monthBytes / quota : 0,
        // 月中推算全月：用「本月至今 ÷ 日數 × 當月日數」
        projectedMonthBytes: Math.round((e.monthBytes / Math.max(dayOfMonth, 1)) * 31),
      };
    })
    .sort((a, b) => b.monthBytes - a.monthBytes || b.todayBytes - a.todayBytes);

  const total = (pick: (s: EgressStoreSummary) => number) =>
    stores.reduce((sum, s) => sum + pick(s), 0);

  const monthBytes = total((s) => s.monthBytes);
  const avgStoreMonthBytes = stores.length > 0 ? monthBytes / stores.length : 0;

  return {
    stores,
    totals: {
      storeCount: stores.length,
      dayCount: days.length,
      todayBytes: total((s) => s.todayBytes),
      monthBytes,
      windowBytes: total((s) => s.windowBytes),
      quotaRatio: quota > 0 ? monthBytes / quota : 0,
      // 「仲可以容納幾多間」＝ 剩餘額度 ÷ 單店月用量（單店用量為 0 → 唔可以推斷，回 0）
      affordableStores:
        avgStoreMonthBytes > 0
          ? Math.max(0, Math.floor((quota - monthBytes) / avgStoreMonthBytes))
          : 0,
    },
    windowDays: days,
  };
}
