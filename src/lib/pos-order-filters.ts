import type { PosOrder } from "@/lib/types";
// ⚠️ 一定要 `./pos/quick-labels.ts`（相對 + 顯式 `.ts`）：
// 呢個模組要可以被 `node --test` 直接載入做單元測試，`@/` 別名喺 Node ESM 解析唔到。
import { quickCompletionLabel } from "./pos/quick-labels.ts";

export function isLocalPosOrder(order: PosOrder): boolean {
  return !order.onlineOrderId;
}

/**
 * 本地面板可見範圍：本地單 + 「已轉到堂食枱」嘅線上堂食單。
 * 純線上快餐 / 自取 / 外賣（counter / 無枱）屬上游 Ledger 對賬，唔喺本地面板管理，亦唔可以返結。
 * 美容同其他本地單無 onlineOrderId，一律當本地單。
 */
export function isLocalOrTransferredDineIn(order: PosOrder): boolean {
  if (!order.onlineOrderId) return true; // 本地單
  // 線上堂食單，已轉到枱（tableId 唔係 counter）→ 當本地單管理
  return !!order.tableId && order.tableId !== "counter";
}

/**
 * 已被「排位」轉成本地堂食單嘅 Ledger 單 id 集合（2026-09-12 商家要求）。
 *
 * 病症：線上單排位之後**兩邊都同時出現**（線上訂單列表 + 店內線下訂單），
 * 同一張單睇落好似兩張。
 * 商家口徑：「如果轉成了堂食單，就直接把訂單換成線下單即可，不應該兩邊同時存在。」
 *
 * ⇒ 線上訂單列表（`online-orders.tsx` 同快捷操作面板）要**剔除**呢批 id。
 * 判準同 `isLocalOrTransferredDineIn()` 一致（有 `onlineOrderId` + 真枱號 ≠ counter），
 * 所以快餐模式採納嘅 counter 單**唔會**被剔走 —— 佢哋喺快餐 strip 管理，
 * 線上列表仍然係佢哋嘅來源記錄。
 */
export function transferredLedgerOrderIds(localOrders: PosOrder[]): Set<string> {
  const ids = new Set<string>();
  for (const order of localOrders) {
    if (order.onlineOrderId && isLocalOrTransferredDineIn(order)) ids.add(order.onlineOrderId);
  }
  return ids;
}

/**
 * 快餐 counter 單（先收款、後出餐流程）。
 *
 * 🔴 2026-09-12：**唔再要求 `isLocalPosOrder()`**（即唔再排除帶 `onlineOrderId` 嘅單）。
 *
 * 原因：快餐模式收到線上 `dine_in` 單會**採納成本地 counter 單**
 * （`adoptLedgerOrderAsQuickCounter()`，商家口徑「快餐店有枱但唔安排座位，出餐口自取」），
 * 之後要行同本地快餐單一模一樣嘅「可取餐 → 完成」流程。舊寫法
 * `isLocalPosOrder(order) && tableId === "counter"` 會令呢批單**唔入快餐 strip、
 * 冇可取餐掣**，收銀完全管唔到（只有線上訂單面板先見到）。
 *
 * ⚠️ 「本地／線上」嘅分工由 `isLocalOrTransferredDineIn()` 負責：
 * 線上 counter 單一律返 false → 唔會入「店內線下訂單」面板，唔會同枱面/返結流程撈埋。
 */
export function isQuickCounterOrder(order: PosOrder): boolean {
  return order.tableId === "counter";
}

/**
 * 快餐 counter 單：出餐階段（2026-09-12 修）。
 *
 * 🔴 呢個係「出餐階段」嘅**唯一真源** —— 判斷張單係「製作中」抑或「待取餐」只看
 * `fulfillmentStatus === "ready"`，**唔可以**用 `status === "paid"` 做前提。
 *
 * 歷史 bug（用戶 2026-09-12 反映：「撳咗『可取餐』狀態冇變、掣唔消失」）：
 * 舊寫法要求 `status === "paid" && fulfillmentStatus === "ready"` 才算待取餐，
 * 但快餐單有兩條合法路徑都會停在 `sent_to_kitchen`：
 *   ① 收銀台快餐單（source="pos"）落單後**未收款**就直接出餐（docs/87 §6.3 放寬閘門）；
 *   ② 自助單「先出餐後付款」。
 * 呢啲單撳「可取餐」之後 `fulfillmentStatus` 已經寫成 `ready`（本機 + 雲端都寫咗），
 * 但因為 `status` 仲係 `sent_to_kitchen`，UI 仍然歸類做「製作中」→ 表面睇完全冇反應，
 * 而 `updateQuickFulfillmentInStore()` 又係 idempotent（永遠寫 ready），所以撳幾多次都一樣。
 *
 * `ready` 係單向閘：`updateQuickFulfillmentInStore` / `markQuickOrderCompletedInStore` /
 * 餐飲 join 都只會寫入或保留 `ready`，冇任何地方會 reset 落 `preparing`。
 */
export function isQuickOrderReady(order: PosOrder): boolean {
  return order.fulfillmentStatus === "ready";
}

/**
 * 快餐單嘅「付款階段」標籤（2026-09-12 用戶要求：卡片 / 列表要同時顯示兩個狀態）。
 *
 * 快餐單有**兩個獨立維度**，唔可以壓成一粒藥丸：
 *   - 付款：`已結帳` / `未結帳`  ← 本函式
 *   - 出餐：`製作中` / `待取餐` / `已完成`  ← `getOrderStatusBadge()` / `quickCompletionLabel()`
 * 兩者可以任意組合（例如「未結帳 + 待取餐」＝先出餐後付款；「已結帳 + 製作中」＝正常快餐流程）。
 */
export function getPaymentBadge(order: PosOrder): OrderStatusBadge {
  const paid =
    order.status === "paid" ||
    order.status === "settled" ||
    order.status === "refunded" ||
    order.status === "partially_refunded";
  return paid
    ? { label: "已結帳", bgClass: "bg-emerald-50", textClass: "text-emerald-700", dotClass: "bg-emerald-500" }
    : { label: "未結帳", bgClass: "bg-slate-100", textClass: "text-slate-500", dotClass: "bg-slate-400" };
}

export function orderTimestamp(order: PosOrder): number {
  return Date.parse(order.updatedAt || order.createdAt || "") || 0;
}

/**
 * 🔴 **LWW 專用時間戳（2026-09-12）** —— 合併／比新舊**只可以用呢個**，唔可以用
 * `orderTimestamp()`。
 *
 * 點解：由雲端返嚟嘅單（`/api/pos/state` backfill 或 realtime push）嘅 `updatedAt` 係
 * **server 蓋章**嘅 `pos_orders.updated_at`（收件時間）；但本機寫入嘅 `updatedAt` 係
 * **iPad 自己嘅鐘**。兩個鐘域唔可以直接比 —— 一條「舊狀態、但 server 蓋章時間較新」
 * 嘅 snapshot 就會被當成「較新」而覆蓋本機啱寫入嘅狀態。
 *
 * 實案（2026-09-12 用戶反映）：快餐單結帳後（`status: "paid"` →「已結帳」）閃一下變返
 * 「未結帳」—— 本機寫入跟住 backfill / realtime echo 帶住舊狀態 + 較新 server 時間返嚟，
 * 合併就判舊 snapshot 贏。
 *
 * 雲端 row 一律帶 `client_updated_at`（= 寫入嗰部機嘅鐘），map 過嚟就係
 * `clientUpdatedAt`；Server 端 LWW（`/api/pos/sync`）一直都用同一把尺，
 * 所以 client 端必須對齊。冇 `clientUpdatedAt`（本機新建未上雲 / 舊 row）→ 退回
 * `updatedAt`（此時兩邊都係 client 鐘，仍然同域）。
 */
export function mergeTimestamp(order: PosOrder): number {
  const client = Date.parse(order.clientUpdatedAt || "");
  if (Number.isFinite(client) && client > 0) return client;
  return orderTimestamp(order);
}

/**
 * 付款階段已確實收到錢嘅狀態（快餐 counter 單嘅付款維度；亦覆蓋終態嘅收款結果）。
 *
 * ⚠️ 唔包括 `cancelled` / `reopened` —— 佢哋係「付款之後嘅另一種結局」，
 * 由 `isTerminalOrderStatus()` 同 LWW 處理（見 `mergeOrderLists()`）。
 */
export function isPaidOrderStatus(status: string | undefined): boolean {
  return (
    status === "paid" ||
    status === "settled" ||
    status === "refunded" ||
    status === "partially_refunded"
  );
}

/** 未收款嘅「活躍」狀態 —— 唯一兩種可以（錯誤地）覆蓋已收款單嘅 open 狀態。 */
function isOpenOrderStatus(status: string | undefined): boolean {
  return status === "draft" || status === "sent_to_kitchen";
}

/**
 * 由單號抽出排序 key：`(prefix, numeric)`。
 *
 * ⚠️ 2026-09-01 第二輪：原本呢個 helper 係畀 `compareOrderByLocalNo` 用嚟做
 * 「單號由小到大、createdAt 輔助」。但收銀實際工作流係「先下單先做」——
 * 跨 prefix（同日 自取01 / 外賣01）號碼會撞，純單號排會跳邊。
 * 已改為純 `createdAt` 排序，呢個 helper 暫時冇 caller（保留做 documenting reference）。
 * 之後如要改回單號排，復用返就得。
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function localOrderNoSortKey(order: PosOrder): { prefix: string; num: number } {
  const raw = (order.localOrderNo ?? "").trim();
  const matched = raw.match(/^(\D*?)(\d+)$/);
  if (!matched) return { prefix: raw, num: Number.NaN };
  return { prefix: matched[1], num: Number.parseInt(matched[2], 10) };
}

/**
 * 訂單顯示排序：**純下單時間（createdAt）由舊到新**。
 *
 * 「先下單先做」係收銀端最直覺嘅工作流：誰先落單、邊張先處理。
 *
 * 唔用單號做主 key：
  - 跨 prefix 嘅同日單號會撞（自取01 vs 外賣01 兩個都係 01），
    純單號排會跨 prefix 跳邊（用戶 2026-09-01 第二輪反映嘅「自取01 10:32
    排得比 取餐09 01:25 仲前」就係呢個 bug）。
 *
 * 唔用 `orderTimestamp`（即 updatedAt）：每次改狀態（出餐 / 可取餐 / 結帳）
 * 都 refresh `updatedAt` → 張單彈去最前，狀態一改就移位。
 *
 * `createdAt` 一落單就 stamped 之後唔再變 → 改狀態唔會移位，
 * 跨 prefix 用下單時間自動排好（誰先下單、邊個前），同收銀心模一致。
 */
export function compareOrderByLocalNo(a: PosOrder, b: PosOrder): number {
  const createdA = Date.parse(a.createdAt || "") || 0;
  const createdB = Date.parse(b.createdAt || "") || 0;
  if (createdA !== createdB) return createdA - createdB;
  // 同一刻落單（罕有：測試 fixture / batch import）→ id 分先後保證全序
  return String(a.id).localeCompare(String(b.id));
}

/**
 * 合併多份訂單列表，同 id 保留 updatedAt 較新者（防止雲端拉取覆蓋本機剛寫入的單）。
 *
 * B4（docs/56）：`localOrderNo` 係單號嘅本地真源（下單嗰陣由 server 序號或本地每日序號 stamped）。
 * realtime / backfill 合併時，若 server 版嘅 `localOrderNo` 同本機版唔同（例如 server 用緊
 * `row.id` fallback、本機用緊真正序號），唔可以讓 server 版覆寫本機版，否則 UI 同打印單會對唔上
 * （見「訂單8 vs 訂單84」bug）。所以當以 server 版取代本機版時，優先保留本機 `localOrderNo`。
 */
/**
 * 合併多份訂單列表，同 id 保留較新 / 較終局嘅版本。
 *
 * B4（docs/56）：`localOrderNo` 係單號嘅本地真源（下單嗰陣由 server 序號或本地每日序號 stamped）。
 * realtime / backfill 合併時，若 server 版嘅 `localOrderNo` 同本機版唔同（例如 server 用緊
 * `row.id` fallback、本機用緊真正序號），唔可以讓 server 版覆寫本機版，否則 UI 同打印單會對唔上
 * （見「訂單8 vs 訂單84」bug）。所以當以 server 版取代本機版時，優先保留本機 `localOrderNo`。
 *
 * 2026-09-09 終態優先（docs/桌台回退根因）：
 * 純粹用 updatedAt 做 LWW 唔夠——若某部裝置時鐘落後，佢發出嘅 ORDER_SETTLED 會帶舊
 * updatedAt，server 寫入後，另一部機 manual update 合併時會以本地「未結帳」snapshot（較新
 * timestamp）覆蓋 server「已結帳」版本，枱就會「回退」做未結。而家加入：
 *   - 終態單（settled / cancelled / refunded / partially_refunded）永遠贏過非終態單；
 *   - 除非本地已經係明確返結 reopened（終態 → reopened 係合法 reversal，由 timestamp 決定）。
 * 呢個改動唔影響正常 LWW，只係防時鐘偏移 / 離線重排導致終態被非終態覆蓋。
 *
 * 2026-09-12 兩項加固（用戶實案：快餐單「已結帳」閃一下變返「未結帳」）：
 *   (A) **同一鐘域**：LWW 比較改用 `mergeTimestamp()`（優先 `clientUpdatedAt`）。
 *       以前用 `orderTimestamp()`（即 `updatedAt`）—— 但雲端 row 嘅 `updatedAt` 係
 *       **server 蓋章**時間，同本機 iPad 嘅鐘唔同域，所以一條舊狀態 snapshot 只要
 *       server 收件時間較新就會「扮新」贏出，蓋走本機啱寫入嘅狀態。
 *   (B) **付款階段單向閘**：快餐 counter 單一旦 `paid`（或終態），唔可以再被
 *       `draft` / `sent_to_kitchen` 呢兩種**未收款** open 狀態覆蓋。
 *       同「`ready` 係單向閘」（見 `isQuickOrderReady()`）同一哲學 —— 已收到錢係事實，
 *       唔會因為一條時序亂咗 / 另一部機時鐘快咗嘅舊 snapshot 而「退返未收款」。
 *       ⚠️ 例外照舊：`reopened`（合法返結）同終態（`cancelled` / `refunded`）唔受此限 ——
 *       「取消結帳」（`cancelOrder`）走嘅係 `cancelled`（終態），唔係打返 open。
 */
export function mergeOrderLists(...sources: PosOrder[][]): PosOrder[] {
  const byId = new Map<string, PosOrder>();
  for (const list of sources) {
    for (const order of list) {
      const existing = byId.get(order.id);
      if (!existing) {
        byId.set(order.id, order);
        continue;
      }

      const incomingTerminal = isTerminalOrderStatus(order.status);
      const existingTerminal = isTerminalOrderStatus(existing.status);
      const incomingReopened = order.status === "reopened";
      const existingReopened = existing.status === "reopened";

      // 終態優先：任何來源話「已結帳／取消／退款」都應該贏過本地「未結」snapshot。
      // 唯一例外：本地已經明確返結 reopened（reopened 係終態 → open 嘅合法 reverse）。
      if (incomingTerminal && !existingTerminal && !existingReopened) {
        const merged =
          existing.localOrderNo && existing.localOrderNo !== order.localOrderNo
            ? { ...order, localOrderNo: existing.localOrderNo }
            : order;
        byId.set(order.id, merged);
        continue;
      }

      // 本地已終態，incoming 非終態又唔係 reopened → 舊非終態 snapshot 唔可以降級終態。
      if (existingTerminal && !incomingTerminal && !incomingReopened) {
        continue;
      }

      // (B) 付款階段單向閘：本地已收款（paid），incoming 係未收款 open snapshot →
      // 一律唔准降級（唔理 timestamp）。合法嘅「已收款 → 另一結局」只有：
      //   - 終態 cancelled / refunded（上面已處理，incoming 係終態會贏）；
      //   - reopened（返結，唔喺呢個分支，落 LWW 由 timestamp 決定）。
      if (isPaidOrderStatus(existing.status) && isOpenOrderStatus(order.status)) {
        continue;
      }
      // 反向：incoming 已收款、本地仲係 open → 收款係前進，唔准被本地舊 open 拖返（即使
      // incoming 時戳較舊，例如 iPad 鐘偏慢）。同樣保留本機 localOrderNo（B4）。
      if (isOpenOrderStatus(existing.status) && isPaidOrderStatus(order.status)) {
        const merged =
          existing.localOrderNo && existing.localOrderNo !== order.localOrderNo
            ? { ...order, localOrderNo: existing.localOrderNo }
            : order;
        byId.set(order.id, merged);
        continue;
      }

      // 其他情況維持 LWW：時間戳較新者勝出（包括 reopened 合法 reverse、同一單多次更新）。
      // (A) 用 mergeTimestamp()（client 鐘域）—— 唔可以用 orderTimestamp()（混了 server 蓋章時間）。
      const incomingTs = mergeTimestamp(order);
      const existingTs = mergeTimestamp(existing);
      if (incomingTs > existingTs || (incomingTs === existingTs && incomingReopened && !existingReopened)) {
        const merged =
          existing.localOrderNo && existing.localOrderNo !== order.localOrderNo
            ? { ...order, localOrderNo: existing.localOrderNo }
            : order;
        byId.set(order.id, merged);
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) => mergeTimestamp(b) - mergeTimestamp(a));
}

export function isWithinLastMinutes(order: PosOrder, minutes: number, nowMs = Date.now()): boolean {
  const ts = orderTimestamp(order);
  if (!ts) return false;
  return ts >= nowMs - minutes * 60 * 1000;
}

function isTerminalLocalOrder(order: PosOrder): boolean {
  return (
    order.status === "cancelled" ||
    order.status === "refunded" ||
    order.status === "partially_refunded" ||
    order.status === "settled"
  );
}

/** 匯出：終態訂單狀態（已取消 / 已退款 / 部分退款 / 已完成）。backfill / realtime 合併時，
 * 伺服器單邊嘅終態單唔可以復活入活躍工作列表（見 docs/52）。 */
export function isTerminalOrderStatus(status: string | undefined): boolean {
  return (
    status === "cancelled" ||
    status === "refunded" ||
    status === "partially_refunded" ||
    status === "settled"
  );
}

/**
 * 舊 open 單最大年齡（由 updatedAt 計）。超過呢個時間、且本機無嘅 server 單邊 open 單，
 * 經 backfill / realtime 唔可以復活 occupy 枱（見 docs/68）。預設 1 日——即「今日」嘅單
 * （含 kiosk 即時新單）照常拉到；舊到昨日或之前嘅 open 單（卡住未結帳 / 落單冇成功 / 冇落單）
 * 唔會再 occupy 空枱。可視需要調大（例如 2 日）。
 */
export const STALE_OPEN_ORDER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * backfill / realtime 合併後嘅「防復活」過濾（docs/52 + docs/68）：
 *  - 本機已真刪除嘅訂單（deletedOrderIds tombstone）一律唔顯示；
 *  - 伺服器單邊嘅終態單（cancelled / refunded / partially_refunded / settled）唔可以復活入活躍列表，
 *    除非本機 localStorage 已經有佢（留返本地對賬 tab 睇）；
 *  - 伺服器單邊嘅 open 單（draft / sent_to_kitchen / paid / reopened）若本機無、且 updatedAt
 *    超過 STALE_OPEN_ORDER_MAX_AGE_MS → 當 stale 唔復活（docs/68：結帳後 backfill 唔會再拉舊單
 *    occupy 空枱）。今日嘅 open 單（含 kiosk 即時新單）updatedAt 夠新，照常通過。
 * localOrders = 本地持久化 store（loadOrders()），用嚟判斷「本機已有」（本機有嘅單永遠保留，唔理年齡）。
 */
export function filterResurrectedOrders(
  orders: PosOrder[],
  deletedOrderIds: string[],
  localOrders: PosOrder[],
  /** 額外要剔除嘅 id（2026-09-09 方案 A：隔離區孤兒單，merge / realtime 唔准復活）。 */
  excludedOrderIds: string[] = [],
): PosOrder[] {
  const deleted = new Set(deletedOrderIds);
  const excluded = new Set(excludedOrderIds);
  const localIds = new Set(localOrders.map((o) => o.id));
  const now = Date.now();
  return orders.filter((o) => {
    if (deleted.has(o.id)) return false;
    if (excluded.has(o.id)) return false;
    // 終態單：server 單邊唔可以復活（docs/52）
    if (isTerminalOrderStatus(o.status) && !localIds.has(o.id)) return false;
    // 舊 open 單：server 單邊 + 本機無 + 超過 1 日 → 唔復活（docs/68）
    if (!isTerminalOrderStatus(o.status) && !localIds.has(o.id)) {
      const ts = orderTimestamp(o);
      if (ts > 0 && now - ts > STALE_OPEN_ORDER_MAX_AGE_MS) return false;
    }
    return true;
  });
}

/** 快餐點餐頁底部：所有未完成的 counter 單（不限時間） */
export function isActionableQuickOrder(order: PosOrder): boolean {
  if (!isQuickCounterOrder(order)) return false;
  if (isTerminalLocalOrder(order)) return false;
  if (order.status === "paid" && order.fulfillmentStatus === "ready") return true;
  return order.status === "draft" || order.status === "sent_to_kitchen" || order.status === "paid";
}

export function filterQuickActionBarOrders(orders: PosOrder[]): PosOrder[] {
  // 單號由小到大（compareOrderByLocalNo），唔係 updatedAt 新→舊：
  // 否則一改狀態（出餐 / 可取餐）張單就彈去最前，收銀會撳錯單。
  return orders.filter(isActionableQuickOrder).sort(compareOrderByLocalNo);
}

export function localOrderStatusLabel(order: PosOrder): string {
  if (isQuickCounterOrder(order)) {
    // 出餐階段只看 fulfillmentStatus（見 isQuickOrderReady 註解）：唔可以再要求 status=paid。
    // ⚠️ 但只限「進行中」嘅快餐單（sent_to_kitchen / paid）—— 已取消 / 已退款 / 已返結
    // 呢啲終態單，就算 DB 殘留 fulfillment_status='ready' 都唔可以被講成「待取餐」，
    // 一律落下面 switch 保持原有口徑（堂食單行唔到呢個分支，完全唔受影響）。
    const isOpenQuick = order.status === "sent_to_kitchen" || order.status === "paid";
    if (isOpenQuick && isQuickOrderReady(order)) return quickCompletionLabel(order);
    if (isOpenQuick) return "製作中";
  }
  if (order.status === "draft") return "點單中";
  if (order.status === "sent_to_kitchen") return "製作中";
  if (order.status === "paid" && order.fulfillmentStatus === "ready") return "待取餐";
  if (order.status === "paid") return "已付款";
  if (order.status === "settled") return "已完成";
  if (order.status === "reopened") return "已返結";
  if (order.status === "cancelled") return "已取消";
  if (order.status === "refunded" || order.status === "partially_refunded") return "已退款";
  return order.status;
}

/**
 * 訂單狀態標籤嘅視覺 token（label + Tailwind classes），統一顏色編碼方便商家一眼辨識。
 * 用法：
 *   const b = getOrderStatusBadge(order);
 *   <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${b.bgClass} ${b.textClass}`}>{b.label}</span>
 * 配色：草稿=slate、製作中=amber、已付=blue、待取餐=sky/cyan、已完成=emerald、已取消=slate-300、
 *      已退款=red、部分退款=orange、已返結=indigo。
 */
export interface OrderStatusBadge {
  label: string;
  bgClass: string;
  textClass: string;
  dotClass: string;
}

export function getOrderStatusBadge(order: PosOrder): OrderStatusBadge {
  // 快餐 counter：settled=已完成；進行中（sent_to_kitchen / paid）+ ready = 待取餐／待出餐／待交付
  // （唔理付咗款未）；其餘 draft / 終態落下面 switch，保持原本口徑。
  // ⚠️ 只改快餐分支 —— 堂食單（真枱號）行唔到入嚟，狀態口徑完全不變。
  if (isQuickCounterOrder(order)) {
    if (order.status === "settled") {
      return { label: "已完成", bgClass: "bg-emerald-50", textClass: "text-emerald-700", dotClass: "bg-emerald-500" };
    }
    const isOpenQuick = order.status === "sent_to_kitchen" || order.status === "paid";
    if (isOpenQuick && isQuickOrderReady(order)) {
      return { label: quickCompletionLabel(order), bgClass: "bg-sky-50", textClass: "text-sky-700", dotClass: "bg-sky-500" };
    }
    if (isOpenQuick) {
      return { label: "製作中", bgClass: "bg-amber-50", textClass: "text-amber-700", dotClass: "bg-amber-500" };
    }
  }
  switch (order.status) {
    case "draft":
      return { label: "點單中", bgClass: "bg-slate-100", textClass: "text-slate-700", dotClass: "bg-slate-500" };
    case "sent_to_kitchen":
      return { label: "製作中", bgClass: "bg-amber-50", textClass: "text-amber-700", dotClass: "bg-amber-500" };
    case "paid":
      if (order.fulfillmentStatus === "ready") {
        return { label: "待取餐", bgClass: "bg-sky-50", textClass: "text-sky-700", dotClass: "bg-sky-500" };
      }
      return { label: "已付款", bgClass: "bg-blue-50", textClass: "text-blue-700", dotClass: "bg-blue-500" };
    case "settled":
      return { label: "已完成", bgClass: "bg-emerald-50", textClass: "text-emerald-700", dotClass: "bg-emerald-500" };
    case "cancelled":
      return { label: "已取消", bgClass: "bg-slate-200", textClass: "text-slate-600", dotClass: "bg-slate-400" };
    case "refunded":
      return { label: "已退款", bgClass: "bg-red-50", textClass: "text-red-700", dotClass: "bg-red-500" };
    case "partially_refunded":
      return { label: "部分退款", bgClass: "bg-orange-50", textClass: "text-orange-700", dotClass: "bg-orange-500" };
    case "reopened":
      return { label: "已返結", bgClass: "bg-indigo-50", textClass: "text-indigo-700", dotClass: "bg-indigo-500" };
    default:
      return { label: String(order.status), bgClass: "bg-slate-100", textClass: "text-slate-700", dotClass: "bg-slate-500" };
  }
}

export type LocalOrderPanelTab = "all" | "preparing" | "ready" | "settled" | "reopened" | "cancelled";

export function matchesLocalOrderPanelTab(order: PosOrder, tab: LocalOrderPanelTab): boolean {
  if (tab === "all") return true;
  if (tab === "settled") return order.status === "settled";
  if (tab === "reopened") return order.status === "reopened";
  if (tab === "cancelled") {
    return order.status === "cancelled" || order.status === "refunded" || order.status === "partially_refunded";
  }
  if (tab === "ready") {
    // 2026-09-12：只看出餐階段（ready），唔再要求 status=paid ——
    // 否則「先出餐後付款 / 未收款先出餐」嘅快餐單撳完可取餐仍然停留喺「製作中」分頁。
    // ⚠️ 只認進行中嘅快餐單：已取消 / 已退款 / 已返結就算殘留 fulfillment_status='ready'
    // 都唔可以入「待取餐」分頁（終態優先）。非快餐（堂食）單完全唔受影響。
    return (
      isQuickCounterOrder(order) &&
      (order.status === "sent_to_kitchen" || order.status === "paid") &&
      isQuickOrderReady(order)
    );
  }
  if (tab === "preparing") {
    if (isQuickCounterOrder(order)) {
      // 草稿單永遠留喺「製作中」分頁（未落單，就算殘留 ready 都唔應該消失）。
      if (order.status === "draft") return true;
      return (
        (order.status === "sent_to_kitchen" || order.status === "paid") && !isQuickOrderReady(order)
      );
    }
    return order.status === "draft" || order.status === "sent_to_kitchen";
  }
  return true;
}
