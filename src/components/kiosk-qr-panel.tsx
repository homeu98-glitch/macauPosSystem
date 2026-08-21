"use client";

import { useMemo, useState, type ReactElement } from "react";

import { mockBootstrap } from "@/lib/mock-data";
import { loadAuthSession, loadBootstrapCache } from "@/lib/storage";
import { loadKioskDeviceBinding } from "@/lib/kiosk-order";
import { encodeQrMatrix } from "@/lib/qrcode";

function QrSvg({ text, size = 160 }: { text: string; size?: number }) {
  const matrix = useMemo(() => encodeQrMatrix(text), [text]);
  if (!matrix) {
    return (
      <div className="flex h-40 w-40 items-center justify-center rounded-lg border border-red-200 bg-red-50 text-center text-xs text-red-500">
        太長，無法生成 QR
        <br />
        （請用複製網址）
      </div>
    );
  }
  const quiet = 4;
  const total = matrix.size + quiet * 2;
  const cell = size / total;
  const rects: ReactElement[] = [];
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (matrix.modules[r][c]) {
        rects.push(
          <rect
            key={`${r}-${c}`}
            x={(c + quiet) * cell}
            y={(r + quiet) * cell}
            width={cell}
            height={cell}
            fill="#0f172a"
          />,
        );
      }
    }
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="rounded bg-white">
      <rect width={size} height={size} fill="#ffffff" />
      {rects}
    </svg>
  );
}

/**
 * 掃碼點餐 QR 生成面板（商家側，喺 /settings「掃碼點餐」tab 內嵌）。
 * 按枱生成 /menu?tableId=<id>&store=<merchantId>，印出貼枱。
 * 客人掃碼即開手機點餐介面（/menu，外賣 App 風）；store 帶埋所屬店，確保客人手機落單落到正確店。
 */
export function KioskQrPanel() {
  const [host, setHost] = useState("");
  const bootstrap = loadBootstrapCache() ?? mockBootstrap;
  // 優先用 kiosk 設備綁店（mode=kiosk 登入只 save 綁店、唔 save auth session，
  // 所以 loadAuthSession() 喺「掃碼點餐」tab 係 null）；冇綁店先 fallback ledger auth session。
  // store 帶埋 storeName，畀客人手機顯示「所屬店」而唔係 demo 店名。
  const binding = loadKioskDeviceBinding();
  const session = loadAuthSession();
  const storeId = binding?.storeId ?? session?.merchantId ?? "";
  const storeName = binding?.storeName ?? session?.name ?? "";

  const origin = host || (typeof window !== "undefined" ? window.location.origin : "https://macau-pos-system.vercel.app");
  const tables = bootstrap.tables;

  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-1 text-base font-semibold text-slate-900">掃碼點餐 QR</div>
      <p className="mb-4 text-sm text-slate-500">
        按枱生成 <code className="rounded bg-slate-100 px-1">/menu?tableId=</code> 碼，印出貼枱。客人掃碼即開手機點餐介面（已帶所屬店鋪）。
      </p>

      <label className="mb-1 block text-xs text-slate-500">網址主機（host）</label>
      <input
        value={origin}
        onChange={(e) => setHost(e.target.value)}
        className="mb-6 w-full rounded-lg border border-slate-200 p-2 text-sm"
      />

      {tables.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-400">
          尚未設定桌台，請先到「樓層與桌台」新增。
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
          {tables.map((table) => {
            const url = `${origin}/menu?tableId=${encodeURIComponent(table.id)}${storeId ? `&store=${encodeURIComponent(storeId)}` : ""}${storeName ? `&storeName=${encodeURIComponent(storeName)}` : ""}`;
            return (
              <div key={table.id} className="rounded-2xl border border-slate-200 bg-white p-3 text-center">
                <div className="mb-2 text-sm font-semibold text-slate-900">
                  {table.name}
                  <span className="ml-1 text-xs font-normal text-slate-400">{table.area}</span>
                </div>
                <div className="flex justify-center">
                  <QrSvg text={url} size={140} />
                </div>
                <div className="mt-2 break-all text-[10px] text-slate-400">{url}</div>
                <button
                  onClick={() => navigator.clipboard?.writeText(url)}
                  className="mt-2 w-full rounded-lg bg-orange-500 py-1.5 text-xs font-semibold text-white"
                >
                  複製網址
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
