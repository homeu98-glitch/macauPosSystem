"use client";

import { useMemo, useState, type ReactElement } from "react";

import { mockBootstrap } from "@/lib/mock-data";
import { loadBootstrapCache } from "@/lib/storage";
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

export default function KioskQrPage() {
  const [host, setHost] = useState("");
  const bootstrap = loadBootstrapCache() ?? mockBootstrap;

  const tables = bootstrap.tables;
  const origin = host || (typeof window !== "undefined" ? window.location.origin : "https://macau-pos-system.vercel.app");

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="mb-1 text-xl font-bold text-slate-900">掃碼點餐 QR 生成器</h1>
      <p className="mb-4 text-sm text-slate-500">
        按枱生成 <code className="rounded bg-slate-100 px-1">/order?tableId=</code> 碼，印出貼枱。客人掃碼即開點餐介面。
      </p>

      <label className="mb-1 block text-xs text-slate-500">網址主機（host）</label>
      <input
        value={origin}
        onChange={(e) => setHost(e.target.value)}
        className="mb-6 w-full rounded-lg border border-slate-200 p-2 text-sm"
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
        {tables.map((table) => {
          const url = `${origin}/order?tableId=${encodeURIComponent(table.id)}`;
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
    </main>
  );
}
