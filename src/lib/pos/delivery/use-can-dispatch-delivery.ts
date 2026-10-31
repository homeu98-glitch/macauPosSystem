"use client";

import { useState } from "react";

import { loadOperatorSession } from "@/lib/pos/operator-session";
import { loadAuthSession } from "@/lib/storage";

/**
 * 「呢部機而家可唔可以派送」—— 兩層權限合併成一個 boolean。
 *
 * ## 兩層
 *
 * | 層 | 真源 | 缺省 |
 * |---|---|---|
 * | L1 商家帳號 | `AuthSession.permissions.dispatchDelivery` | **有**（`!== false`）|
 * | L2 操作員簽到 | `OperatorSession.permissions.actions.dispatchDelivery` | 跟角色預設（兩個角色都 true）|
 *
 * ## 為什麼一定要寫成一支 hook
 *
 * 舊 code 喺 `online-orders.tsx` 直接用 `authSession.permissions.reprintReceipt !== false`
 * 判斷 —— 呢個寫法**完全睇唔到 L2 操作員**：店員簽到之後權限應該以操作員為準，
 * 但直接讀 authSession 就會用返店主嘅權限（等於權限形同虛設）。
 *
 * 所以三個入口（訂單頁／快餐 strip／外送 tab）一律用呢支 hook，
 * 唔好再各自讀 localStorage。
 *
 * ## 為什麼用 `useState` 初始值而唔係每次 render 讀
 *
 * `loadOperatorSession()` / `loadAuthSession()` 都係 `JSON.parse(localStorage)`；
 * 訂單頁 render 非常頻繁（每張單每個狀態變都 render）。權限喺一個 session 內
 * 唔會中途改變（換人要重新簽到／重新登入，panel 會 remount）。
 */

export function useCanDispatchDelivery(storeId: string | null): boolean {
  const [allowed] = useState(() => {
    const operator = loadOperatorSession(storeId);
    if (operator) {
      // 有操作員 → 以操作員權限為準（唔可以 fallback 去店主，否則等於冇 gate）。
      // ⚠️ 用 `!== false` 而唔係 `=== true`：`dispatchDelivery` 係 2026-10-31 新增，
      //    **簽到中嘅舊 session 冇呢個 key**。寫 `=== true` 會令所有已簽到店員
      //    喺部署後即刻冇咗派送掣（要重新簽到先返嚟）—— 而角色預設本身係 true，
      //    所以缺欄＝沿用預設，同 `staff-core` 嘅 `readBoolMap` 口徑一致。
      return operator.permissions.actions.dispatchDelivery !== false;
    }
    // 冇操作員 → 沿用 L1；缺省 = 有（同 reprintReceipt 口徑一致）
    return loadAuthSession()?.permissions?.dispatchDelivery !== false;
  });
  return allowed;
}
