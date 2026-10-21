import "server-only";

import { writeAdminAudit } from "@/lib/admin-audit.server";
import { hashAdminPinForStorage, verifyAdminPinForStorage } from "@/lib/admin-account-server";
import {
  PROTECTED_PLATFORM_ACCOUNT,
  isProtectedAccount,
  validateNewAccountInput,
  validatePinInput,
  validateStoreIdsInput,
  type AccountKind,
  type NewAccountInput,
} from "@/lib/admin-accounts-core";
import { resolveBindingMerchantIds, type StoreBindingLike } from "@/lib/admin-scope-core";
import { getLedgerServiceClient } from "@/lib/ledger/admin-server";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import type { UserRole } from "@/lib/types";

/**
 * Admin 帳號管理（2026-10-21 · 多店控制台 P2）。
 *
 * ## 職責
 *
 * 平台管理員建立／停用／重設 PIN／改綁店。呢個係**唯一**可以製造新後台身份嘅地方，
 * 所以權限一律 `requireAdmin({ platform: true })`（喺 route 層），本檔只做資料操作。
 *
 * ## 兩個組 = 兩種角色（刻意唔做 per-account permission 覆寫）
 *
 *   `admin-full` → 平台級（`manageAccounts` + `scopeAllStores`）
 *   `pos-owner`  → 店舖級（`adminPanelAccess`，只睇自己綁定嘅店）
 *
 * 好處：權限只有兩套，唔會出現「某帳號嘅某個 flag 同其他人唔同」呢類難查狀態。
 *
 * ## 建號一定要落 `admin_stores`
 *
 * `admin_account_store_bindings.store_id` 係 `admin_stores.id`。而 0025 已經清空
 * `admin_stores`，所以建號時要順手 upsert 店（id = Ledger merchant UUID，
 * 店名由 Ledger `merchants` 取）—— 否則 binding 會指向唔存在嘅店。
 */

export type AdminAccountDto = {
  id: string;
  account: string;
  name: string;
  role: UserRole;
  active: boolean;
  kind: AccountKind;
  permissionGroupCode: string | null;
  storeIds: string[];
  storeNames: Record<string, string>;
  mustChangePin: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  note: string;
};

export type AccountOpResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

const OWNER_GROUP_CODE = "pos-owner";
const PLATFORM_GROUP_CODE = "admin-full";

function isOwnerGroup(permissions: unknown): boolean {
  if (!permissions || typeof permissions !== "object") return false;
  const p = permissions as Record<string, unknown>;
  return p.adminPanelAccess === true && p.manageAccounts !== true;
}

async function loadStoreNames(ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (ids.length === 0) return out;

  const supabase = getSupabaseAdminClient();
  if (!supabase) return out;

  const { data } = await supabase.from("admin_stores").select("id, name").in("id", ids);
  for (const row of (data ?? []) as Array<{ id?: string; name?: string | null }>) {
    if (row.id) out[String(row.id)] = row.name ?? String(row.id);
  }

  // 未建店／冇名 → 試 Ledger merchants 取真名（純顯示用，失敗唔影響功能）
  const missing = ids.filter((id) => !out[id]);
  if (missing.length > 0) {
    const ledger = getLedgerServiceClient();
    if (ledger) {
      try {
        const { data: merchants } = await ledger.from("merchants").select("id, name").in("id", missing);
        for (const row of (merchants ?? []) as Array<{ id?: string; name?: string | null }>) {
          if (row.id) out[String(row.id)] = row.name ?? String(row.id);
        }
      } catch {
        // 忽略：冇名就顯示 id
      }
    }
  }
  return out;
}

/** 列出全部 admin 帳號（含綁店）。只供平台管理員。 */
export async function listAdminAccounts(): Promise<AccountOpResult<AdminAccountDto[]>> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return { ok: false, status: 503, error: "系統未配置資料庫。" };

  const [accountsRes, groupsRes, bindingsRes] = await Promise.all([
    supabase
      .from("admin_account_users")
      .select("id, account, name, role, active, permission_group_id, must_change_pin, last_login_at, created_at, note")
      .order("created_at", { ascending: true }),
    supabase.from("admin_permission_groups").select("id, code, permissions"),
    supabase.from("admin_account_store_bindings").select("account_id, store_id"),
  ]);

  if (accountsRes.error) {
    // 0070 未跑 → must_change_pin 欄不存在（42703）。明確講，唔好靜默。
    return {
      ok: false,
      status: 500,
      error: `讀取帳號失敗（若訊息含 must_change_pin，請先跑 migration 0070）：${accountsRes.error.message}`,
    };
  }
  if (groupsRes.error || bindingsRes.error) {
    return { ok: false, status: 500, error: "讀取權限組／店舖綁定失敗。" };
  }

  const groupById = new Map<string, { code: string | null; permissions: unknown }>();
  for (const g of (groupsRes.data ?? []) as Array<{ id?: string; code?: string | null; permissions?: unknown }>) {
    if (g.id) groupById.set(String(g.id), { code: g.code ?? null, permissions: g.permissions });
  }

  const bindingsByAccount = new Map<string, StoreBindingLike[]>();
  for (const b of (bindingsRes.data ?? []) as Array<{ account_id?: string; store_id?: string }>) {
    if (!b.account_id) continue;
    const list = bindingsByAccount.get(String(b.account_id)) ?? [];
    list.push({ store_id: b.store_id ?? null });
    bindingsByAccount.set(String(b.account_id), list);
  }

  const rows: AdminAccountDto[] = [];
  for (const a of (accountsRes.data ?? []) as Array<Record<string, unknown>>) {
    const group = groupById.get(String(a.permission_group_id ?? ""));
    const storeIds = resolveBindingMerchantIds(bindingsByAccount.get(String(a.id)) ?? []).ids;
    rows.push({
      id: String(a.id),
      account: String(a.account ?? ""),
      name: String(a.name ?? ""),
      role: (a.role ?? "cashier") as UserRole,
      active: Boolean(a.active),
      kind: isOwnerGroup(group?.permissions) ? "owner" : "platform",
      permissionGroupCode: group?.code ?? null,
      storeIds,
      storeNames: {},
      mustChangePin: Boolean(a.must_change_pin),
      lastLoginAt: (a.last_login_at as string | null) ?? null,
      createdAt: String(a.created_at ?? ""),
      note: String(a.note ?? ""),
    });
  }

  // 一次過補店名（避免 N+1）
  const allStoreIds = [...new Set(rows.flatMap((r) => r.storeIds))];
  const names = await loadStoreNames(allStoreIds);
  for (const r of rows) {
    r.storeNames = Object.fromEntries(r.storeIds.map((id) => [id, names[id] ?? id]));
  }

  return { ok: true, value: rows };
}

/** 建立帳號（平台管理員）。 */
export async function createAdminAccount(
  input: NewAccountInput,
  actor: string,
  ip?: string,
): Promise<AccountOpResult<{ account: string }>> {
  const validated = validateNewAccountInput(input);
  if (!validated.ok) return { ok: false, status: 400, error: validated.error };
  const value = validated.value;

  const supabase = getSupabaseAdminClient();
  if (!supabase) return { ok: false, status: 503, error: "系統未配置資料庫。" };

  // PIN 只存 hash（pepper 只喺 server env）；冇 pepper 就 fail closed，唔可以存明文。
  const pinHash = hashAdminPinForStorage(value.account, value.pin);
  if (!pinHash) {
    return { ok: false, status: 503, error: "系統未設定 AUTH_PIN_PEPPER，暫時唔可以建立帳號。" };
  }

  const { data: existing } = await supabase
    .from("admin_account_users")
    .select("id")
    .eq("account", value.account)
    .maybeSingle();
  if (existing) return { ok: false, status: 409, error: `帳號 ${value.account} 已存在。` };

  const groupCode = value.kind === "platform" ? PLATFORM_GROUP_CODE : OWNER_GROUP_CODE;
  const { data: group } = await supabase
    .from("admin_permission_groups")
    .select("id")
    .eq("code", groupCode)
    .maybeSingle();
  if (!group) {
    return {
      ok: false,
      status: 503,
      error: `搵唔到權限組 ${groupCode}，請先跑 migration 0070。`,
    };
  }

  const { data: inserted, error: insertError } = await supabase
    .from("admin_account_users")
    .insert({
      account: value.account,
      pin_hash: pinHash,
      // 明文欄位一律留空（0040 之後嘅新帳號只存 hash）
      pin_code: null,
      name: value.name,
      role: value.kind === "platform" ? "admin" : "manager",
      active: true,
      permission_group_id: group.id,
      must_change_pin: true,
      created_by: actor,
      note: value.kind === "platform" ? "平台管理員（P2 建立）" : "店舖級後台帳號（P2 建立）",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    return { ok: false, status: 500, error: `建立帳號失敗：${insertError?.message ?? "未知錯誤"}` };
  }

  if (value.storeIds.length > 0) {
    // 確保 admin_stores 有對應 row（0025 之後係空表；id 用 merchant UUID）
    const names = await loadStoreNames(value.storeIds);
    await supabase.from("admin_stores").upsert(
      value.storeIds.map((id) => ({
        id,
        name: names[id] ?? id,
        active: true,
        merchant_id: id,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "id" },
    );

    const { error: bindError } = await supabase.from("admin_account_store_bindings").insert(
      value.storeIds.map((storeId) => ({ account_id: inserted.id, store_id: storeId })),
    );
    if (bindError) {
      return {
        ok: false,
        status: 500,
        error: `帳號已建立，但綁店失敗（請手動補綁）：${bindError.message}`,
      };
    }
  }

  await writeAdminAudit({
    account: actor,
    action: "write",
    target: "admin_account.create",
    storeIds: value.storeIds,
    detail: { created: value.account, kind: value.kind },
    ip,
  });

  return { ok: true, value: { account: value.account } };
}

/** 更新帳號：停用／啟用、重設 PIN、改綁店。 */
export async function updateAdminAccount(
  account: string,
  patch: { active?: unknown; pin?: unknown; storeIds?: unknown },
  actor: string,
  ip?: string,
): Promise<AccountOpResult<{ account: string }>> {
  const target = String(account ?? "").trim();
  if (!target) return { ok: false, status: 400, error: "缺少帳號。" };

  const supabase = getSupabaseAdminClient();
  if (!supabase) return { ok: false, status: 503, error: "系統未配置資料庫。" };

  const { data: row } = await supabase
    .from("admin_account_users")
    .select("id, account, active, permission_group_id")
    .eq("account", target)
    .maybeSingle();
  if (!row) return { ok: false, status: 404, error: `搵唔到帳號 ${target}。` };

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const audit: Record<string, unknown> = {};

  if (typeof patch.active === "boolean") {
    if (!patch.active && isProtectedAccount(target)) {
      return {
        ok: false,
        status: 400,
        error: `帳號 ${PROTECTED_PLATFORM_ACCOUNT} 係平台總管理，唔可以停用（停咗就冇人管得到後台）。`,
      };
    }
    updates.active = patch.active;
    // 停用時順手清零鎖定，避免重開之後仍然被舊失敗次數鎖住。
    if (!patch.active) {
      updates.failed_login_count = 0;
      updates.locked_until = null;
    }
    audit.active = patch.active;
  }

  if (patch.pin !== undefined) {
    const pinCheck = validatePinInput(patch.pin);
    if (!pinCheck.ok) return { ok: false, status: 400, error: pinCheck.error };
    const pinHash = hashAdminPinForStorage(target, pinCheck.value);
    if (!pinHash) {
      return { ok: false, status: 503, error: "系統未設定 AUTH_PIN_PEPPER，暫時唔可以重設 PIN。" };
    }
    updates.pin_hash = pinHash;
    updates.pin_code = null;
    updates.must_change_pin = true; // 重設後要求本人改
    updates.failed_login_count = 0;
    updates.locked_until = null;
    audit.pinReset = true;
  }

  if (patch.storeIds !== undefined) {
    const storesCheck = validateStoreIdsInput(patch.storeIds);
    if (!storesCheck.ok) return { ok: false, status: 400, error: storesCheck.error };
    const storeIds = storesCheck.value;

    // 平台帳號唔靠 binding（scope.all），改綁店對佢冇意義 —— 但仍然容許設定，
    // 方便日後把平台帳號降級做店主時即刻有店。
    const names = await loadStoreNames(storeIds);
    await supabase.from("admin_stores").upsert(
      storeIds.map((id) => ({
        id,
        name: names[id] ?? id,
        active: true,
        merchant_id: id,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "id" },
    );

    const del = await supabase.from("admin_account_store_bindings").delete().eq("account_id", row.id);
    if (del.error) return { ok: false, status: 500, error: `清除舊綁定失敗：${del.error.message}` };

    const ins = await supabase
      .from("admin_account_store_bindings")
      .insert(storeIds.map((storeId) => ({ account_id: row.id, store_id: storeId })));
    if (ins.error) return { ok: false, status: 500, error: `寫入新綁定失敗：${ins.error.message}` };

    audit.storeCount = storeIds.length;
  }

  const { error } = await supabase.from("admin_account_users").update(updates).eq("id", row.id);
  if (error) {
    // 0068/0070 未跑時，failed_login_count / must_change_pin 可能唔存在 → 明確講
    return { ok: false, status: 500, error: `更新帳號失敗：${error.message}` };
  }

  await writeAdminAudit({
    account: actor,
    action: "write",
    target: "admin_account.update",
    detail: { target, ...audit },
    ip,
  });

  return { ok: true, value: { account: target } };
}

/** 自己改 PIN（首登強制改 / 平時改）。 */
export async function changeOwnPin(
  account: string,
  oldPin: unknown,
  newPin: unknown,
  ip?: string,
): Promise<AccountOpResult<{ account: string }>> {
  const target = String(account ?? "").trim();
  const oldCheck = validatePinInput(oldPin);
  if (!oldCheck.ok) return { ok: false, status: 400, error: "請輸入 4 位舊 PIN。" };
  const newCheck = validatePinInput(newPin);
  if (!newCheck.ok) return { ok: false, status: 400, error: newCheck.error };
  if (oldCheck.value === newCheck.value) {
    return { ok: false, status: 400, error: "新 PIN 唔可以同舊 PIN 一樣。" };
  }

  const supabase = getSupabaseAdminClient();
  if (!supabase) return { ok: false, status: 503, error: "系統未配置資料庫。" };

  const { data: row } = await supabase
    .from("admin_account_users")
    .select("*")
    .eq("account", target)
    .maybeSingle();
  if (!row) return { ok: false, status: 404, error: "搵唔到帳號。" };
  if (!row.active) return { ok: false, status: 403, error: "此帳戶已停用。" };

  if (!verifyAdminPinForStorage(row as Record<string, unknown>, oldCheck.value)) {
    return { ok: false, status: 401, error: "舊 PIN 不正確。" };
  }

  const pinHash = hashAdminPinForStorage(target, newCheck.value);
  if (!pinHash) return { ok: false, status: 503, error: "系統未設定 AUTH_PIN_PEPPER。" };

  const { error } = await supabase
    .from("admin_account_users")
    .update({
      pin_hash: pinHash,
      pin_code: null,
      must_change_pin: false,
      failed_login_count: 0,
      locked_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  if (error) return { ok: false, status: 500, error: `修改 PIN 失敗：${error.message}` };

  await writeAdminAudit({ account: target, action: "write", target: "admin_account.change_pin", ip });
  return { ok: true, value: { account: target } };
}
