import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  isMissingColumnError,
  resolveBindingMerchantIds,
  type StoreBindingLike,
} from "@/lib/admin-scope-core";
import {
  isLocked,
  lockRemainingSec,
  lockoutFromRow,
  lockoutToRow,
  onFailure,
  onSuccess,
  type LockoutState,
} from "@/lib/admin-login-lockout";
import { defaultAccountStores, defaultAccountUsers, defaultPermissionGroups } from "@/lib/mock-data";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { AuthSession } from "@/lib/storage";
import { AccountPermissionGroup, AccountStore, AccountUser, UserPermissions, UserRole } from "@/lib/types";

function defaultPermissionsForRole(role: UserRole): UserPermissions {
  if (role === "admin") return { refundOrder: true, voidItem: true, manageAccounts: true, reprintReceipt: true };
  if (role === "manager") return { refundOrder: true, voidItem: true, manageAccounts: false, reprintReceipt: true };
  return { refundOrder: false, voidItem: false, manageAccounts: false, reprintReceipt: true };
}

/** 由 response 中清除所有 PIN（敏感資料保護）。 */
function stripPins<T extends { pin?: string }>(items: T[]): T[] {
  return items.map((item) => ({ ...item, pin: "" }));
}

function buildSession(account: AccountUser): AuthSession {
  return {
    account: account.account,
    name: account.name,
    role: account.role,
    storeIds: account.storeIds,
    permissionGroupId: account.permissionGroupId,
    permissions: account.permissions,
    // 首登強制改 PIN（P2）：由 `admin_account_users.must_change_pin` 帶上嚟，
    // 前端靠呢個開彈窗；`normalizeAuthSession()` 亦會保留。
    mustChangePin: account.mustChangePin === true ? true : undefined,
    loggedInAt: new Date().toISOString(),
  };
}

function mergePermissions(role: UserRole, group?: AccountPermissionGroup | null, account?: Partial<AccountUser>) {
  return {
    ...defaultPermissionsForRole(role),
    ...(group?.permissions ?? {}),
    ...(account?.permissions ?? {}),
  };
}

function enrichAccounts(
  accounts: AccountUser[],
  permissionGroups: AccountPermissionGroup[],
  bindings?: Array<{ accountId: string; storeId: string }>,
) {
  return accounts.map((account) => {
    const group = permissionGroups.find((item) => item.id === account.permissionGroupId);
    const storeIds =
      bindings && bindings.length > 0
        ? bindings.filter((item) => item.accountId === account.id).map((item) => item.storeId)
        : account.storeIds;
    return {
      ...account,
      storeIds: storeIds?.length ? storeIds : account.storeIds ?? [],
      permissions: mergePermissions(account.role, group, account),
    };
  });
}

/** 機會式 PIN hash 升級失敗只 log 一次（避免每次登入都刷 log）。 */
let warnedPinUpgradeSkip = false;

/** 「有 pin_hash 但 AUTH_PIN_PEPPER 未設」只 log 一次。 */
let warnedMissingPinPepper = false;

/**
 * 管理員 PIN 的 HMAC-SHA256 hash（2026-09-15 資安加固）。
 *
 * 公式必須同 migration `0040` 完全一致，否則登入會失敗：
 *   pin_hash = HMAC-SHA256(key = AUTH_PIN_PEPPER, msg = `${account}:${pin}`) → 小寫 hex
 *   SQL 版：encode(hmac(account || ':' || pin_code, <pepper>, 'sha256'), 'hex')
 *
 * `account` 當 salt ⇒ 兩個員工用同一個 PIN，hash 都唔同。
 * 🔴 pepper 只存在 server env；4 位 PIN 只有 ~13 bits 熵，**唯一保護就係「pepper 唔喺 DB」**。
 */
function deriveAdminPinHash(account: string, pin: string, pepper: string): string {
  return createHmac("sha256", pepper).update(`${account}:${pin}`).digest("hex");
}

/** 常數時間比對（長度唔同即 false），防 timing attack。 */
function safeEqualText(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 驗證 PIN：**優先 `pin_hash`（HMAC，新路徑）**，回退明文 `pin_code`（過渡期）。
 *
 * 回傳命中方式；`null` = 驗證失敗。
 *
 * 為何要保留明文回退（過渡期）：
 *   ① migration `0040` 未跑 → row 冇 `pin_hash` 欄 ⇒ 只可以靠明文；
 *   ② 0040 跑咗但某些帳號未回填（新加帳號）→ 都要靠明文。
 *   少咗呢個回退，任何一步次序錯就會**鎖死登入**。
 *   等 0040 §5 清空明文之後，呢個分支自然變成死碼（可以移走）。
 */
function verifyAdminPin(row: Record<string, unknown>, pin: string, pepper: string): "hash" | "plain" | null {
  const pinHash = typeof row.pin_hash === "string" ? row.pin_hash : "";
  if (pinHash && pepper) {
    const account = typeof row.account === "string" ? row.account : "";
    if (safeEqualText(deriveAdminPinHash(account, pin, pepper), pinHash)) return "hash";
  }
  const plain = typeof row.pin_code === "string" ? row.pin_code : "";
  // 明文命中只喺「有明文」時才可能；`pin` 空字串唔可以命中空明文。
  if (plain && pin && safeEqualText(pin, plain)) return "plain";
  return null;
}

/** 落 DB 失敗只 log 一次（0068 未跑 → 42703；**唔可以**因此令登入失敗）。 */
let warnedLockoutWriteSkip = false;

/**
 * 供「帳號管理」（P2）寫入新 PIN hash 用。
 * @returns `null` = 冇設 `AUTH_PIN_PEPPER` ⇒ 呼叫端必須 fail closed（唔可以存明文）。
 */
export function hashAdminPinForStorage(account: string, pin: string): string | null {
  const pepper = process.env.AUTH_PIN_PEPPER?.trim() ?? "";
  if (!pepper) return null;
  return deriveAdminPinHash(account, pin, pepper);
}

/** 驗證「舊 PIN」用（改自己 PIN 時要驗）：hash 優先、明文回退，同登入同一套邏輯。 */
export function verifyAdminPinForStorage(row: Record<string, unknown>, pin: string): boolean {
  const pepper = process.env.AUTH_PIN_PEPPER?.trim() ?? "";
  return verifyAdminPin(row, pin, pepper) !== null;
}

/**
 * 把鎖定狀態寫返 DB（2026-10-21 · P0-2）。
 *
 * 🔴 一定要落 DB，唔可以只放記憶體：Vercel 多 instance，每個 instance 各自計數，
 *    實際可試次數 = 5 × instance 數，冷啟動即清零 —— 等於冇鎖。
 * ⚠️ 寫入失敗（migration 0068 未跑）→ 只 warn 一次，**唔影響登入**，
 *    寧願暫時冇鎖，都唔可以令所有人登入唔到。
 */
async function persistLockout(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdminClient>>,
  accountRowId: unknown,
  state: LockoutState,
): Promise<void> {
  const { error } = await supabase
    .from("admin_account_users")
    .update(lockoutToRow(state))
    .eq("id", accountRowId);
  if (error && !warnedLockoutWriteSkip) {
    warnedLockoutWriteSkip = true;
    console.warn(
      "[admin-account] 鎖定狀態寫入失敗（可能 migration 0068 未跑；**唔影響登入**）：",
      error.message,
    );
  }
}

export async function authenticateAccountFromServer(account: string, pin: string) {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    const matched = defaultAccountUsers.find((item) => item.account === account && item.pin === pin);
    if (!matched) {
      return { ok: false as const, error: "帳號或密碼不正確。", source: "mock" as const };
    }
    if (!matched.active) {
      return { ok: false as const, error: "此帳戶已停用，請聯絡管理員。", source: "mock" as const };
    }
    // mock 模式都唔回傳 PIN（敏感資料保護）
    return { ok: true as const, source: "mock" as const, session: buildSession({ ...matched, pin: "" }) };
  }

  // 🔴 2026-09-15 資安加固：**唔再用 `.eq("pin_code", pin)`**（等同明文儲存 + 明文比對）。
  // 改為只按 account 取 row，再喺 JS 內驗證（優先 `pin_hash`，回退明文）。
  // ⚠️ 必須保持「查唔到帳號」同「密碼錯」回**同一個訊息** —— 唔可以洩露帳號是否存在。
  const { data: accountRow, error } = await supabase
    .from("admin_account_users")
    .select("*")
    .eq("account", account)
    .maybeSingle();

  if (error || !accountRow) {
    return { ok: false as const, error: "帳號或密碼不正確。", source: "supabase" as const };
  }

  // ── 失敗鎖定（2026-10-21 · P0-2，對應 D2「沿用 4 位 PIN」）──────────────
  // 4 位 PIN 只有 10⁴ 組合、帳號係可枚舉嘅電話格式 ⇒ 必須 per-account 鎖定，
  // 唔可以只靠 IP rate limit（換 IP 即繞過）。
  // 🔴 鎖定期間**唔會再驗 PIN**（連正確 PIN 都拒），否則鎖定期間照樣可以慢慢爆破。
  const nowMs = Date.now();
  const lockout = lockoutFromRow(accountRow as Record<string, unknown>);
  if (isLocked(lockout, nowMs)) {
    return {
      ok: false as const,
      code: "locked" as const,
      retryAfterSec: lockRemainingSec(lockout, nowMs),
      error: "登入嘗試次數過多，請稍後再試。",
      source: "supabase" as const,
    };
  }

  const pinPepper = process.env.AUTH_PIN_PEPPER?.trim() ?? "";
  // 🔴 誤配置偵測：DB 已經有 hash，但 server 冇 pepper ⇒ 只可以回退明文。
  // 若連明文都清空（0040 §5）就會**完全登入唔到**。唔可以靜默，所以大聲 log 一次。
  if (!pinPepper && typeof (accountRow as Record<string, unknown>).pin_hash === "string") {
    if (!warnedMissingPinPepper) {
      warnedMissingPinPepper = true;
      console.error(
        "[admin-account] ⚠️ 帳號已有 pin_hash，但 `AUTH_PIN_PEPPER` 未設 → 只能回退明文比對。" +
          "若已執行 0040 §5 清空明文，將會**完全無法登入**。請即刻補設 Vercel env `AUTH_PIN_PEPPER`。",
      );
    }
  }
  const pinMatch = verifyAdminPin(accountRow as Record<string, unknown>, pin, pinPepper);
  if (!pinMatch) {
    // 記一次失敗（第 5 次即鎖 15 分鐘）。寫 DB 失敗唔阻流程（見 persistLockout）。
    const next = onFailure(lockout, nowMs);
    await persistLockout(supabase, accountRow.id, next);
    if (next.lockedUntilMs !== null) {
      return {
        ok: false as const,
        code: "locked" as const,
        retryAfterSec: lockRemainingSec(next, nowMs),
        error: "登入嘗試次數過多，請稍後再試。",
        source: "supabase" as const,
      };
    }
    // ⚠️ 「帳號不存在」同「PIN 錯」回同一句 —— 唔可以洩露帳號是否存在。
    return { ok: false as const, code: "invalid" as const, error: "帳號或密碼不正確。", source: "supabase" as const };
  }

  if (!accountRow.active) {
    return { ok: false as const, code: "inactive" as const, error: "此帳戶已停用，請聯絡管理員。", source: "supabase" as const };
  }

  // 成功登入 → 清零（只在真係有計數／有鎖時才寫，避免每次登入多一次 UPDATE）。
  if (lockout.failedLoginCount > 0 || lockout.lockedUntilMs !== null) {
    await persistLockout(supabase, accountRow.id, onSuccess());
  }

  // ── 機會式升級（opportunistic upgrade）────────────────────────────────
  // 明文命中且有 pepper → 即刻把 `pin_hash` 寫入該帳號。
  // 效果：即使用戶**未跑** 0040 §2 嘅批量回填，活躍帳號都會喺第一次成功登入時自動上 hash。
  // 🔴 失敗**絕對唔可以**阻礙登入（例：0040 未跑 → 42703 欄位唔存在）→ 只 log 一次。
  if (pinMatch === "plain" && pinPepper) {
    const { error: upgradeError } = await supabase
      .from("admin_account_users")
      .update({ pin_hash: deriveAdminPinHash(account, pin, pinPepper) })
      .eq("id", accountRow.id);
    if (upgradeError && !warnedPinUpgradeSkip) {
      warnedPinUpgradeSkip = true;
      console.warn(
        "[admin-account] PIN 機會式升級未生效（可能 0040 未跑；**唔影響登入**）：",
        upgradeError.message,
      );
    }
  }

  const [groupsRes, bindingsRes] = await Promise.all([
    supabase.from("admin_permission_groups").select("*"),
    // 🔴 2026-10-21（P1）：一定要帶 `merchant_id`。bindings 嘅 `store_id` 係
    // `admin_stores.id`（舊文本 id，例如 macau-store-a），**唔係** POS 嘅 store_id。
    // 只讀 `store_id` 會令 session.storeIds 同真正可見範圍（merchant UUID）對唔上，
    // 而且當 binding 只填 merchant_id（store_id 可為 null）時會拿到 null。
    supabase
      .from("admin_account_store_bindings")
      .select("account_id, store_id, merchant_id")
      .eq("account_id", accountRow.id),
  ]);

  // ⛔ migration 0024 未跑 → bindings 冇 `merchant_id` 欄（42703）。
  // 對平台帳號無影響（佢哋唔靠 bindings），但店舖級帳號會變「零可見店舖」。
  // ⇒ 降級只讀 `store_id`，並靠 `resolveBindingMerchantIds()` 嘅第 ③ 條
  //   （store_id 本身係 UUID = 0025 §5 建議做法）解析。
  let bindings: StoreBindingLike[] = (bindingsRes.data ?? []) as StoreBindingLike[];
  if (bindingsRes.error && isMissingColumnError(bindingsRes.error)) {
    console.warn(
      "[admin-account] migration 0024 未跑（bindings 冇 merchant_id）→ 降級用 store_id 解析。" +
        "只有本身係 UUID 嘅 store_id 才算有效。",
    );
    const legacy = await supabase
      .from("admin_account_store_bindings")
      .select("account_id, store_id")
      .eq("account_id", accountRow.id);
    bindings = (legacy.data ?? []) as StoreBindingLike[];
  }

  const groups = groupsRes.data;

  const role = (accountRow.role ?? "cashier") as UserRole;
  const permissionGroup = (groups ?? []).find((item) => item.id === accountRow.permission_group_id) as
    | AccountPermissionGroup
    | undefined;
  const enriched: AccountUser = {
    id: accountRow.id,
    account: accountRow.account,
    // 登入成功後唔需要保留 PIN 喺 session 物件入面（敏感資料保護）
    pin: "",
    name: accountRow.name,
    role,
    active: Boolean(accountRow.active),
    // 首登強制改 PIN（P2）；欄位未加（0070 未跑）時為 undefined = 唔強制。
    mustChangePin: accountRow.must_change_pin === true ? true : undefined,
    // 優先 merchant_id；冇就靠 store_id（本身係 UUID 才算）。
    // 詳見 `resolveBindingMerchantIds()` 的三級優先序。
    storeIds: resolveBindingMerchantIds(bindings ?? []).ids,
    permissionGroupId: accountRow.permission_group_id ?? undefined,
    permissions: mergePermissions(role, permissionGroup, undefined),
    createdAt: accountRow.created_at,
    updatedAt: accountRow.updated_at,
    lastLoginAt: accountRow.last_login_at ?? undefined,
    note: accountRow.note ?? "",
  };

  const now = new Date().toISOString();
  await supabase.from("admin_account_users").update({ last_login_at: now, updated_at: now }).eq("id", accountRow.id);

  return {
    ok: true as const,
    source: "supabase" as const,
    session: {
      ...buildSession(enriched),
      loggedInAt: now,
    },
  };
}

/**
 * 伺服器端列出所有管理帳戶（DB 已配置時）。
 * 用嚟俾管理頁面初始化資料。
 *
 * 2026-08-31 資安修復（docs/89 §2）：**絕對唔回傳 PIN**。舊 code 會 `pin: row.pin_code`
 * 一齊 return，等於任何人打 `/api/admin/accounts` 就拎晒所有員工 4 位 PIN（明文）。
 * 呢度改爲一律留空；改 PIN 係獨立操作，唔需要 server 返 PIN 俾前端。
 */
export async function listAdminDataFromServer() {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
  return {
    ok: true as const,
    dbConfigured: false,
    source: "mock" as const,
    accounts: stripPins(enrichAccounts(defaultAccountUsers, defaultPermissionGroups)),
    stores: defaultAccountStores,
    permissionGroups: defaultPermissionGroups,
  };
  }

  const [{ data: accounts, error: accountError }, { data: stores }, { data: permissionGroups }, { data: bindings }] =
    await Promise.all([
      supabase.from("admin_account_users").select("*").order("created_at", { ascending: true }),
      supabase.from("admin_stores").select("*").order("created_at", { ascending: true }),
      supabase.from("admin_permission_groups").select("*").order("created_at", { ascending: true }),
      supabase.from("admin_account_store_bindings").select("account_id, store_id"),
    ]);

  if (accountError) {
    return { ok: false as const, error: accountError.message };
  }

  const mappedGroups: AccountPermissionGroup[] = (permissionGroups ?? []).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    role: row.role as UserRole,
    permissions: (row.permissions ?? defaultPermissionsForRole(row.role as UserRole)) as UserPermissions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    note: row.note ?? "",
  }));

  const mappedAccounts: AccountUser[] = (accounts ?? []).map((row) => ({
    id: row.id,
    account: row.account,
    pin: "", // 資安：唔回傳 PIN（見上方註解）
    name: row.name,
    role: row.role as UserRole,
    active: Boolean(row.active),
    storeIds: [],
    permissionGroupId: row.permission_group_id ?? undefined,
    permissions: defaultPermissionsForRole((row.role ?? "cashier") as UserRole),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? undefined,
    note: row.note ?? "",
  }));

  // 雙保險：enrichAccounts 之後再清一次（萬一 enrich 引入咗含 pin 嘅 mock fallback）
  const safeAccounts = stripPins(
    enrichAccounts(
      mappedAccounts,
      mappedGroups,
      (bindings ?? []).map((item) => ({ accountId: item.account_id, storeId: item.store_id })),
    ),
  );

  const mappedStores: AccountStore[] = (stores ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    note: row.note ?? "",
  }));

  return {
    ok: true as const,
    dbConfigured: true,
    source: "supabase" as const,
    accounts: safeAccounts,
    stores: mappedStores,
    permissionGroups: mappedGroups,
  };
}
