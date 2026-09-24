/**
 * 外賣平台單（澳覓 / MFOOD）廚房單出紙規則 —— **純函式，零 import**。
 *
 * ── 背景：為什麼要做「平台訂單打印分區」（方案 A）──────────────────────
 * 平台菜單**唔存在於 POS**（平台菜名係 free text，同 POS 餐牌對唔到，係常態而唔係錯誤），
 * 所以「逐項分流」（飲品去水吧、食物去廚房）根本做唔到。
 * ⇒ 唯一可行嘅口徑係：**平台單所有品項一律歸同一個分區**，由商家指定嗰個分區係邊個。
 * ⇒ 想出多台機？唔使做「多選打印機」—— 只要**多台機都綁去同一個分區**
 *    （現有 `item.printerGroup === printer.zoneId` 天生支援一個分區 ↔ 多台機，
 *    `resolveJobPrinter()` / `dispatch.ts` / `pos_print_jobs` 完全唔使改）。
 *
 * ── 🔴 為什麼「空值」要當「跟隨廚房」而唔係當一個真分區 id ────────────
 * 如果空值當成 `""` 走去比對，就冇任何打印機嘅 `zoneId` 會等於 `""`（除非商家真係
 * 開咗一部冇分區嘅 catch-all 機）⇒ **零 job、零出紙、零錯誤訊息**。
 * 呢個正係本專案反覆中招嘅「寫得入 ≠ 讀得出／靜默唔出紙」同一類病
 * （見 `ledger-pos-bridge.ts` 對 catch-all 嘅註釋、docs/reviews）。
 * ⇒ 所以「冇設定」語意上等於**唔覆寫**：各品項保留自己原本嘅 `printerGroup`
 *   （平台單目前寫死 `kitchen`），行為同堂食單一致、可預期。
 *
 * ── 零 import ──────────────────────────────────────────────────────
 * 同 `pos-order-row.ts`、`platform-order.ts` 同一理由：保持零 import 先可以被
 * `node --test` 直接載入驗證（`print-jobs.ts` 有 `"use client"` ＋ `@/lib/...` runtime
 * import，載唔到 → 嗰邊嘅規則會變成零測試覆蓋，見 docs/113 教訓）。
 */

/** 「跟隨廚房分區」＝ 唔覆寫（語意見檔頭）。空字串係對外嘅「未設定」表示。 */
export const PLATFORM_ZONE_FOLLOW_KITCHEN = "";

/**
 * 平台單「開機補印」容忍期：**1 小時**（對齊線上單補印窗口
 * `KITCHEN_BACKFILL_MAX_AGE_MS`，見 `@/lib/pos/kitchen-backfill`）。
 *
 * 為什麼要有呢個限制：POS 收機／斷線期間插件照樣推單 → 收銀一開機就會見到
 * 一批**歷史**平台單。冇時效限制嘅話，一開機就會把全部舊單一次過出紙
 * （測試期已經累積幾十張）⇒ 洗版 + 浪費紙。
 */
export const PLATFORM_KITCHEN_BACKFILL_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * 正規化「平台訂單打印分區」設定值 → 分區 id；未設定一律回 `""`。
 *
 * 收 `unknown`：呢個值可能來自 localStorage（手改過）、雲端回填、或者舊版
 * device config（冇呢一欄）→ 唔可以假設係合法字串。
 */
export function normalizePlatformPrinterZone(value: unknown): string {
  if (typeof value !== "string") return PLATFORM_ZONE_FOLLOW_KITCHEN;
  return value.trim();
}

/** 係唔係「跟隨廚房分區」（＝未設定／設定成空白）。 */
export function platformZoneFollowsKitchen(value: unknown): boolean {
  return normalizePlatformPrinterZone(value) === PLATFORM_ZONE_FOLLOW_KITCHEN;
}

/**
 * 得出一張平台單某個品項嘅**實際派發分區**。
 *
 * @param itemPrinterGroup 品項本身嘅 `printerGroup`（平台單目前一律 `kitchen`）
 * @param configuredZone   `DeviceConfig.platformPrinterZoneId`（空 = 跟隨廚房）
 * @returns 有設定 → 設定嘅分區（**所有**品項都用佢）；冇設定 → 品項原本嘅分區
 */
export function resolvePlatformItemZone(
  itemPrinterGroup: unknown,
  configuredZone: unknown,
): string {
  const zone = normalizePlatformPrinterZone(configuredZone);
  if (zone) return zone;
  return typeof itemPrinterGroup === "string" ? itemPrinterGroup : "";
}

/** `kitchenPrinterTakesItem()` 嘅輸入 —— 全部收 `unknown`（來源可能係 DB 回填 / 舊資料）。 */
export interface KitchenPrinterMatchInput {
  /** 打印機嘅 `zoneId`。**空 / undefined = catch-all**（接晒所有品項）。 */
  printerZoneId?: unknown;
  /** 品項嘅 `printerGroup`。 */
  itemPrinterGroup?: unknown;
  /** 平台單專用嘅分區覆寫（空 = 唔覆寫，用品項自己嗰個）。 */
  zoneOverride?: unknown;
}

/**
 * 🔴 **廚房單派發規則的唯一實作**（堂食 / 自助 / 線上 / 平台單全部共用）。
 *
 * ```
 * 打印機冇 zoneId（catch-all）        → 接晒所有品項
 * 打印機有 zoneId                    → 只接「有效分區 == 自己 zoneId」嘅品項
 * ```
 * 「有效分區」= `zoneOverride`（有值時，平台單用）**否則**品項自己嘅 `printerGroup`。
 *
 * 為什麼要抽成零依賴純函式：呢條規則原本寫死喺 `print-jobs.ts` 嘅 `.filter()` 一行入面，
 * 而 `print-jobs.ts` 有 `"use client"` ＋ `@/lib/...` runtime import ⇒ `node --test` 載唔到
 * ⇒ **派發規則一直零測試覆蓋**（同 `escpos-template.ts` 加總不變式同一款盲點，見 docs/113）。
 * 而佢正正係「點解平台單會／唔會出紙」嘅唯一判準，所以一定要鎖得住。
 *
 * ⚠️ `ledger-pos-bridge.ts` 有一份**刻意並存**嘅同款邏輯（線上單走佢自己嗰條路），
 *    兩邊語意必須一致：catch-all 機接晒所有品項。改呢度唔可以唔對嗰邊。
 */
export function kitchenPrinterTakesItem(input: KitchenPrinterMatchInput): boolean {
  const printerZoneId = normalizePlatformPrinterZone(input.printerZoneId);
  // catch-all：冇分區嘅機接晒所有品項（舊寫法嚴格比對會令「只設一台冇填分區嘅廚房機」
  // 嘅店接單後**靜默唔出單**，見 ledger-pos-bridge.ts 嘅同源註釋）。
  if (!printerZoneId) return true;
  return resolvePlatformItemZone(input.itemPrinterGroup, input.zoneOverride) === printerZoneId;
}

/** 平台單開機補印判定結果（畀 caller 分辨「唔需要補」同「唔應該補」，方便診斷）。 */
export type PlatformKitchenBackfillDecision =
  /** 應該補建廚房單 */
  | "print"
  /** 冇建立時間／時間唔合法 → 保守唔補（寧少一張，唔可以補一堆舊單） */
  | "unknown-time"
  /** 已經過咗容忍期（歷史單）→ 唔補 */
  | "stale";

export interface PlatformKitchenBackfillInput {
  /** 訂單建立時間（ISO）。 */
  createdAt?: string | null;
  nowMs: number;
  maxAgeMs?: number;
}

/**
 * POS 開機時，一張「本機未出過紙」嘅平台單應唔應該補印廚房單。
 *
 * 口徑：**只補最近 `maxAgeMs`（預設 1 小時）內建立嘅單**。時間唔合法一律唔補
 * —— 平台單係外賣，舊單補紙冇意義（客人都收到餐），反而會誤導廚房。
 */
export function decidePlatformKitchenBackfill(
  input: PlatformKitchenBackfillInput,
): PlatformKitchenBackfillDecision {
  const maxAgeMs = input.maxAgeMs ?? PLATFORM_KITCHEN_BACKFILL_MAX_AGE_MS;
  const raw = input.createdAt ? Date.parse(String(input.createdAt)) : NaN;
  if (!Number.isFinite(raw)) return "unknown-time";
  if (input.nowMs - raw > maxAgeMs) return "stale";
  return "print";
}

/** 只讀呢幾個欄位 —— 唔綁死 `DevicePrinterConfig`，方便單測同避免 import。 */
export interface ZonePrinterLike {
  enabled?: boolean;
  role?: string;
  zoneId?: string;
}

/**
 * 某個分區有幾台**啟用嘅**分區機（`role === "zone"`）。
 *
 * 用途：設定頁即時警示「揀咗嘅分區冇機」—— 因為揀咗一個冇機嘅分區 =
 * 平台單**靜默零出紙**（同 `platformZoneFollowsKitchen()` 註釋同一類病）。
 * 回 0 就應該喺 UI 出橙字。
 */
export function platformZonePrinterCount(
  zoneId: unknown,
  printers: readonly ZonePrinterLike[] | null | undefined,
): number {
  const zone = normalizePlatformPrinterZone(zoneId);
  if (!zone) return 0;
  return (printers ?? []).filter(
    (printer) => printer?.enabled && printer?.role === "zone" && printer?.zoneId === zone,
  ).length;
}
