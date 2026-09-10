import type { PosOrder } from "../types";

/**
 * 自助單「新訂單提示」嘅**資料模型 + 純函式**（2026-09-10 需求；docs/115 擴充至 kiosk）。
 *
 * 「自助單」= 客人自己落嘅單，即 `source ∈ {kiosk, scan}`（見 `lib/pos/order-source.ts`）：
 *   - `kiosk` 自助點餐機（平板 `/order`）
 *   - `scan`  客人掃碼（堂食 `/menu` 逐枱一碼 / 快餐 `/quick` 全店一碼）
 * 三者都會喺收銀機右上角彈提示，撳一下跳去睇該張單。
 *
 * 呢度零依賴（只讀 `PosOrder` 型別），所以可以直接用 `node --test` 單元測試 ——
 * 去重、上限、狀態轉換呢幾條規則全部係「靜默錯就出事」嘅地方（例如重複 push 會令
 * 收銀見到兩個一樣嘅提示；上限失效會令右上角永遠遮住畫面）。
 *
 * UI 喺 `src/components/self-order-notice-stack.tsx`；持久化喺 `src/lib/storage.ts`
 * （store-scope key `self-order-notices`）。**唔會自動消失**：只有
 * `dismissSelfOrderNotice()`（向右滑）或 `openSelfOrderNotice()`（撳 → 跳去睇單）
 * 會令一個項目消失。
 */
export type SelfOrderNotice = {
  orderId: string;
  tableId: string;
  /** 落單當時嘅台名（例如 `A02`）。顯示時優先讀訂單即時值，呢個係 fallback。 */
  tableName: string;
  /** 收到提示嘅時間（ISO）。 */
  createdAt: string;
  /** 用戶撳過、但當時張單已經結帳／已失效 → 顯示「已結帳」文案（需求 5）。 */
  settledAt?: string;
};

/** 渲染用（UI 層只需要呢三個欄位）。 */
export type SelfOrderNoticeItem = {
  orderId: string;
  /**
   * **顯示標識**（唔一定係台名）：
   * - 有真枱 → 台名（例如 `A02`）
   * - 冇枱（`counter`：自助點餐機 / 快餐掃碼）→ **單號**（例如 `自取01`）
   */
  tableName: string;
  /** 該訂單已結帳／已失效 → 顯示「已結帳」文案（需求 5）。 */
  settled: boolean;
};

/**
 * 未處理提示上限。
 *
 * 正常情況由用戶清走，唔應該撞到上限；呢個 cap 純粹係防禦 —— 若商家長期唔理，
 * 提示會無限累積並令右上角永遠遮住畫面。超出時**由最舊開始丟**（保留最新嘅，
 * 因為最新嘅最需要即刻處理）。
 */
export const MAX_SELF_ORDER_NOTICES = 20;

/**
 * 收到掃碼新單 → 加入提示。
 *
 * 同 `orderId` **去重**（realtime 重送／重複訂閱唔應該變兩個提示）。
 * 回傳同一個 reference 代表「冇變」（React 可以據此跳過 re-render / 唔用寫 localStorage）。
 */
export function addSelfOrderNotice(
  list: SelfOrderNotice[],
  order: Pick<PosOrder, "id" | "tableId" | "tableName">,
  nowIso: string,
): SelfOrderNotice[] {
  if (list.some((notice) => notice.orderId === order.id)) return list;
  const next: SelfOrderNotice[] = [
    ...list,
    {
      orderId: order.id,
      tableId: order.tableId ?? "",
      tableName: order.tableName ?? "",
      createdAt: nowIso,
    },
  ];
  return next.length > MAX_SELF_ORDER_NOTICES ? next.slice(-MAX_SELF_ORDER_NOTICES) : next;
}

/** 用戶撳完（已跳去桌台）或向右滑 → 移除。揾唔到就原樣回傳（唔會產生多餘寫入）。 */
export function dismissSelfOrderNotice(list: SelfOrderNotice[], orderId: string): SelfOrderNotice[] {
  const next = list.filter((notice) => notice.orderId !== orderId);
  return next.length === list.length ? list : next;
}

/**
 * 需求 5：用戶撳嗰陣發現訂單**已經結帳** → 標記為「已結帳」狀態。
 *
 * 注意**唔會**移除：需求要求「顯示訊息說明該訂單已結帳」，所以要留住個提示（灰底、
 * 文案改成「已結帳 / 此單已完成，可略過」），等用戶自己滑走 —— 咁樣訊息先唔會一閃即逝。
 */
export function markSelfOrderNoticeSettled(
  list: SelfOrderNotice[],
  orderId: string,
  nowIso: string,
): SelfOrderNotice[] {
  return list.map((notice) =>
    notice.orderId === orderId && !notice.settledAt ? { ...notice, settledAt: nowIso } : notice,
  );
}

/**
 * 併上「訂單最新狀態」供 UI 渲染。
 *
 * - **顯示標識**：有真枱（`tableId` 存在且唔係 `counter`）→ 台名（例如 `A02`，
 *   枱名可能被改，所以優先讀訂單即時值）；
 *   冇枱（`counter`：自助點餐機 / **快餐掃碼**）→ **單號**（例如 `自取01`）。
 *   為何唔一律用 `tableName`：快餐單嘅 `tableName` 全部係「自取」，
 *   幾張單嘅提示一模一樣，收銀根本分唔清邊張打邊張（docs/115 G4/G5）。
 * - `settled`：已經標記過、或者訂單已經結帳／已經唔存在（另一部機結咗、或者被刪）。
 *
 * `isSettled` 由呼叫方注入（`isTerminalOrderStatus`）—— 令呢個模組維持零依賴、可測試。
 */
export function toSelfOrderNoticeItems(
  notices: SelfOrderNotice[],
  orders: Array<
    Pick<PosOrder, "id" | "tableId" | "tableName" | "status"> & { localOrderNo?: string | null }
  >,
  isSettled: (order: Pick<PosOrder, "status">) => boolean,
): SelfOrderNoticeItem[] {
  return notices.map((notice) => {
    const order = orders.find((o) => o.id === notice.orderId) ?? null;
    const hasRealTable = Boolean(order?.tableId) && order?.tableId !== "counter";
    const label = hasRealTable
      ? order?.tableName || notice.tableName || "本枱"
      : order?.localOrderNo || notice.tableName || "本單";
    return {
      orderId: notice.orderId,
      tableName: label,
      settled: Boolean(notice.settledAt) || !order || isSettled(order),
    };
  });
}
