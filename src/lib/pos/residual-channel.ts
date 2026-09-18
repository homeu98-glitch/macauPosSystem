/**
 * 「殘留接單通道」偵測（2026-09-18）。
 *
 * ── 問題 ─────────────────────────────────────────────────────────────────
 * 交班應該一次過關埋線下 + 線上接單，但兩條通道**獨立故障**：
 * 線下關到、線上關唔到（或反過來）都會留下一個仍然開住嘅落單入口。
 * 收銀喺 `/pos` 睇住兩粒 pill，唔一定留意到「一粒紅、一粒綠」＝仲有通道開住。
 *
 * ── 做法 ─────────────────────────────────────────────────────────────────
 * 唔新增格子（側欄 72px 放唔落，J 2026-09-14 已指示移除嗰格），
 * 而係喺**既有 pill** 上面加一個狀態點 + tooltip：
 * 邊一條通道已關而另一條仲開 → 嗰粒 pill 出警示點。
 *
 * ── 純函式（零 import）──────────────────────────────────────────────────
 * `npm test` ＝ `node --test`（唔認 `@/` 別名），所以呢個檔唔可以 import 任何嘢。
 */

/** 一粒 pill 嘅殘留警示狀態。 */
export type ResidualChannelState =
  /** 兩條通道一致（都開 / 都關 / 都有未讀到）→ 唔出點。 */
  | "none"
  /** 本通道已關，但**另一條仍然開住** → 出點（呢個就係「殘留入口」）。 */
  | "residual";

/**
 * 判斷「線下 pill」要唔要出殘留警示點。
 *
 * 條件：**線下已關**（`isOpen === false`）而且**線上仍然開**（`merchantEnabled === true`）。
 *
 * ⚠️ 未讀到（`null`）**唔算**殘留：未讀到係「唔知」，唔係「仲開住」。
 *    用 `null` 觸發警示 = 每次一斷網就出假警報，收銀之後就會學識無視佢。
 */
export function storeResidualState(
  isOpen: boolean | null,
  merchantEnabled: boolean | null,
): ResidualChannelState {
  return isOpen === false && merchantEnabled === true ? "residual" : "none";
}

/**
 * 判斷「線上 pill」要唔要出殘留警示點。
 *
 * 條件：**線上已暫停**（`merchantEnabled === false`）而且**線下仍然開**（`isOpen === true`）。
 *
 * ⚠️ 呢個情況比上面更常見亦更危險：店主可能只係手動暫停咗線上接單（例如想專心做堂食），
 *    但**店內掃碼 / kiosk 照樣落得到單** —— 如果佢以為「暫停接單 = 唔再接單」就中招。
 */
export function onlineResidualState(
  isOpen: boolean | null,
  merchantEnabled: boolean | null,
): ResidualChannelState {
  return merchantEnabled === false && isOpen === true ? "residual" : "none";
}

/** 殘留警示點嘅 tooltip 文案（線下 pill 用）。 */
export const STORE_RESIDUAL_HINT =
  "店內接單已關，但線上接單仍然開住：客人仍可透過會員通落單。";

/** 殘留警示點嘅 tooltip 文案（線上 pill 用）。 */
export const ONLINE_RESIDUAL_HINT =
  "線上接單已暫停，但店內接單仍然開住：客人仍可掃碼、用自助點餐機落單。";
