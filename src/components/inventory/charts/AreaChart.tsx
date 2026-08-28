"use client";

import { useState } from "react";

import { useChartWidth } from "./useChartWidth";

export type AreaPoint = { label: string; value: number };

const money = (n: number) =>
  `MOP ${Number(n || 0).toLocaleString("zh-MO", { maximumFractionDigits: 0 })}`;

/** 面積圖（折線 + 漸層填充）。點擊資料點顯示數值。 */
export function AreaChart({ data, height = 200, color = "#0ea5e9" }: { data: AreaPoint[]; height?: number; color?: string }) {
  const { ref, width } = useChartWidth();
  const [active, setActive] = useState<number | null>(null);

  const padX = 36;
  const padTop = 16;
  const padBottom = 28;
  const max = Math.max(1, ...data.map((d) => d.value));
  const n = data.length;
  const innerW = Math.max(1, width - padX * 2);
  const innerH = Math.max(1, height - padTop - padBottom);

  const x = (i: number) => (n <= 1 ? width / 2 : padX + (i * innerW) / (n - 1));
  const y = (v: number) => padTop + innerH - (v / max) * innerH;

  const line = data.map((d, i) => `${x(i)},${y(d.value)}`).join(" ");
  const area = `M ${x(0)},${padTop + innerH} L ${data.map((d, i) => `${x(i)},${y(d.value)}`).join(" L ")} L ${x(n - 1)},${padTop + innerH} Z`;
  const gradId = "area-fill-grad";

  return (
    <div ref={ref} className="w-full">
      <svg width={width} height={height} className="block touch-none select-none">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((t) => (
          <line key={t} x1={padX} x2={width - padX} y1={padTop + innerH * t} y2={padTop + innerH * t} stroke="#e2e8f0" strokeWidth={1} />
        ))}
        <path d={area} fill={`url(#${gradId})`} />
        <polyline points={line} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) => (
          <circle
            key={i}
            cx={x(i)}
            cy={y(d.value)}
            r={active === i ? 5 : 3.5}
            fill={color}
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
          <text x={width / 2} y={padTop + 2} textAnchor="middle" fontSize={12} fontWeight={700} fill="#0f172a">
            {`${data[active].label} · ${money(data[active].value)}`}
          </text>
        )}
      </svg>
    </div>
  );
}
