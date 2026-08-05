"use client";

import { useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { FixedNumberPad } from "@/components/fixed-number-pad";
import { normalizeBootstrapPayload } from "@/lib/bootstrap-normalizer";
import { mockBootstrap } from "@/lib/mock-data";
import { loadBootstrapCache, loadSoldOutState, saveSoldOutState } from "@/lib/storage";

export function SoldOutPage() {
  const bootstrap = useMemo(
    () => normalizeBootstrapPayload(loadBootstrapCache() ?? mockBootstrap),
    [],
  );
  const [soldOutMap, setSoldOutMap] = useState(() => loadSoldOutState());
  const [status, setStatus] = useState("設定完成後可保存到本機，點餐頁會立即生效。");
  const [selectedMenuItemId, setSelectedMenuItemId] = useState<string>(bootstrap.menuItems[0]?.id ?? "");
  const [padValue, setPadValue] = useState(() => {
    const firstId = bootstrap.menuItems[0]?.id;
    if (!firstId) return "";
    const state = loadSoldOutState()[firstId];
    return state ? String(state.initialQty) : "";
  });

  function persist(next: ReturnType<typeof loadSoldOutState>) {
    setSoldOutMap(next);
    saveSoldOutState(next);
    window.dispatchEvent(new CustomEvent("pos-soldout-changed", { detail: { soldOutMap: next } }));
  }

  const selectedItem = bootstrap.menuItems.find((item) => item.id === selectedMenuItemId) ?? null;

  function applyPadValue(value: string) {
    setPadValue(value);
    if (!selectedMenuItemId) return;

    const normalized = value.replace(/[^\d]/g, "");
    if (!normalized) {
      const next = { ...soldOutMap };
      delete next[selectedMenuItemId];
      persist(next);
      return;
    }

    const qty = Math.max(0, Math.floor(Number(normalized) || 0));
    persist({
      ...soldOutMap,
      [selectedMenuItemId]: {
        initialQty: qty,
        remainingQty: qty,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <AppSidebar />
      <div className="flex min-h-screen lg:pl-[72px]">
        <main className="flex-1 px-4 py-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">沽清</div>
                <div className="mt-1 text-sm text-slate-500">
                  為菜品設定可售數量。下單後會自動扣減，扣到 0 會在點餐頁顯示售罄。
                </div>
              </div>
              <button
                className="rounded-2xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white"
                onClick={() => {
                  saveSoldOutState(soldOutMap);
                  window.dispatchEvent(new CustomEvent("pos-soldout-changed", { detail: { soldOutMap } }));
                  setStatus("已保存沽清設定。");
                }}
                type="button"
              >
                保存
              </button>
            </div>
          </div>

          <div className="mt-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
            {status}
          </div>

          <section className="mt-3 rounded-2xl border border-slate-200 bg-white p-4">
            <div className="overflow-auto">
              <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold text-slate-500">
                  <th className="border-b border-slate-200 py-2 pr-3">菜品</th>
                  <th className="border-b border-slate-200 py-2 pr-3">剩餘</th>
                  <th className="border-b border-slate-200 py-2 pr-3">設定數量</th>
                  <th className="border-b border-slate-200 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                  {bootstrap.menuItems.map((item) => {
                    const state = soldOutMap[item.id];
                    const remaining = state ? state.remainingQty : "";
                    const initial = state ? state.initialQty : "";
                    const soldOut = state ? state.remainingQty <= 0 : false;
                    const active = item.id === selectedMenuItemId;
                    return (
                      <tr key={item.id} className={`${soldOut ? "bg-amber-50" : ""} ${active ? "ring-2 ring-orange-300" : ""}`}>
                      <td className="border-b border-slate-100 py-2 pr-3 font-semibold text-slate-900">
                        <button
                          className="text-left"
                          onClick={() => {
                            setSelectedMenuItemId(item.id);
                            setPadValue(initial === "" ? "" : String(initial));
                          }}
                          type="button"
                        >
                          {item.name}
                        </button>
                        {soldOut ? <span className="ml-2 text-xs font-semibold text-amber-700">售罄</span> : null}
                      </td>
                      <td className="border-b border-slate-100 py-2 pr-3 text-slate-700">
                        {remaining === "" ? "--" : remaining}
                      </td>
                      <td className="border-b border-slate-100 py-2 pr-3">
                        <input
                          className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                          inputMode="numeric"
                          onChange={(event) => {
                            const value = Number(event.target.value);
                            const qty = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
                            persist({
                              ...soldOutMap,
                              [item.id]: {
                                initialQty: qty,
                                remainingQty: qty,
                                updatedAt: new Date().toISOString(),
                              },
                            });
                            if (item.id === selectedMenuItemId) {
                              setPadValue(String(qty));
                            }
                          }}
                          placeholder="例如 20"
                          value={initial === "" ? "" : String(initial)}
                        />
                      </td>
                      <td className="border-b border-slate-100 py-2">
                        <div className="flex flex-wrap gap-2">
                          <button
                            className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                            onClick={() => {
                              const next = { ...soldOutMap };
                              delete next[item.id];
                              persist(next);
                              if (item.id === selectedMenuItemId) {
                                setPadValue("");
                              }
                            }}
                            type="button"
                          >
                            清除
                          </button>
                          <button
                            className="rounded-2xl bg-amber-600 px-3 py-2 text-xs font-semibold text-white"
                            onClick={() => {
                              persist({
                                ...soldOutMap,
                                [item.id]: {
                                  initialQty: soldOutMap[item.id]?.initialQty ?? 0,
                                  remainingQty: 0,
                                  updatedAt: new Date().toISOString(),
                                },
                              });
                              if (item.id === selectedMenuItemId) {
                                setPadValue(String(soldOutMap[item.id]?.initialQty ?? 0));
                              }
                            }}
                            type="button"
                          >
                            直接售罄
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                  })}
              </tbody>
              </table>
            </div>
          </section>
        </main>

        <div className="hidden w-[320px] shrink-0 lg:block">
          <FixedNumberPad
            confirmLabel="完成"
            subtitle={selectedItem ? `正在設定：${selectedItem.name}` : "先在左邊選一個菜品"}
            title="數字鍵盤"
            value={padValue}
            onChange={(value) => applyPadValue(value)}
          />
        </div>
      </div>
    </div>
  );
}
