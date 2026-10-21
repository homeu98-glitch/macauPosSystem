"use client";

import { useState } from "react";

import { useT } from "@/components/lang-provider";
import { QrSvg } from "@/components/qr-svg";
import { openQrPrintWindow } from "@/lib/pos/qr-print";

/**
 * 掃碼點餐 QR 生成面板（**快餐**：全店一個碼）。
 *
 * 路徑：`/settings` →「掃碼點餐」→ 快餐模式時顯示。
 * `/quick?store=<店>`，貼櫃檯／快餐區；客人掃完直接落單，每張單獨立（無枱）。
 *
 * ⚠️ 同 `kiosk-qr-panel`（堂食每枱一碼）**互斥**：只會顯示目前生效嘅一種，
 * 避免商家印錯貼紙（快餐店貼咗枱碼 = 客人落單綁枱，但鋪頭冇開枱）。
 * 由 `scan-qr-section.tsx` 按店級 `pos_kiosk_settings.scan_mode` 決定 render 邊個。
 *
 * ⚠️ 冇 storeId 就出唔到 `/quick?store=` —— `scan-order-page.tsx` 冇 storeId 會直接
 * 顯示錯誤閘，所以呢度一定要擋住並提示登入／綁店（唔可以出一個掃唔到單嘅碼）。
 */
export function QuickScanQrPanel({ storeId }: { storeId: string }) {
  const t = useT();
  /** 商家可改 host（例如未上自訂網域時想印 Vercel 網址）。空白 = 用目前 origin。 */
  const [host, setHost] = useState("");
  /** 一次性提示：存 `{ key, vars }`，render 期才 `t()`（唔可以存已填值字串）。 */
  const [hint, setHint] = useState<{ key: string; vars?: Record<string, string | number> } | null>(null);

  const origin =
    host.trim() ||
    (typeof window !== "undefined" ? window.location.origin : "https://macau-pos-system.vercel.app");
  const url = storeId ? `${origin}/quick?store=${encodeURIComponent(storeId)}` : "";

  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-1 text-base font-semibold text-slate-900">{t("快餐掃碼 QR（全店一個）")}</div>
      <p className="mb-4 text-sm text-slate-500">
        {t("快餐模式全店只用一個碼，客人掃碼後直接落單、每張單獨立（同自助點餐機快餐流程一致）。印出貼喺櫃檯／快餐區。")}
      </p>

      <label className="mb-1 block text-xs text-slate-500" htmlFor="quick-qr-host-input">
        {t("網址主機（host）")}
      </label>
      <input
        className="mb-6 w-full rounded-lg border border-slate-200 p-2 text-sm"
        id="quick-qr-host-input"
        onChange={(e) => setHost(e.target.value)}
        placeholder={typeof window !== "undefined" ? window.location.origin : ""}
        value={host}
      />

      {hint ? (
        <div className="mb-4 rounded-xl bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800" role="status">
          {t(hint.key, hint.vars)}
        </div>
      ) : null}

      {!storeId ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-400">
          {t("未取得店鋪編號，請先以商戶帳號登入 / 綁店。")}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-slate-200 bg-white p-6">
          <QrSvg size={220} text={url} />
          <div className="break-all text-center text-[11px] text-slate-400">{url}</div>
          <div className="grid w-full max-w-xs grid-cols-2 gap-2">
            <button
              className="min-h-11 rounded-lg bg-slate-100 py-2 text-xs font-semibold text-slate-700"
              onClick={() => {
                void navigator.clipboard?.writeText(url);
                setHint({ key: "已複製快餐點餐網址。" });
              }}
              type="button"
            >
              {t("複製網址")}
            </button>
            <button
              className="min-h-11 rounded-lg bg-orange-500 py-2 text-xs font-semibold text-white"
              onClick={() => {
                // ⚠️ 呢三個係**紙單 / 貼紙**內容（客人掃碼見到）⇒ 維持繁中，唔翻譯。
                const ok = openQrPrintWindow({
                  title: "掃碼點餐",
                  subtitle: "快餐",
                  footer: "掃碼點餐 · 點完請到櫃檯付款",
                  url,
                  size: 400,
                });
                if (!ok) setHint({ key: "無法開啟列印視窗，請允許彈出視窗或改用「複製網址」。" });
              }}
              type="button"
            >
              {t("列印")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
