"use client";

import { useState } from "react";

import { useChartWidth } from "./useChartWidth";

export type DonutSlice = { label: string; value: number; color?: string };

const PALETTE = ["#0ea5e9", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#64748b"];

const money = (n: number) =>
  `MOP ${Number(n || 0).toLocaleString("zh-MO", { maximumFractionDigits: 0 })}`;

/** 甜甜圈圖。圓環按佔比分段，點擊分段在中央顯示該段數值。 */
export function DonutChart({ data, size = 200, thickness = 26 }: { data: DonutSlice[]; size?: number; thickness?: number }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const [active, setActive] = useState<number | null>(null);

  const cx = size / 2;
  const cy = size / 2;
  const rO = size / 2 - 4;
  const rI = rO - thickness;

  const arcs = data.map((d, i) => {
    const start =
      -Math.PI / 2 +
      data.slice(0, i).reduce((s, prev) => s + (total > 0 ? (prev.value / total) * Math.PI * 2 : 0), 0);
    const frac = total > 0 ? d.value / total : 0;
    const end = start + frac * Math.PI * 2;
    const large = end - start > Math.PI ? 1 : 0;
    const p = (r: number, a: number): [number, number] => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const [x1, y1] = p(rO, start);
    const [x2, y2] = p(rO, end);
    const [x3, y3] = p(rI, end);
    const [x4, y4] = p(rI, start);
    const dPath = `M ${x1} ${y1} A ${rO} ${rO} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${rI} ${rI} 0 ${large} 0 ${x4} ${y4} Z`;
    return { dPath, color: d.color || PALETTE[i % PALETTE.length], label: d.label, value: d.value };
  });

  const shown = active !== null ? arcs[active] : null;
  const { ref } = useChartWidth(size);

  return (
    <div ref={ref} className="flex items-center gap-4">
      <svg width={size} height={size} className="shrink-0 touch-none select-none">
        {total === 0 && <circle cx={cx} cy={cy} r={(rO + rI) / 2} fill="none" stroke="#e2e8f0" strokeWidth={thickness} />}
        {arcs.map((a, i) => (
          <path
            key={i}
            d={a.dPath}
            fill={a.color}
            className="cursor-pointer transition-opacity"
            style={{ opacity: active === null || active === i ? 1 : 0.4 }}
            onPointerDown={() => setActive(active === i ? null : i)}
          />
        ))}
        <text x={cx} y={cy - 6} textAnchor="middle" fontSize={13} fill="#64748b">
          {shown ? shown.label : "總計"}
        </text>
        <text x={cx} y={cy + 14} textAnchor="middle" fontSize={15} fontWeight={700} fill="#0f172a">
          {shown ? money(shown.value) : money(total)}
        </text>
      </svg>
      <ul className="min-w-0 flex-1 space-y-1 text-sm">
        {arcs.map((a, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: a.color }} />
            <span className="min-w-0 flex-1 truncate text-slate-600">{a.label}</span>
            <span className="font-semibold text-slate-900">{total > 0 ? `${Math.round((a.value / total) * 100)}%` : "0%"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
