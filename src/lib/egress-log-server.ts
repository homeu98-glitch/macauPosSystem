import { NextResponse } from "next/server";

import { serializeWithEgressLog, type EgressLogExtra } from "@/lib/egress-log";

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
): NextResponse {
  const { body } = serializeWithEgressLog(tag, payload, extra);
  return new NextResponse(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
