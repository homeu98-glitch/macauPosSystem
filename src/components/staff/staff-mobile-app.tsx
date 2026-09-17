"use client";

import { useMemo, useState } from "react";

import { useStaffOrder, type StaffTable, type StaffTableState } from "@/lib/use-staff-order";
import { ItemSpecModal } from "@/components/item-spec-modal";
import { money2 } from "@/components/kiosk/order-summary-card";
import { buildSelectedSpecs, priceWithSpecs } from "@/lib/pos/spec-selection";
import type { MenuItem } from "@/lib/types";

/**
 * 店員手機落單介面（`/staff`，2026-09-16）。
 *
 * ## 設計立場（對齊確認稿）
 *
 * 1. **枱況三態**：空枱（綠）／用膳中（橙）／即將結帳（紅）＋停用（灰）。
 *    由 `pos_orders` 未結單即時計算，**唔另建表**。
 * 2. **售罄菜灰化保留，唔隱藏** —— 店員要向客人解釋「呢款賣晒，要唔要換？」。
 * 3. **手機唔直連打印機**：送出後由雲端 `pos_print_jobs` 派工出紙。
 * 4. **觸控尺寸**：所有可撳元素 ≥ 40px（枱卡 74px 高、主按鈕 52px）。
 *
 * ## 手機輸入陷阱（用戶已知硬性要求）
 *
 * 數量輸入用自繪加減鍵（`− 1 ＋`），**唔用 `<input type=number>`** ——
 * iOS Safari 會彈系統鍵盤遮住半個畫面，枱邊操作極難用。
 */

const TABLE_STYLE: Record<StaffTableState, string> = {
  free: "bg-emerald-50 ring-emerald-200 text-emerald-800",
  busy: "bg-amber-50 ring-amber-200 text-amber-900",
  paying: "bg-red-50 ring-red-200 text-red-900",
  disabled: "bg-slate-100 ring-slate-200 text-slate-400",
};

function tableStateLabel(state: StaffTableState): string {
  if (state === "free") return "空枱";
  if (state === "busy") return "用膳中";
  if (state === "paying") return "即將結帳";
  return "暫停使用";
}

/**
 * 座位數文字。冇設 `capacity` 就**唔顯示「- 位」** —— 收銀台未填座位數時，
 * 「- 位」會令店員以為系統壞咗。空字串 = 唔顯示。
 */
function capacityText(capacity: number | undefined): string {
  return capacity && capacity > 0 ? `${capacity} 位` : "";
}

export function StaffMobileApp() {
  const api = useStaffOrder();
  const [cartOpen, setCartOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [specItem, setSpecItem] = useState<MenuItem | null>(null);

  /** 依樓層／區域分組（同確認稿「A 區 · 大廳」一致）。 */
  const grouped = useMemo(() => {
    const map = new Map<string, StaffTable[]>();
    for (const t of api.tables) {
      const key = t.area || "其他";
      const arr = map.get(key) ?? [];
      arr.push(t);
      map.set(key, arr);
    }
    return [...map.entries()];
  }, [api.tables]);

  if (!api.hydrated) {
    return <Centered>載入中…</Centered>;
  }

  if (api.needsLogin) {
    return (
      <Centered>
        <div className="text-4xl">🔒</div>
        <div className="mt-3 text-base font-semibold text-slate-900">尚未登入</div>
        <p className="mt-1 text-sm text-slate-500">請先以店員帳號登入，再選擇「店員手機」工作台。</p>
        <a
          href="/login"
          className="mt-5 inline-flex min-h-[48px] items-center rounded-2xl bg-indigo-600 px-6 font-semibold text-white"
        >
          前往登入
        </a>
      </Centered>
    );
  }

  if (api.menuLoading) return <Centered>載入餐牌中…</Centered>;

  if (api.menuUnavailable) {
    return (
      <Centered>
        <div className="text-4xl">🧾</div>
        <div className="mt-3 text-base font-semibold text-slate-900">餐牌未開放</div>
        <p className="mt-1 text-sm text-slate-500">此店尚未同步線上餐牌，請先由收銀台上傳餐牌。</p>
      </Centered>
    );
  }

  // ── 送出成功回饋 ──
  if (api.submitted) {
    const { order, kitchenJobCount } = api.submitted;
    return (
      <main className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col bg-slate-100 p-4">
        <div className="rounded-3xl bg-emerald-50 p-6 text-center ring-1 ring-emerald-200">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-500 text-3xl font-bold text-white">
            ✓
          </div>
          <div className="mt-3 text-xl font-bold text-emerald-900">訂單已送出</div>
          <div className="mt-1 font-mono text-sm text-emerald-700">
            {order.tableName} · MOP {money2(order.total)}
          </div>
          <div className="mt-0.5 font-mono text-xs text-slate-500">單號 {order.localOrderNo}</div>
        </div>

        <div className="mt-3 rounded-3xl bg-white p-4 ring-1 ring-slate-200">
          <div className="text-xs font-bold text-slate-600">廚房單</div>
          {kitchenJobCount > 0 ? (
            <p className="mt-2 text-sm text-slate-700">
              已排隊 <span className="font-bold">{kitchenJobCount}</span> 張，經雲端派工出紙。
            </p>
          ) : (
            <div className="mt-2 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
              ⚠️ 未建立廚房單。可能係本機未取得打印機設定，請通知收銀台補印，或喺收銀台完成一次打印設定同步。
            </div>
          )}
        </div>

        <div className="mt-3 rounded-3xl bg-white p-4 ring-1 ring-slate-200">
          <div className="text-xs font-bold text-slate-600">訂單已上雲</div>
          <p className="mt-2 text-sm text-slate-700">收銀台即時可見，可直接結帳。</p>
        </div>

        <button
          type="button"
          onClick={() => {
            api.reset();
            setCartOpen(false);
          }}
          className="mt-4 min-h-[52px] w-full rounded-2xl bg-indigo-600 text-base font-bold text-white active:scale-[0.98]"
        >
          繼續為下一枱點餐
        </button>
      </main>
    );
  }

  // ── 未揀枱：選枱畫面 ──
  if (!api.selectedTable) {
    return (
      <main className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col bg-slate-100">
        <header className="flex items-center justify-between gap-3 bg-white px-4 py-3 ring-1 ring-slate-200">
          <div className="min-w-0">
            <div className="truncate text-base font-bold text-slate-900">選擇桌台</div>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
              <span className="truncate">{api.storeName || "本店"}</span>
              {api.tableStateStale ? (
                <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 font-bold text-amber-800 ring-1 ring-amber-200">
                  枱況未確認
                </span>
              ) : (
                <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 font-bold text-emerald-700 ring-1 ring-emerald-200">
                  已連線
                </span>
              )}
            </div>
          </div>
          {/* 逃生門：落單專用終端只可以喺白名單路徑內（見 `order-only-terminal.ts`）。
              ⚠️ 一定要指 `/select-workbench`，**唔可以**指 `/` ——
              `/` 唔喺白名單內（會導向 `/staff`），指佢會造成無限跳轉。
              兩者 render 同一個元件，所以用邊條路徑睇落一樣。 */}
          <a
            href="/select-workbench"
            className="min-h-[40px] shrink-0 rounded-xl px-3 text-sm font-semibold leading-[40px] text-slate-600 ring-1 ring-slate-200 active:scale-[0.97]"
          >
            工作台
          </a>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {api.tableStateStale && (
            <div
              role="status"
              className="rounded-2xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200"
            >
              ⚠️ 未能讀取雲端枱況，以下「空枱／用膳中」可能唔準確。
              落單前請先確認枱上實際情況；如有疑問請喺收銀台查看。
            </div>
          )}
          {grouped.map(([area, list]) => (
            <section key={area}>
              <div className="mb-2 flex items-center gap-2 text-xs font-bold text-slate-500">
                <span>{area}</span>
                <span className="h-px flex-1 bg-slate-200" />
                <span>
                  空 {list.filter((t) => t.state === "free").length} · 用{" "}
                  {list.filter((t) => t.state !== "free" && t.state !== "disabled").length}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {list.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => api.selectTable(t.id)}
                    disabled={t.state === "disabled"}
                    aria-label={`${t.name}，${tableStateLabel(t.state)}`}
                    className={`flex min-h-[74px] flex-col items-center justify-center gap-0.5 rounded-2xl px-2 py-2 ring-1 active:scale-[0.97] disabled:active:scale-100 ${TABLE_STYLE[t.state]}`}
                  >
                    <span className="text-base font-bold">{t.name}</span>
                    <span className="text-[11px] font-semibold">
                      {t.state === "free"
                        ? capacityText(t.capacity) || "空枱"
                        : t.state === "disabled"
                          ? "暫停使用"
                          : [capacityText(t.partySize), `$${money2(t.amount ?? 0)}`]
                              .filter(Boolean)
                              .join(" · ")}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
          {api.tables.length === 0 && (
            <div className="py-16 text-center text-sm text-slate-400">
              呢間店仲未設定桌台，請喺收銀台新增桌台。
            </div>
          )}
        </div>
      </main>
    );
  }

  // ── 點餐畫面 ──
  const table = api.selectedTable;
  const canSubmit = api.cart.length > 0 && !api.submitting;

  return (
    <main className="mx-auto flex h-[100dvh] w-full max-w-md flex-col bg-slate-100">
      <header className="flex items-center justify-between gap-3 bg-white px-4 py-2.5 ring-1 ring-slate-200">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-base font-bold text-slate-900">{table.name}</span>
            {api.isAddOn && (
              <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800">
                加菜模式
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-slate-500">
            {api.isAddOn
              ? [
                  capacityText(table.partySize),
                  `已落 ${table.order?.items.length ?? 0} 款`,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : [capacityText(table.capacity), "新單"].filter(Boolean).join(" · ")}
          </div>
        </div>
        <button
          type="button"
          onClick={api.clearTable}
          className="min-h-[40px] shrink-0 rounded-xl px-3 text-sm font-semibold text-slate-600 ring-1 ring-slate-200 active:scale-[0.97]"
        >
          切枱
        </button>
      </header>

      {api.error && (
        <div role="alert" className="bg-red-50 px-4 py-2 text-xs font-medium text-red-700">
          {api.error}
        </div>
      )}

      {/* 分類 */}
      <nav className="flex gap-2 overflow-x-auto bg-white px-4 py-2 ring-1 ring-slate-200">
        {api.bootstrap.categories.map((cat) => (
          <button
            key={cat.id}
            type="button"
            onClick={() => api.setActiveCategory(cat.id)}
            className={`min-h-[40px] shrink-0 rounded-full px-4 text-sm font-semibold active:scale-[0.97] ${
              api.activeCategory === cat.id
                ? "bg-indigo-600 text-white"
                : "bg-white text-slate-600 ring-1 ring-slate-200"
            }`}
          >
            {cat.name}
          </button>
        ))}
      </nav>

      {/* 菜單 */}
      <section className="flex-1 overflow-y-auto p-3">
        <div className="grid grid-cols-2 gap-2.5">
          {api.categoryItems.map((item) => {
            const sold = api.soldoutIds.has(item.id);
            const market = Boolean(item.isMarketPrice);
            const blocked = sold || market;
            return (
              <button
                key={item.id}
                type="button"
                disabled={blocked}
                onClick={() => {
                  if (item.specGroups?.length) setSpecItem(item);
                  else api.addItem(item);
                }}
                className={`flex min-h-[96px] flex-col items-start justify-start gap-1 rounded-2xl p-3 text-left ring-1 active:scale-[0.97] disabled:active:scale-100 ${
                  blocked
                    ? "bg-slate-100 ring-slate-200"
                    : "bg-white ring-slate-200"
                }`}
              >
                <span
                  className={`text-sm font-bold leading-snug ${
                    blocked ? "text-slate-400 line-through" : "text-slate-900"
                  }`}
                >
                  {item.name}
                </span>
                <span
                  className={`font-mono text-sm font-bold ${
                    blocked ? "text-slate-400" : "text-indigo-600"
                  }`}
                >
                  ${money2(item.price)}
                </span>
                <span className={`text-[11px] font-semibold ${blocked ? "text-slate-400" : "text-slate-500"}`}>
                  {sold ? "售罄" : market ? "時價" : item.printerGroup === "kitchen" ? "廚房" : item.printerGroup}
                </span>
              </button>
            );
          })}
          {api.categoryItems.length === 0 && (
            <div className="col-span-full py-12 text-center text-sm text-slate-400">—</div>
          )}
        </div>
      </section>

      {/* 底部結算條 */}
      <footer className="border-t border-slate-200 bg-white px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-xs text-slate-500">
            已選 <span className="font-bold text-slate-800">{api.cartCount}</span> 件
            <div className="mt-0.5 font-mono text-[11px]">
              小計 ${money2(api.totals.subtotal)}
              {api.totals.serviceChargeAmount > 0 && ` · 服務費 $${money2(api.totals.serviceChargeAmount)}`}
            </div>
          </div>
          <div className="font-mono text-xl font-bold text-slate-900">${money2(api.totals.total)}</div>
        </div>
        <button
          type="button"
          disabled={api.cart.length === 0}
          onClick={() => setCartOpen(true)}
          className="mt-2.5 min-h-[52px] w-full rounded-2xl bg-indigo-600 text-base font-bold text-white active:scale-[0.98] disabled:bg-slate-300"
        >
          查看購物車
        </button>
      </footer>

      {/* 購物車 */}
      {cartOpen && (
        <Sheet title="購物車" subtitle={`${table.name}${api.isAddOn ? " · 加菜模式" : ""}`} onClose={() => setCartOpen(false)}>
          <div className="space-y-2.5">
            {api.cart.map((line) => (
              <div key={line.lineId} className="rounded-2xl bg-white p-3 ring-1 ring-slate-200">
                <div className="text-sm font-bold text-slate-900">{line.name}</div>
                {line.selectedSpecs && line.selectedSpecs.length > 0 && (
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    {line.selectedSpecs.map((s) => s.optionLabel).join(" / ")}
                  </div>
                )}
                <div className="mt-2 flex items-center justify-between">
                  <div className="flex items-center overflow-hidden rounded-xl ring-1 ring-slate-200">
                    <button
                      type="button"
                      aria-label={`${line.name} 減少一件`}
                      onClick={() => api.changeQty(line.lineId, -1)}
                      className="grid h-[40px] w-[44px] place-items-center text-lg font-bold text-indigo-700 active:bg-slate-100"
                    >
                      −
                    </button>
                    <span className="grid h-[40px] w-[40px] place-items-center border-x border-slate-200 bg-indigo-50 text-sm font-bold text-indigo-800">
                      {line.quantity}
                    </span>
                    <button
                      type="button"
                      aria-label={`${line.name} 增加一件`}
                      onClick={() => api.changeQty(line.lineId, 1)}
                      className="grid h-[40px] w-[44px] place-items-center text-lg font-bold text-indigo-700 active:bg-slate-100"
                    >
                      ＋
                    </button>
                  </div>
                  <span className="font-mono text-sm font-bold text-slate-900">
                    ${money2(line.price * line.quantity)}
                  </span>
                </div>
              </div>
            ))}
            {api.cart.length === 0 && (
              <div className="py-10 text-center text-sm text-slate-400">購物車係空嘅</div>
            )}
          </div>

          <textarea
            value={api.orderNote}
            onChange={(e) => api.setOrderNote(e.target.value)}
            placeholder="全單備註（例如：全部走蔥）"
            aria-label="全單備註"
            className="mt-3 h-16 w-full resize-none rounded-xl bg-white p-3 text-sm text-slate-700 ring-1 ring-slate-200"
          />

          <div className="mt-3 space-y-1.5 rounded-2xl bg-indigo-50 p-4">
            <Row label="小計" value={`$${money2(api.totals.subtotal)}`} />
            {api.totals.serviceChargeAmount > 0 && (
              <Row label="服務費" value={`$${money2(api.totals.serviceChargeAmount)}`} />
            )}
            {api.totals.taxAmount > 0 && <Row label="稅" value={`$${money2(api.totals.taxAmount)}`} />}
            <div className="flex items-baseline justify-between border-t border-dashed border-indigo-200 pt-2">
              <span className="text-sm font-bold text-slate-700">合計</span>
              <span className="font-mono text-xl font-bold text-indigo-800">
                ${money2(api.totals.total)}
              </span>
            </div>
          </div>

          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => setConfirmOpen(true)}
            className="mt-3 min-h-[52px] w-full rounded-2xl bg-amber-500 text-base font-bold text-amber-950 active:scale-[0.98] disabled:bg-slate-300 disabled:text-slate-500"
          >
            送出訂單
          </button>
        </Sheet>
      )}

      {/* 送出確認 */}
      {confirmOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-5">
          <div role="dialog" aria-modal="true" aria-label="確定送出此單" className="w-full max-w-sm rounded-3xl bg-white p-5">
            <h2 className="text-center text-lg font-bold text-slate-900">確定送出此單？</h2>
            <div className="mt-4 space-y-2 rounded-2xl bg-slate-50 p-4">
              <Row label="桌台" value={`${table.name}${api.isAddOn ? "（加菜）" : ""}`} />
              <Row label="件數" value={`${api.cartCount} 件`} />
              <Row label="合計" value={`$${money2(api.totals.total)}`} bold />
            </div>
            <div className="mt-3 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
              <b>送出後會即時列印廚房單</b>，無法撤回。如需修改，請先撳「取消」。
            </div>
            <div className="mt-4 flex gap-2.5">
              <button
                type="button"
                disabled={api.submitting}
                onClick={() => setConfirmOpen(false)}
                className="min-h-[52px] flex-1 rounded-2xl font-semibold text-slate-600 ring-1 ring-slate-300 active:scale-[0.98]"
              >
                取消
              </button>
              <button
                type="button"
                disabled={api.submitting}
                onClick={async () => {
                  await api.submit();
                  setConfirmOpen(false);
                  setCartOpen(false);
                }}
                className="min-h-[52px] flex-[1.3] rounded-2xl bg-amber-500 font-bold text-amber-950 active:scale-[0.98] disabled:bg-slate-300"
              >
                {api.submitting ? "送出中…" : "確定送出"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 規格選擇（共用元件；規格加價算法同收銀台同一真源） */}
      <ItemSpecModal
        open={Boolean(specItem)}
        title={specItem ? `${specItem.name} 規格` : "規格"}
        specGroups={specItem?.specGroups ?? []}
        onClose={() => setSpecItem(null)}
        onConfirm={(specMap) => {
          if (!specItem) return;
          const selectedSpecs = buildSelectedSpecs(specItem.specGroups ?? [], specMap);
          api.pushLine({
            menuItemId: specItem.id,
            name: specItem.name,
            price: priceWithSpecs(specItem, selectedSpecs),
            printerGroup: specItem.printerGroup,
            selectedSpecs,
          });
          setSpecItem(null);
        }}
      />
    </main>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-slate-100 px-6 text-center">
      <div className="w-full max-w-sm">
        <div className="text-sm text-slate-500">{children}</div>
      </div>
    </main>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-sm text-slate-500">{label}</span>
      <span className={`font-mono ${bold ? "text-base font-bold text-slate-900" : "text-sm font-semibold text-slate-800"}`}>
        {value}
      </span>
    </div>
  );
}

function Sheet({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-slate-100">
      <header className="flex items-center justify-between gap-3 bg-white px-4 py-3 ring-1 ring-slate-200">
        <div className="min-w-0">
          <div className="text-base font-bold text-slate-900">{title}</div>
          {subtitle && <div className="mt-0.5 truncate text-xs text-slate-500">{subtitle}</div>}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="min-h-[40px] shrink-0 rounded-xl px-3 text-sm font-semibold text-slate-600 ring-1 ring-slate-200 active:scale-[0.97]"
        >
          返回
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-4">{children}</div>
    </div>
  );
}
