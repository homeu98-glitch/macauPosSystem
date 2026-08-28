"use client";

import { useEffect, useRef, useState } from "react";

/** 測量容器寬度，讓 SVG 圖表以真實像素寬渲染（避免 preserveAspectRatio 拉伸導致線條變形）。 */
export function useChartWidth(initial = 640) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      if (w > 0) setWidth(w);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, width };
}
