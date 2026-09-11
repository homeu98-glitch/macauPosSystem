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

/**
 * 分區圖示 —— 只係裝飾，用**商家打嘅分區名**做關鍵字比對（唔可以寫死 id！）。
 *
 * ⚠️ 分區 id 係 `新增分區` 時生成（`` `${text.toLowerCase()}-${Date.now()}` ``），
 * 自訂分區嘅 id 會帶時間戳（例如 `後廚3-1757380123456`），**認 id 一定認唔到**。
 * 認唔到就出通用圖示，唔會影響辨識（名先係關鍵）。
 */
const ICON_RULES: Array<{ match: RegExp; icon: string }> = [
  { match: /水|飲|茶|咖|酒|吧|凍|汁|奶/, icon: "🥤" },
  { match: /甜|糖|糕|冰|雪/, icon: "🍮" },
  { match: /冷|沙律|刺身|壽司/, icon: "🥗" },
  { match: /燒|烤|扒|串/, icon: "🍖" },
  { match: /廚|炒|熱|爐|蒸|粉|麵|飯|出餐/, icon: "🍳" },
];

function stationIcon(name: string): string {
  for (const rule of ICON_RULES) if (rule.match.test(name)) return rule.icon;
  return "🍽️";
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
          <div className="mt-10 text-center text-sm text-slate-400">正在讀取分區…</div>
        ) : stations.length === 0 ? (
          <div className="mt-10 max-w-[620px] rounded-2xl border border-amber-200 bg-amber-50 px-6 py-5 text-center text-[14px] leading-relaxed text-amber-800">
            <div className="font-semibold">未收到本店嘅打印分區</div>
            <div className="mt-2 text-[13px]">
              呢部屏嘅分區清單係由商家喺收銀台「設定 → 打印機綁定 → 打印分區」設定，
              再同步上雲。請去收銀台確認已經新增分區，並撳一次「保存」。
            </div>
            <button
              className="mt-4 rounded-xl bg-amber-600 px-5 py-2.5 text-[13px] font-bold text-white"
              onClick={onRetry}
              type="button"
            >
              我已設定好，重新讀取
            </button>
          </div>
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
                <span className="text-[56px] leading-none">{stationIcon(station.name)}</span>
                <span className="mt-3.5 break-all text-3xl font-bold tracking-tight text-slate-900">
                  {station.name}
                </span>
                {/* ⚠️ 唔顯示 `station.id`：自訂分區嘅 id 帶時間戳（後廚3-1757…），
                    畀師傅睇只會混亂。名先係佢認得嘅嘢。 */}
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
