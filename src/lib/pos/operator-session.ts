"use client";

import {
  POS_STAFF_ACTION_IDS,
  POS_STAFF_PAGE_IDS,
  normalizePosStaffPermissions,
  type PosStaffPermissions,
  type PosStaffRole,
} from "@/lib/pos/staff-core";

/**
 * 操作員（店員）簽到狀態 —— **獨立 localStorage key**，唔塞入 `AuthSession`。
 *
 * ## 為何唔塞入 AuthSession（docs/123 §5.3 同一結論）
 *
 * 1. `normalizeAuthSession()` 係**白名單重建** —— 加欄位唔改佢就會靜靜被剷走
 *    （`qrUrl` / `posDeviceToken` / `mustChangePin` 都中過）。
 * 2. 換班唔應該觸發 `pos-auth-changed` → 整頁 reload（`auth-guard.tsx` 會 reload），
 *    操作員切換應該係**輕量**嘅。
 * 3. L1（Ledger 裝置登入）同 L2（店員簽到）生命週期唔同：通常朝早登入一次 L1、
 *    全日換幾次 L2。
 *
 * ## 讀取一定要驗
 *
 * localStorage 可以被任意改寫 ⇒ 讀出嚟嘅 shape 一定要 `normalizePosStaffPermissions()`
 * 再過一次白名單，過期即清。真正安全邊界仍然喺伺服器（`/api/pos/staff/login`
 * 簽發 `sv1` token；UI 只係 UX）。
 */

const KEY_PREFIX = "macau-pos/operator/";

export type OperatorSession = {
  storeId: string;
  staffId: string;
  staffNo: string;
  name: string;
  role: PosStaffRole;
  permissions: PosStaffPermissions;
  /** `sv1` HMAC token（伺服器簽發；UI 唔解讀，只保存） */
  token: string;
  signedInAt: string;
  expiresAt: string;
};

function keyFor(storeId: string): string {
  return `${KEY_PREFIX}${storeId}`;
}

export function loadOperatorSession(storeId: string | null | undefined): OperatorSession | null {
  if (!storeId || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(keyFor(storeId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.storeId !== storeId) return null;

    const expiresAt = String(parsed.expiresAt ?? "");
    const expMs = Date.parse(expiresAt);
    if (!Number.isFinite(expMs) || expMs <= Date.now()) {
      window.localStorage.removeItem(keyFor(storeId));
      return null;
    }

    const token = typeof parsed.token === "string" ? parsed.token : "";
    if (!token) return null;

    const role: PosStaffRole = parsed.role === "manager" ? "manager" : "cashier";

    return {
      storeId,
      staffId: String(parsed.staffId ?? ""),
      staffNo: String(parsed.staffNo ?? ""),
      name: String(parsed.name ?? ""),
      role,
      permissions: normalizePosStaffPermissions(parsed.permissions, role),
      token,
      signedInAt: String(parsed.signedInAt ?? ""),
      expiresAt,
    };
  } catch {
    return null;
  }
}

export function saveOperatorSession(session: OperatorSession): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(keyFor(session.storeId), JSON.stringify(session));
  } catch {
    // 私隱模式／配額爆滿：唔可以阻住營運（簽到只會變「下次要再簽」）
  }
}

export function clearOperatorSession(storeId: string | null | undefined): void {
  if (!storeId || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(keyFor(storeId));
  } catch {
    // 同上
  }
}

/** 操作員可見嘅側欄模組 id。`null` = 冇操作員（沿用 L1 商家授權，全部可見）。 */
export function operatorVisiblePages(operator: OperatorSession | null): string[] | null {
  if (!operator) return null;
  return POS_STAFF_PAGE_IDS.filter((id) => operator.permissions.pages[id]);
}

/** 操作員可唔可以打開設備設定頁。冇操作員 = 可以（L1 決定）。 */
export function operatorCanOpenSettings(operator: OperatorSession | null): boolean {
  if (!operator) return true;
  return operator.permissions.actions.deviceSettings;
}

/** 操作員有冇某項操作權限。冇操作員 = `null`（呼叫方沿用 L1 行為）。 */
export function operatorAction(operator: OperatorSession | null, action: (typeof POS_STAFF_ACTION_IDS)[number]): boolean | null {
  if (!operator) return null;
  return operator.permissions.actions[action];
}
