/**
 * 裝置授權 DTO —— 客戶端同 server 共用嘅**型別**（冇任何 runtime import）。
 *
 * 為何要獨立一支檔：`device-binding.ts` 係 `"use client"`、
 * `device-binding-server.ts` 係 `import "server-only"` —— 兩邊互相 import 會爆。
 * 但佢哋要回同一個形狀俾 UI，所以型別擺喺中立檔（同 `staff-core.ts` 同一手法）。
 */
export type BoundDeviceDto = {
  deviceId: string;
  storeId: string;
  label: string;
  boundBy: string;
  boundAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
};
