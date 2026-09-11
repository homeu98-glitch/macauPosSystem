"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { SelfOrderNoticeItem } from "@/lib/pos/self-order-notice";

/**
 * 右上角「自助單新訂單」提示堆疊（2026-09-10 需求；docs/115 擴充至 kiosk）。
 *
 * 涵蓋 `source ∈ {kiosk, scan}`：自助點餐機（平板 `/order`）、堂食掃碼（`/menu`，逐枱一碼）、
 * 快餐掃碼（`/quick`，全店一碼）。
 *
 * ## 行為規格（同需求逐條對應）
 *
 * 1. **唔會自動消失** —— 冇任何 timer；只有 `onOpen`（撳）或 `onDismiss`（向右滑）先移除。
 * 2. **撳 → 喺當前點餐頁面顯示該張單**（由父層 `onOpen` 實作）：有枱 → 該桌台工作台；
 *    冇枱（自助機 / 快餐）→ **留在點餐頁面**，把該張訂單卡圈住 + 捲入視線
 *    （2026-09-11 用戶修訂：唔再跳去 `/orders` 開「查看」彈窗）。
 * 3. **向右滑 → 關閉／略過**（下方 `SwipeAwayCard`）。
 * 4. **多筆 = 多個獨立彈窗** —— 呢度係 list，每張單一個卡片，各自可獨立撳／滑；
 *    全部未處理前都會留喺畫面（垂直排列，超高就自己滾動）。
 * 5. **已結帳** —— 由父層決定 `settled: true` 時卡片轉為「已結帳」文案（唔會自動消失）。
 * 6. **文案**：第一行「{顯示標識} 已下單」、第二行「請查看」。
 *    ⚠️ 顯示標識唔一定係台名：冇枱嘅單（自助機 / 快餐）顯示**單號**，
 *       否則幾張單都會寫「自取 已下單」，收銀分唔清邊張（見 `self-order-notice.ts`）。
 *
 * ## 為何要自己寫 swipe（唔用 library）
 *
 * 需求只要「向右拖走」一個手勢，用 Pointer Events 十幾行就搞完，唔值得為咗佢拉一個
 * gesture library 入 bundle。重點係 `touch-action: pan-y` —— 水平手勢由我哋處理，
 * 垂直仍然交返瀏覽器（唔會令收銀喺 iPad 上滑唔到個 list）。
 */

/** 拖到幾遠先當「略過」（px）。太細會誤觸，太大會覺得拖唔走。 */
const SWIPE_DISMISS_PX = 64;

/** 超過呢個位移就當「拖緊」，release 後唔可以觸發 click（防拖完又跳頁）。 */
const DRAG_SLOP_PX = 8;

function SwipeAwayCard({
  item,
  onOpen,
  onDismiss,
}: {
  item: SelfOrderNoticeItem;
  onOpen: (orderId: string) => void;
  onDismiss: (orderId: string) => void;
}) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef<number | null>(null);
  /** 今次 pointer 序列有冇真正拖過（決定 release 後要唔要吞咗 click）。 */
  const movedRef = useRef(false);

  function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    // 只認主鍵（右鍵／中鍵唔應該開始拖）
    if (event.pointerType === "mouse" && event.button !== 0) return;
    startXRef.current = event.clientX;
    movedRef.current = false;
    setDragging(true);
    // 捕獲指標：手指／mouse 移出卡片都仲收得到 move / up
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    if (startXRef.current === null) return;
    const delta = event.clientX - startXRef.current;
    if (Math.abs(delta) > DRAG_SLOP_PX) movedRef.current = true;
    // 只准向右：向左拖唔應該令提示飛出左邊（左邊係側欄）
    setDx(Math.max(0, delta));
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    if (startXRef.current === null) return;
    const delta = Math.max(0, event.clientX - startXRef.current);
    startXRef.current = null;
    setDragging(false);
    if (delta >= SWIPE_DISMISS_PX) {
      // 標記為已拖動，確保跟住嘅 click 唔會又跳去桌台
      movedRef.current = true;
      setDx(0);
      onDismiss(item.orderId);
      return;
    }
    setDx(0); // 唔夠遠 → 彈返原位
  }

  function handlePointerCancel() {
    startXRef.current = null;
    setDragging(false);
    setDx(0);
  }

  return (
    <button
      aria-label={
        item.settled
          ? `${item.tableName} 嘅訂單已結帳，向右滑可略過此提示`
          : `${item.tableName} 已下單，撳一下查看；向右滑可略過`
      }
      className={`pointer-events-auto w-40 rounded-xl px-3 py-2 text-left text-white shadow-lg ${
        item.settled ? "bg-slate-500" : "bg-orange-500"
      } ${dragging ? "" : "transition-transform duration-150"} ${
        item.settled ? "" : "hover:bg-orange-600"
      }`}
      onClick={() => {
        // 拖過就唔當 click（唔好「拖完又跳頁」）
        if (movedRef.current) return;
        onOpen(item.orderId);
      }}
      onPointerCancel={handlePointerCancel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{
        transform: `translateX(${dx}px)`,
        opacity: dx > 0 ? Math.max(0.25, 1 - dx / (SWIPE_DISMISS_PX * 2.5)) : 1,
        // 水平手勢我哋處理，垂直交返瀏覽器（iPad 上唔會鎖死頁面滾動）
        touchAction: "pan-y",
      }}
      title={item.settled ? "訂單已結帳 · 向右滑可略過" : "撳一下查看 · 向右滑可略過"}
      type="button"
    >
      <div className="truncate text-sm font-bold">
        {item.settled ? `${item.tableName} 已結帳` : `${item.tableName} 已下單`}
      </div>
      <div className="mt-0.5 text-xs font-medium text-white/90">
        {item.settled ? "此單已完成，可略過" : "請查看"}
      </div>
    </button>
  );
}

export function SelfOrderNoticeStack({
  items,
  onOpen,
  onDismiss,
}: {
  items: SelfOrderNoticeItem[];
  onOpen: (orderId: string) => void;
  onDismiss: (orderId: string) => void;
}) {
  if (items.length === 0) return null;
  /*
   * 何時容器自己要食 pointer：超過 5 個提示就好大機會超出 70dvh（每個約 64px），
   * 需要可以滾動先攞得到最舊嗰個。≤5 個（需求講嘅場景）時容器維持 `pointer-events-none`，
   * 完全唔會擋住下面任何嘢；卡片自己永遠 `pointer-events-auto`。
   */
  const scrollable = items.length > 5;
  return (
    /*
     * 位置：固定喺右上角（`right-4`），但垂直方向落 `top-20` —— 因為桌台總覽嘅工具列
     * （手動更新 / 同步健康 / 查看線上訂單）正正喺 `top-4` 右邊，提示疊上去會撳唔到掣。
     */
    <div
      className={`fixed right-4 top-20 z-50 flex max-h-[70dvh] w-40 flex-col gap-2 overflow-y-auto ${
        scrollable ? "pointer-events-auto bg-slate-900/5 p-1" : "pointer-events-none"
      }`}
    >
      {items.map((item) => (
        <SwipeAwayCard item={item} key={item.orderId} onDismiss={onDismiss} onOpen={onOpen} />
      ))}
    </div>
  );
}
