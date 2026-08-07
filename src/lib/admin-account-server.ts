import "server-only";

import { defaultAccountStores, defaultAccountUsers, defaultPermissionGroups } from "@/lib/mock-data";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { AuthSession } from "@/lib/storage";
import { AccountPermissionGroup, AccountStore, AccountUser, UserPermissions, UserRole } from "@/lib/types";

function defaultPermissionsForRole(role: UserRole): UserPermissions {
  if (role === "admin") return { refundOrder: true, voidItem: true, manageAccounts: true };
  if (role === "manager") return { refundOrder: true, voidItem: true, manageAccounts: false };
  return { refundOrder: false, voidItem: false, manageAccounts: false };
}

function buildSession(account: AccountUser): AuthSession {
  return {
    account: account.account,
    name: account.name,
    role: account.role,
    storeIds: account.storeIds,
    permissionGroupId: account.permissionGroupId,
    permissions: account.permissions,
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
      storeIds: storeIds?.length ? storeIds : account.storeIds ?? ["macau-store-a"],
      permissions: mergePermissions(account.role, group, account),
    };
  });
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
    return { ok: true as const, source: "mock" as const, session: buildSession(matched) };
  }

  const { data: accountRow, error } = await supabase
    .from("admin_account_users")
    .select("*")
    .eq("account", account)
    .eq("pin_code", pin)
    .maybeSingle();

  if (error || !accountRow) {
    return { ok: false as const, error: "帳號或密碼不正確。", source: "supabase" as const };
  }

  if (!accountRow.active) {
    return { ok: false as const, error: "此帳戶已停用，請聯絡管理員。", source: "supabase" as const };
  }

  const [{ data: groups }, { data: bindings }] = await Promise.all([
    supabase.from("admin_permission_groups").select("*"),
    supabase.from("admin_account_store_bindings").select("account_id, store_id").eq("account_id", accountRow.id),
  ]);

  const role = (accountRow.role ?? "cashier") as UserRole;
  const permissionGroup = (groups ?? []).find((item) => item.id === accountRow.permission_group_id) as
    | AccountPermissionGroup
    | undefined;
  const enriched: AccountUser = {
    id: accountRow.id,
    account: accountRow.account,
    pin: accountRow.pin_code,
    name: accountRow.name,
    role,
    active: Boolean(accountRow.active),
    storeIds: (bindings ?? []).map((item) => item.store_id),
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

export async function listAdminDataFromServer() {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return {
      ok: true as const,
      dbConfigured: false,
      source: "mock" as const,
      accounts: enrichAccounts(defaultAccountUsers, defaultPermissionGroups),
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

  const mappedAccounts: AccountUser[] = (accounts ?? []).map((row) => ({
    id: row.id,
    account: row.account,
    pin: row.pin_code,
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

  const mappedStores: AccountStore[] = (stores ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    note: row.note ?? "",
  }));

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

  return {
    ok: true as const,
    dbConfigured: true,
    source: "supabase" as const,
    accounts: enrichAccounts(
      mappedAccounts,
      mappedGroups,
      (bindings ?? []).map((item) => ({ accountId: item.account_id, storeId: item.store_id })),
    ),
    stores: mappedStores,
    permissionGroups: mappedGroups,
  };
}
