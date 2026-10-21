"use client";

import { useEffect, useState } from "react";

import { useT } from "@/components/lang-provider";
import { QrSvg } from "@/components/qr-svg";
import { mockBootstrap } from "@/lib/mock-data";
import { loadBootstrapCache, loadPosLocalSettings } from "@/lib/storage";
import { filterReopenTempTables } from "@/lib/pos/table-scope";
import { openQrPrintWindow } from "@/lib/pos/qr-print";
import type { StoreTable } from "@/lib/types";

/**
 * 掃碼點餐 QR 生成面板（**堂食**：每張枱一個碼）。
 *
 * 路徑：`/settings` →「掃碼點餐」→ 堂食模式時顯示。
 * 按枱生成 `/menu?tableId=<id>&store=<店>`，可複製／列印，印出貼枱。
 * 客人掃碼即開手機點餐介面，`store` 帶埋所屬店，確保落單落到正確店。
 *
 * ## 歷史（2026-10-21 復原）
 *
 * 2026-10-20 嘅 commit `1b8a71c`（設置頁 UI 優化）為咗刪走「掃碼點餐模式」唯讀卡，
 * 連埋 `scan-mode-panel.tsx` / 舊 `kiosk-qr-panel.tsx` 一齊刪 —— QR 面板係嗰張卡嘅
 * **子節點**，所以陪葬。結果：商家完全冇入口重印枱貼紙（`openQrPrintWindow` 變孤兒）。
 * 今次只復原 **QR 輸出**，唔復原模式卡（模式真源仍然只有「登入工作台」一個）。
 *
 * ## 🔴 冇 storeId 就**唔可以**出 QR
 *
 * 舊版（2026-09）冇 storeId 都照出枱碼，只係網址少咗 `&store=`。但
 * `scan-order-page.tsx` 開頭就係 `if (!storeId || (!quick && !tableId))` ⇒
 * 客人掃到會見到錯誤頁／落唔到單（**唔會**靜靜落到錯店，但等於白印貼紙）。
 * ⇒ 而家改為明確擋住並提示登入／綁店。
 *
 * ⚠️ QR 網址只用到 `table.id`（crypto.randomUUID，純 ASCII）＋ storeId（ASCII），
 * 絕唔會把枱嘅中文名 / 區域名放落 QR payload。中文枱名唔會令 QR 掃唔到。
 */

/** 讀本機枱／店名（mount 之後才讀，SSR 期間 localStorage 係 undefined）。 */
function useLocalQrData(): { tables: StoreTable[]; storeName: string } {
  const [data, setData] = useState<{ tables: StoreTable[]; storeName: string }>({
    tables: [],
    storeName: "",
  });

  useEffect(() => {
    const read = () => {
      const bootstrap = loadBootstrapCache() ?? mockBootstrap;
      // 合併共享 bootstrap.tables 同「樓層與桌台」本地枱（收銀在設定新增嘅枱）。
      // 優先本地枱：商家即時改名／新增嘅枱一定用最新 copy，避免舊 bootstrap cache 蓋過。
      // 同時過濾走冇 id 嘅枱（會生成到破損 URL 嘅 QR）。
      //
      // ⚠️ 亦要剝走返結 temp 枱（`isReopenTemp`）：temp 枱只喺「返結單編輯期間」存在，
      // 為佢生成掃碼 QR 會令客人掃到一張「返結 A03」落單，而張枱喺結帳後會消失 →
      // 張單無處可放、收銀枱面搵唔到。見 `pos/table-scope.ts`。
      const localTables = filterReopenTempTables(
        loadPosLocalSettings().floors.flatMap((floor) => floor.tables),
      );
      const localIds = new Set(localTables.map((table) => table.id).filter(Boolean));
      const tables = [
        ...localTables,
        ...filterReopenTempTables(bootstrap.tables ?? []).filter(
          (table) => table.id && !localIds.has(table.id),
        ),
      ].filter((table) => Boolean(table.id));
      setData({ tables, storeName: bootstrap.storeName ?? "" });
    };

    read();
    // 枱／店名改動後即時刷新，唔使人手 reload（同舊版同一組事件）。
    window.addEventListener("pos-local-settings-changed", read);
    window.addEventListener("pos-bootstrap-changed", read);
    window.addEventListener("pos-device-config-changed", read);
    return () => {
      window.removeEventListener("pos-local-settings-changed", read);
      window.removeEventListener("pos-bootstrap-changed", read);
      window.removeEventListener("pos-device-config-changed", read);
    };
  }, []);

  return data;
}

export function KioskQrPanel({ storeId }: { storeId: string }) {
  const t = useT();
  const { tables, storeName } = useLocalQrData();
  /**
   * 一次性操作提示（複製成功 / 列印被攔截）。
   *
   * ⚠️ 存 `{ key, vars }` 而唔係**已填值**字串：舊版係
   * `setHint(\`已複製「${name}」嘅點餐網址。\`)` 再 `t(hint)` —— 兩邊永遠唔相等，
   * `lookup()` 靜靜 fallback 返中文（英文版殘留中文、冇 error、冇測試紅）。
   * 見 `i18n-layer-guard.test.ts` 嘅「唔可以 t() 一個已填值字串」。
   */
  const [hint, setHint] = useState<{ key: string; vars?: Record<string, string | number> } | null>(null);
  /** 商家可改 host（例如未上自訂網域時想印 Vercel 網址）。空白 = 用目前 origin。 */
  const [host, setHost] = useState("");

  const origin =
    host.trim() ||
    (typeof window !== "undefined" ? window.location.origin : "https://macau-pos-system.vercel.app");

  /** 冇 storeId 一律擋住：出咗都係客人掃到錯誤頁（見檔頭說明）。 */
  if (!storeId) {
    return (
      <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-1 text-base font-semibold text-slate-900">{t("掃碼點餐 QR")}</div>
        <div className="mt-3 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-400">
          {t("未取得店鋪編號，請先以商戶帳號登入 / 綁店。")}
        </div>
      </section>
    );
  }

  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-1 text-base font-semibold text-slate-900">{t("掃碼點餐 QR")}</div>
      <p className="mb-4 text-sm text-slate-500">
        {t("按枱生成")} <code className="rounded bg-slate-100 px-1">/menu?tableId=</code>{" "}
        {t("碼，印出貼枱。客人掃碼即開手機點餐介面（已帶所屬店鋪）。")}
      </p>

      <label className="mb-1 block text-xs text-slate-500" htmlFor="qr-host-input">
        {t("網址主機（host）")}
      </label>
      <input
        className="mb-6 w-full rounded-lg border border-slate-200 p-2 text-sm"
        id="qr-host-input"
        onChange={(e) => setHost(e.target.value)}
        placeholder={typeof window !== "undefined" ? window.location.origin : ""}
        value={host}
      />

      {hint ? (
        <div className="mb-4 rounded-xl bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800" role="status">
          {t(hint.key, hint.vars)}
        </div>
      ) : null}

      {tables.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-400">
          {t("尚未設定桌台，請先到「樓層與桌台」新增。")}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
          {tables.map((table) => {
            const url = `${origin}/menu?tableId=${encodeURIComponent(table.id)}&store=${encodeURIComponent(storeId)}`;
            return (
              <div className="rounded-2xl border border-slate-200 bg-white p-3 text-center" key={table.id}>
                <div className="mb-2 text-sm font-semibold text-slate-900">
                  {/* ⚠️ `table.name` / `table.area` 係商家自己輸入嘅資料值 ⇒ 唔翻譯 */}
                  {table.name || t("未命名桌台")}
                  <span className="ml-1 text-xs font-normal text-slate-400">{table.area}</span>
                </div>
                <div className="flex justify-center">
                  <QrSvg size={140} text={url} />
                </div>
                <div className="mt-2 break-all text-[10px] text-slate-400">{url}</div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button
                    className="min-h-11 rounded-lg bg-slate-100 py-1.5 text-xs font-semibold text-slate-700"
                    onClick={() => {
                      void navigator.clipboard?.writeText(url);
                      setHint({
                        key: "已複製「{name}」嘅點餐網址。",
                        vars: { name: table.name || t("未命名桌台") },
                      });
                    }}
                    type="button"
                  >
                    {t("複製網址")}
                  </button>
                  <button
                    className="min-h-11 rounded-lg bg-orange-500 py-1.5 text-xs font-semibold text-white"
                    onClick={() => {
                      // ⚠️ 呢三個係**QR 貼紙 / 紙單**內容（客人掃碼見到）⇒ 維持繁中，唔翻譯。
                      const ok = openQrPrintWindow({
                        title: table.name || "桌台",
                        subtitle: storeName || undefined,
                        footer: "掃碼點餐",
                        url,
                        size: 320,
                      });
                      if (!ok) setHint({ key: "無法開啟列印視窗，請允許彈出視窗或改用「複製網址」。" });
                    }}
                    type="button"
                  >
                    {t("列印")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
