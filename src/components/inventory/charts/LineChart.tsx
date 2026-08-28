"use client";

import { useState } from "react";

import { useChartWidth } from "./useChartWidth";

export type LinePoint = { label: string; up: number; down: number };

const SERIES = [
  { key: "up" as const, color: "#ef4444", label: "上漲" },
  { key: "down" as const, color: "#10b981", label: "下降" },
];

/** 多系列折線圖（價格漲跌：上漲 vs 下降）。點擊月份直條顯示該月明細。 */
export function LineChart({ data, height = 200 }: { data: LinePoint[]; height?: number }) {
  const { ref, width } = useChartWidth();
  const [active, setActive] = useState<number | null>(null);

  const padX = 36;
  const padTop = 18;
  const padBottom = 28;
  const max = Math.max(1, ...data.flatMap((d) => [d.up, d.down]));
  const n = data.length;
  const innerW = Math.max(1, width - padX * 2);
  const innerH = Math.max(1, height - padTop - padBottom);

  const x = (i: number) => (n <= 1 ? width / 2 : padX + (i * innerW) / (n - 1));
  const y = (v: number) => padTop + innerH - (v / max) * innerH;
  const mk = (key: "up" | "down") => data.map((d, i) => `${x(i)},${y(d[key])}`).join(" ");

  const colW = n > 0 ? innerW / n : innerW;

  return (
    <div ref={ref} className="w-full">
      <svg width={width} height={height} className="block touch-none select-none">
        {[0, 0.5, 1].map((t) => (
          <line key={t} x1={padX} x2={width - padX} y1={padTop + innerH * t} y2={padTop + innerH * t} stroke="#e2e8f0" strokeWidth={1} />
        ))}
        {SERIES.map((s) => (
          <polyline key={s.key} points={mk(s.key)} fill="none" stroke={s.color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {data.map((_, i) => (
          <rect
            key={i}
            x={x(i) - colW / 2}
            y={padTop}
            width={colW}
            height={innerH}
            fill="transparent"
            className="cursor-pointer"
            onPointerDown={() => setActive(active === i ? null : i)}
          />
        ))}
        {data.map((d, i) => (
          <text key={i} x={x(i)} y={height - 8} textAnchor="middle" fontSize={11} fill="#64748b">
            {n > 6 && i % 2 === 1 ? "" : d.label}
          </text>
        ))}
        {active !== null && (
          <text x={width / 2} y={padTop} textAnchor="middle" fontSize={12} fontWeight={700} fill="#0f172a">
            {`${data[active].label}：上漲 ${data[active].up} / 下降 ${data[active].down}`}
          </text>
        )}
      </svg>
      <div className="mt-1 flex justify-center gap-4 text-xs">
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1 text-slate-600">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
