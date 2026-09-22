import { NextResponse } from "next/server";

import { serializeWithEgressLog, type EgressLogExtra } from "@/lib/egress-log";
import { recordEgressUsage } from "@/lib/pos/egress-meter-server";

/**
 * 回應 ＋ egress 審計（server 執行層）。
 *
 * 純邏輯（`serializeWithEgressLog`）同執行層（呢個檔）刻意分開 —— 專案規則：
 * `node --test` 唔認 `@/` 別名亦唔想拖入 `next/server`，所以可測嘅一定要零 import。
 *
 * ## 🔴 為咩唔直接用 `NextResponse.json(payload)`
 *
 * `NextResponse.json` 內部係 `Response.json(body, init)`，即
 * `new NextResponse(JSON.stringify(payload), { headers: { "content-type": "application/json" } })`。
 * 呢度 serialize 一次、統計 bytes、再用**完全相同嘅 header 同 body** 回應
 * ⇒ 對 client 而言**逐位元一致**，只係順手多一行 log。
 *
 * 唔用「先 `NextResponse.json()` 再另外 stringify 一次嚟量度」：大 payload
 * （例如 5 000 行訂單 ≈7 MB）重複序列化會白燒 Fluid Active CPU（Vercel 有計費）。
 */
export function jsonWithEgressLog(
  tag: string,
  payload: unknown,
  extra: EgressLogExtra = {},
  /**
   * 🆕 2026-09-22：帶 `storeId` 就順手記入 `pos_egress_daily`（admin 頁用嘅每家店用量）。
   *
   * 計量係**輔助設施**：`recordEgressUsage()` 永遠唔 throw、唔 await（用 `after()`
   * 喺 response 之後才寫），亦會喺 migration 未跑時自動停用 ⇒ 對主流程零影響。
   * 唔傳 = 唔計量（舊行為，逐位元不變）。
   */
  meter?: { storeId?: string | null },
): NextResponse {
  const { body, bytes } = serializeWithEgressLog(tag, payload, extra);
  if (meter?.storeId) recordEgressUsage({ storeId: meter.storeId, route: tag, bytes });
  return new NextResponse(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
