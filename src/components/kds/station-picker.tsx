"use client";

import type { KdsStationOption } from "@/lib/kds/types";

/**
 * 「揀崗位」畫面（docs/116 §4.4）。
 *
 * 呢一步**只喺登入之後出現一次**。揀完就寫入設備綁定並鎖死，
 * 之後開機直接入屏，屏內冇任何切換掣（防止廚房同事誤撳）。
 *
 * 設計要點：
 *   - 大字、大掣（手指唔係滑鼠；廚房環境可能濕手 / 戴手套）
 *   - 每張卡顯示「而家有幾多項未完成」，幫同事一眼睇邊個工位忙
 *   - 顯示名 / emoji 由 `deriveKdsStations()` 推導，**唔可以寫死**
 *     （`printerGroup` 係自由字串，店家可以自訂任何工位）
 */

/** 工位圖示。純裝飾，認唔到就唔顯示（唔會影響辨識）。 */
const STATION_ICONS: Record<string, string> = {
  kitchen: "🍳",
  hot: "🍳",
  wok: "🥘",
  grill: "🍖",
  cold: "🥗",
  drinks: "🥤",
  bar: "🥤",
  beverage: "🧋",
  dessert: "🍮",
};

function stationIcon(id: string): string {
  return STATION_ICONS[id] ?? "🍽️";
}

export function StationPicker({
  storeName,
  stations,
  loading,
  error,
  saving,
  onPick,
  onRetry,
}: {
  storeName: string;
  stations: KdsStationOption[];
  loading: boolean;
  error: string | null;
  saving: boolean;
  onPick: (stationId: string) => void;
  onRetry: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-slate-50">
      <div className="flex h-[66px] flex-none items-center justify-between border-b border-slate-200 bg-white px-5">
        <div className="text-base font-semibold tracking-tight text-slate-900">
          {storeName || "本店"}
          <span className="ml-2 text-[13px] font-semibold text-emerald-600">登入成功</span>
        </div>
        <div className="flex items-center gap-2 rounded-full bg-slate-100 px-4 py-2 text-[13px] font-semibold text-slate-500">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
          已連線
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-8">
        <div className="text-center text-[34px] font-semibold leading-tight tracking-tight text-slate-900">
          呢部機係邊個崗位？
        </div>
        <div className="mt-3 max-w-[660px] text-center text-[14px] leading-relaxed text-slate-500">
          揀咗之後，呢部屏
          <strong className="font-semibold text-slate-900">只會顯示該崗位嘅出品</strong>
          ，唔會見到其他崗位。
          <br />
          綁定之後，下次開機自動入返呢個崗位，唔使再揀。
        </div>

        {error ? (
          <div className="mt-6 w-full max-w-[560px] rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-center">
            <div className="text-sm font-semibold text-rose-700">{error}</div>
            <button
              className="mt-3 rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white active:scale-[.98]"
              onClick={onRetry}
              type="button"
            >
              重試
            </button>
          </div>
        ) : null}

        {loading ? (
          <div className="mt-10 text-center text-sm text-slate-400">正在讀取工位…</div>
        ) : (
          <div className="mt-8 grid w-full max-w-[860px] grid-cols-2 items-stretch gap-5">
            {stations.map((station) => (
              <button
                className="flex flex-col items-center rounded-[22px] border border-slate-200 bg-white px-6 pb-6 pt-7 text-center shadow-sm transition active:scale-[.99] disabled:opacity-60"
                disabled={saving}
                key={station.id}
                onClick={() => onPick(station.id)}
                type="button"
              >
                <span className="text-[56px] leading-none">{stationIcon(station.id)}</span>
                <span className="mt-3.5 text-3xl font-bold tracking-tight text-slate-900">
                  {station.label}
                </span>
                <span className="mt-2 text-[13px] text-slate-500">工位代號：{station.id}</span>
                <span className="mt-4 rounded-full bg-orange-50 px-4 py-1.5 text-[13px] font-semibold text-orange-700">
                  而家有 <b className="font-mono text-[15px]">{station.pending}</b> 項未完成
                </span>
                <span className="mt-4 rounded-xl bg-slate-900 px-5 py-3 text-[13.5px] font-bold text-white">
                  {saving ? "綁定中…" : "揀呢個崗位 →"}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="mt-7 text-center text-[12.5px] leading-relaxed text-slate-400">
          ⚠ 揀錯咗唔緊要 —— 屏內「⚙ 設定」→「切換崗位」可以改（要重新登入，防止誤撳）
          <br />
          如果本店只有一個工位，下次會自動跳過呢一步。
        </div>
      </div>
    </div>
  );
}
