/**
 * 帳號管理純驗證（2026-10-21 · 多店控制台 P2）。
 *
 * 唔 import `server-only`：方便 `node --test` 直接測（同 admin-scope-core 一樣）。
 *
 * ## 為何要集中在一個純函數
 *
 * 建號／改號係**唯一**可以製造新權限嘅入口。呢啲規則（8 位帳號、4 位 PIN、
 * 店主最多 20 店、必須至少有 1 間店）如果散落在 route / SQL / UI 三處，
 * 一定有一處漏。集中在呢度 + 單測，route 只負責 I/O。
 */

export type AccountKind = "platform" | "owner";

export const ACCOUNT_PATTERN = /^\d{8}$/;
export const PIN_PATTERN = /^\d{4}$/;
export const MAX_STORES_PER_ACCOUNT = 20;
export const MAX_NAME_LEN = 40;

export type NewAccountInput = {
  account: string;
  pin: string;
  name: string;
  kind: AccountKind;
  storeIds?: unknown;
};

export type NewAccountValue = {
  account: string;
  pin: string;
  name: string;
  kind: AccountKind;
  /** 平台級 = 空陣列（唔靠 binding，scope.all 由 manageAccounts 推導） */
  storeIds: string[];
};

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function asStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const id = String(raw ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 驗證「新建帳號」輸入。
 *
 * 🔴 店主（owner）**必須**有 1–20 間店：0 間店嘅店主登入會被拒（`/api/admin/session` 的
 *    `no_scope` 分支），與其建完之後才發現登入唔到，不如喺建立時就報錯。
 */
export function validateNewAccountInput(input: NewAccountInput): ValidationResult<NewAccountValue> {
  const account = String(input.account ?? "").trim();
  // PIN 只接受字串（避免 0123 這類前導 zero 被 JSON number 吃掉）
  const pin = typeof input.pin === "string" ? input.pin.trim() : "";
  const name = String(input.name ?? "").trim();
  const kind: AccountKind = input.kind === "platform" ? "platform" : "owner";

  if (!ACCOUNT_PATTERN.test(account)) return { ok: false, error: "帳號必須係 8 位數字。" };
  if (!PIN_PATTERN.test(pin)) return { ok: false, error: "PIN 必須係 4 位數字。" };
  if (!name) return { ok: false, error: "請輸入名稱。" };
  if (name.length > MAX_NAME_LEN) return { ok: false, error: `名稱唔可以超過 ${MAX_NAME_LEN} 個字。` };

  const storeIds = asStringArray(input.storeIds);

  if (kind === "owner") {
    if (storeIds.length === 0) return { ok: false, error: "店舖級帳號至少要綁 1 間店。" };
    if (storeIds.length > MAX_STORES_PER_ACCOUNT) {
      return { ok: false, error: `一個帳號最多綁 ${MAX_STORES_PER_ACCOUNT} 間店。` };
    }
  }

  return {
    ok: true,
    value: {
      account,
      pin,
      name,
      kind,
      // 平台級刻意唔綁店：佢嘅範圍係「全部」，綁定只會造成誤解。
      storeIds: kind === "owner" ? storeIds : [],
    },
  };
}

/** 驗證「換店」輸入（PATCH）。 */
export function validateStoreIdsInput(input: unknown): ValidationResult<string[]> {
  const storeIds = asStringArray(input);
  if (storeIds.length === 0) return { ok: false, error: "至少要綁 1 間店。" };
  if (storeIds.length > MAX_STORES_PER_ACCOUNT) {
    return { ok: false, error: `一個帳號最多綁 ${MAX_STORES_PER_ACCOUNT} 間店。` };
  }
  return { ok: true, value: storeIds };
}

/** 驗證「重設 PIN」。只接受**字串**（數字 1234 會被當成 1234 而靜靜通過，唔好留呢個窿）。 */
export function validatePinInput(pin: unknown): ValidationResult<string> {
  if (typeof pin !== "string") return { ok: false, error: "PIN 必須係 4 位數字。" };
  const value = pin.trim();
  if (!PIN_PATTERN.test(value)) return { ok: false, error: "PIN 必須係 4 位數字。" };
  return { ok: true, value };
}

/**
 * 帳號係咪「可以刪／可以停用」——平台總管理帳號（60000000）唔准停用，
 * 否則一停就冇人有 `manageAccounts`，整個後台鎖死（要入 DB 救）。
 */
export const PROTECTED_PLATFORM_ACCOUNT = "60000000";

export function isProtectedAccount(account: string): boolean {
  return String(account ?? "").trim() === PROTECTED_PLATFORM_ACCOUNT;
}
