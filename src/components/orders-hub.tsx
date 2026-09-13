"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { DateRangeFilterChips } from "@/components/date-range-filter-chips";
import { LocalOrdersPanel } from "@/components/local-orders-panel";
import { OnlineOrders } from "@/components/online-orders";
import { downloadCsv } from "@/lib/csv-export";
import {
  dateFilterLabel,
  LEDGER_ORDER_DATE_FILTERS,
  type LedgerOrderDateFilterKey,
} from "@/lib/ledger/order-date-filter";
import { customRangeLabel, type CustomDateRange } from "@/lib/ledger/date-range";
import { formatMacauDateTime } from "@/lib/format";
import type { LedgerOnlineOrder } from "@/lib/ledger/order-mapper";
import {
  getOrderStatusBadge,
  getPaymentBadge,
} from "@/lib/pos-order-filters";
import type { PosOrder } from "@/lib/types";

/** 今日嘅 Macau 日曆日（`YYYY-MM-DD`），用於匯出檔名。 */
function todayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Macau" }).format(new Date());
}

/**
 * 訂單頁（`/orders`）：上＝會員通線上訂單，下＝店內線下訂單。
 *
 * ## 時間篩選（2026-09-13 加「自訂」）
 *
 * 由原本純 key 字串升級為 **`{ key, custom }` selection**：
 * - key 負責 chip 高亮同快速區間；
 * - `custom` 只在 `key === "custom"` 時有意義（`YYYY-MM-DD` 起訖，Macau 日曆）。
 *
 * 呢個 state 由兩張表共用（`OnlineOrders` 同 `LocalOrdersPanel` 都吃同一個 prop），
 * 所以撳一次 chips，上面線上單同下面線下單會**同時**跟隨。
 *
 * ## Deep link（2026-09-10，docs/115 G5）
 *
 * `/orders?orderId=<id>` 會即刻開該張單嘅「查看」彈窗。來源：收銀機右上角嘅
 * 自助單提示（`pos-app.openSelfOrderNotice` —— 自助點餐機 / 快餐掃碼單冇枱可跳，
 * 所以要跳嚟呢度睇單）。
 *
 * ⚠️ 用 `window.location.search` 而**唔用** `useSearchParams()`：後者喺 App Router 下
 * 需要 `<Suspense>` 包住，否則靜態生成階段會報錯；而呢個 deep link 只係一次性入頁動作，
 * 唔需要參與 hydration / 訂閱。讀完即刻 `replaceState` 清走 query，
 * 免得用戶刷新 / 撳返回時又彈一次。
 */
export function OrdersHub() {
  const [dateFilter, setDateFilter] = useState<LedgerOrderDateFilterKey>("today");
  const [customRange, setCustomRange] = useState<CustomDateRange | null>(null);
  const [focusOrderId, setFocusOrderId] = useState<string | null>(null);

  /**
   * 兩張表當前篩選後嘅資料（由子元件上報）。
   *
   * 匯出必須以「商家當前所選時間範圍」為準 —— 而 tab / 狀態篩選亦同樣影響列表顯示，
   * 所以直接複用子元件已算好嘅 `filteredOrders`，而**唔喺呢度另計一次**
   * （另計 = 兩套 predicate，遲早漂移；呢個係專案既有教訓）。
   */
  const [onlineRows, setOnlineRows] = useState<LedgerOnlineOrder[]>([]);
  const [localRows, setLocalRows] = useState<PosOrder[]>([]);

  /**
   * 傳落兩張表嘅 selection（key + 已套用嘅自訂區間）。
   *
   * 🔴 2026-09-13（實案：「點完訂單後按其他頁面完全冇反應」）—— **必須 `useMemo`**。
   *
   * `OnlineOrders` / `LocalOrdersPanel` 兩邊都係：
   *   `filteredOrders = useMemo(..., [dateFilter, ...])`
   *   → `useEffect(() => onFilteredOrdersChange(filteredOrders), [filteredOrders])`
   *   → 回報畀呢個父層 `setOnlineRows` / `setLocalRows`。
   *
   * 如果呢度每次都新建 `{ key, custom }`（新 ref），`Object.is` 永遠唔相等 →
   * 子層 useMemo 每次都重算 → `filteredOrders` 新陣列 ref → effect 又 fire →
   * `setState` → 父層 re-render → 再建新物件……**無限循環**，主執行緒被鎖死，
   * 成個 tab（連側欄）都撳唔到。呢個唔係「導航失效」，係 render 死循環。
   */
  const dateSelection = useMemo(
    () => ({ key: dateFilter, custom: customRange }),
    [dateFilter, customRange],
  );

  const handleDateChange = useCallback((key: LedgerOrderDateFilterKey, custom: CustomDateRange | null) => {
    setDateFilter(key);
    setCustomRange(custom);
  }, []);

  /** 當前範圍嘅人話標籤（用於檔名）。 */
  const rangeLabel = customRange && dateFilter === "custom" ? customRangeLabel(customRange) : dateFilterLabel(dateFilter);

  /**
   * 匯出**線上訂單** CSV。
   *
   * ⚠️ 客人電話（`order.phone`）：
   * - 來源係 Ledger RPC `list_merchant_orders` 回傳嘅 `customer_phone`，只存在記憶體。
   * - **唔會**寫入 POS DB / localStorage / console（Ledger 契約 §7.2 個資紅線）。
   * - 呢度直接落 CSV ＝ 超出「當次 UI 渲染」嘅範圍，已記錄待與 Ledger 確認
   *   （見 docs/113）。Ledger 未回覆前如要收緊，只需移除 `客人電話` 一欄。
   */
  function exportOnlineCsv() {
    const rows = onlineRows.map((o) => ({
      單號: o.pickupCode ? `取餐碼 ${o.pickupCode}` : o.id.slice(0, 8),
      客人: o.customerName ?? "",
      客人電話: o.phone ?? "",
      類型: o.tabType === "dine_in" ? "堂食" : o.tabType === "pickup" ? "外賣自取" : "外送",
      菜品: o.itemSummary ?? "",
      數量: o.itemCount ?? "",
      金額: o.total,
      折扣: o.discountAmount ?? "",
      狀態: o.status,
      付款狀態: o.paymentStatus === "paid" ? "已付款" : "未付款",
      付款方式: o.paymentMode ?? "",
      下單時間: o.createdAt ? formatMacauDateTime(o.createdAt) : "",
      更新時間: o.updatedAt ? formatMacauDateTime(o.updatedAt) : "",
      備註: o.note ?? "",
      外送地址: o.deliveryAddress ?? "",
    }));
    downloadCsv(rows, `線上訂單_${rangeLabel}_${todayKey()}`, {
      columns: [
        { key: "單號", label: "單號" },
        { key: "客人", label: "客人" },
        { key: "客人電話", label: "客人電話" },
        { key: "類型", label: "類型" },
        { key: "菜品", label: "菜品" },
        { key: "數量", label: "數量" },
        { key: "金額", label: "金額(MOP)" },
        { key: "折扣", label: "折扣(MOP)" },
        { key: "狀態", label: "狀態" },
        { key: "付款狀態", label: "付款狀態" },
        { key: "付款方式", label: "付款方式" },
        { key: "下單時間", label: "下單時間" },
        { key: "更新時間", label: "更新時間" },
        { key: "備註", label: "備註" },
        { key: "外送地址", label: "外送地址" },
      ],
    });
  }

  /** 匯出**線下訂單** CSV（店內落單，冇客人電話欄位 —— PosOrder 本身唔存）。 */
  function exportLocalCsv() {
    const rows = localRows.map((o) => ({
      單號: o.localOrderNo,
      餐台: o.tableName ?? "",
      渠道: o.onlineOrderId ? "線上" : "線下",
      來源: o.status === "draft" ? "未送廚房" : "",
      菜品: o.items
        .filter((it) => !it.voided)
        .map((it) => `${it.name}×${it.quantity}`)
        .join(" / "),
      入座人數: o.partySize ?? "",
      金額: o.total,
      折扣: o.discountAmount ?? "",
      狀態: getOrderStatusBadge(o).label,
      付款: getPaymentBadge(o).label,
      支付方式: o.paymentMethod ?? "",
      下單時間: o.createdAt ? formatMacauDateTime(o.createdAt) : "",
      結帳時間: o.updatedAt ? formatMacauDateTime(o.updatedAt) : "",
    }));
    downloadCsv(rows, `線下訂單_${rangeLabel}_${todayKey()}`, {
      columns: [
        { key: "單號", label: "單號" },
        { key: "餐台", label: "餐台" },
        { key: "渠道", label: "渠道" },
        { key: "來源", label: "來源" },
        { key: "菜品", label: "菜品" },
        { key: "入座人數", label: "入座人數" },
        { key: "金額", label: "金額(MOP)" },
        { key: "折扣", label: "折扣(MOP)" },
        { key: "狀態", label: "狀態" },
        { key: "付款", label: "付款" },
        { key: "支付方式", label: "支付方式" },
        { key: "下單時間", label: "下單時間" },
        { key: "結帳時間", label: "結帳時間" },
      ],
    });
  }

  useEffect(() => {
    const orderId = new URLSearchParams(window.location.search).get("orderId");
    if (!orderId) return;
    setFocusOrderId(orderId);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  return (
    <div className="h-[100dvh] overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="flex h-[100dvh] flex-col overflow-hidden md:pl-[72px]">
        <header className="shrink-0 border-b border-slate-200 bg-white px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-lg font-semibold text-slate-900">訂單</div>
              <div className="mt-0.5 text-sm text-slate-500">上：會員通線上訂單 · 下：店內線下訂單</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <DateRangeFilterChips
                options={LEDGER_ORDER_DATE_FILTERS}
                value={dateFilter}
                custom={customRange}
                onChange={handleDateChange}
              />
              {/* 匯出：分兩檔（線上／線下欄位差異大，混一個檔會大量空格） */}
              <div className="flex items-center gap-1.5">
                <button
                  className="inline-flex min-h-[36px] items-center rounded-full bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                  disabled={onlineRows.length === 0}
                  onClick={exportOnlineCsv}
                  title="匯出當前時間範圍內嘅線上訂單（含客人電話）"
                  type="button"
                >
                  匯出線上單（{onlineRows.length}）
                </button>
                <button
                  className="inline-flex min-h-[36px] items-center rounded-full bg-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-300 disabled:opacity-50"
                  disabled={localRows.length === 0}
                  onClick={exportLocalCsv}
                  title="匯出當前時間範圍內嘅線下訂單"
                  type="button"
                >
                  匯出線下單（{localRows.length}）
                </button>
              </div>
            </div>
          </div>
        </header>
        {/*
          列表版面（2026-09-10）：由左右分欄改為上下分區、每區全寬。
          原因：訂單列表每個 8 欄（單號／餐台／時間／菜品／金額／狀態／來源·支付／操作），
          半欄寬度會逼爆欄位；全寬先可以做到金額右對齊 + 操作釘右。
          響應式（2026-09-10 修）：兩個表都改用「`table-fixed` + 百分比欄寬」自適應容器闊度，
          所以正常 iPad／桌面闊度下唔會再出現橫向滾動，亦唔會剪走「操作」欄；
          只有容器窄過表格下限（<860px，例如手機）先由各表自己橫向滾動。
        */}
        <div className="grid min-h-0 flex-1 grid-rows-2 divide-y divide-slate-200">
          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-slate-50">
            <OnlineOrders
              dateFilter={dateSelection}
              embedded
              onDateFilterChange={handleDateChange}
              onFilteredOrdersChange={setOnlineRows}
            />
          </section>
          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-white">
            <LocalOrdersPanel
              dateFilter={dateSelection}
              focusOrderId={focusOrderId}
              onFilteredOrdersChange={setLocalRows}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
