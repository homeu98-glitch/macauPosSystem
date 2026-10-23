import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { hashPosStaffPin, verifyPosStaffPin } from "@/lib/pos/staff-pin";
import {
  POS_STAFF_LOCK_MS,
  POS_STAFF_MAX_FAILED_ATTEMPTS,
  POS_STAFF_MAX_PER_STORE,
  normalizePosStaffPermissions,
  normalizeStaffNo,
  type PosStaffDto,
  type PosStaffDraft,
  type PosStaffRole,
} from "@/lib/pos/staff-core";

/**
 * `pos_staff` 表嘅 server 端讀寫（migration 0072）。
 *
 * ## 三條鐵律
 *
 * ① **只可以用 `getSupabaseAdminClient()`**：張表 RLS 係 service_role only，
 *    anon key 讀寫會靜默失敗（回空陣列／0 row，唔會 throw）。
 * ② **PIN 永遠唔會離開伺服器**：DTO 冇 `pin_hash` / `pin_salt`。
 * ③ **表未建 = 可預期狀態**：`tableMissing: true`，route 回 200 + 提示，
 *    唔可以爆 500（migration 要人手跑，見 memory 高頻坑）。
 */

const STAFF_COLUMNS =
  "id, store_id, staff_no, name, role, permissions, active, must_change_pin, last_login_at, locked_until, note, created_at, updated_at";

export type StaffFailure = {
  ok: false;
  error: string;
  status: number;
  tableMissing?: boolean;
};

function isMissingStaffTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return /42P01|PGRST205|does not exist|schema cache/i.test(`${error.code ?? ""} ${error.message ?? ""}`);
}

function dbMissing(): StaffFailure {
  return {
    ok: false,
    error: "資料庫未配置（缺少 service-role key），店員資料暫時不可用。",
    status: 503,
  };
}

function tableMissingFailure(): StaffFailure {
  return {
    ok: false,
    error: "店員權限表未建立：請先執行 migration 0072_pos_staff_permissions.sql。",
    status: 200,
    tableMissing: true,
  };
}

function toDto(row: Record<string, unknown>): PosStaffDto {
  const role: PosStaffRole = row.role === "manager" ? "manager" : "cashier";
  return {
    id: String(row.id ?? ""),
    storeId: String(row.store_id ?? ""),
    staffNo: String(row.staff_no ?? ""),
    name: String(row.name ?? ""),
    role,
    // 白名單正規化：DB 可能有舊版／未知 key
    permissions: normalizePosStaffPermissions(row.permissions, role),
    active: row.active === true,
    mustChangePin: row.must_change_pin === true,
    lastLoginAt: typeof row.last_login_at === "string" ? row.last_login_at : null,
    lockedUntil: typeof row.locked_until === "string" ? row.locked_until : null,
    note: String(row.note ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

export type ListStaffResult = { ok: true; staff: PosStaffDto[]; tableMissing: boolean } | StaffFailure;

export async function listPosStaff(storeId: string): Promise<ListStaffResult> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return dbMissing();

  const { data, error } = await supabase
    .from("pos_staff")
    .select(STAFF_COLUMNS)
    .eq("store_id", storeId)
    .order("staff_no", { ascending: true });

  if (error) {
    if (isMissingStaffTable(error)) return tableMissingFailure();
    console.error("[pos-staff] 讀取店員失敗", { storeId, message: error.message });
    return { ok: false, error: "讀取店員資料失敗，請稍後再試。", status: 502 };
  }

  return {
    ok: true,
    staff: (data ?? []).map((row) => toDto(row as Record<string, unknown>)),
    tableMissing: false,
  };
}

export type StaffMutationResult = { ok: true; staff: PosStaffDto } | StaffFailure;

export async function createPosStaff(params: {
  storeId: string;
  draft: PosStaffDraft;
  actor: string;
}): Promise<StaffMutationResult> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return dbMissing();

  // 上限檢查（唔靠 DB，因為「幾多個先算多」係產品決定）
  const { count, error: countError } = await supabase
    .from("pos_staff")
    .select("id", { count: "exact", head: true })
    .eq("store_id", params.storeId);

  if (countError) {
    if (isMissingStaffTable(countError)) return tableMissingFailure();
    return { ok: false, error: "讀取店員數量失敗，請稍後再試。", status: 502 };
  }
  if ((count ?? 0) >= POS_STAFF_MAX_PER_STORE) {
    return {
      ok: false,
      error: `每間店最多 ${POS_STAFF_MAX_PER_STORE} 位店員，請先停用離職員工。`,
      status: 409,
    };
  }

  if (!params.draft.pin) {
    // 防禦：API 層已用 validatePosStaffDraft(requirePin: true) 擋，但唔可以靠呼叫方
    return { ok: false, error: "請設定 4 位 PIN。", status: 400 };
  }

  const { pinHash, pinSalt, pinAlgo } = hashPosStaffPin(params.draft.pin);
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("pos_staff")
    .insert({
      store_id: params.storeId,
      staff_no: params.draft.staffNo,
      name: params.draft.name,
      role: params.draft.role,
      permissions: params.draft.permissions,
      pin_hash: pinHash,
      pin_salt: pinSalt,
      pin_algo: pinAlgo,
      active: params.draft.active,
      note: params.draft.note,
      created_by: params.actor,
      updated_by: params.actor,
      created_at: now,
      updated_at: now,
    })
    .select(STAFF_COLUMNS)
    .single();

  if (error) {
    if (isMissingStaffTable(error)) return tableMissingFailure();
    // 23505 = unique violation（同店工號重複）
    if (error.code === "23505") {
      return { ok: false, error: `工號「${params.draft.staffNo}」已經有人用。`, status: 409 };
    }
    console.error("[pos-staff] 新增店員失敗", { storeId: params.storeId, message: error.message });
    return { ok: false, error: "新增店員失敗，請稍後再試。", status: 502 };
  }

  return { ok: true, staff: toDto(data as Record<string, unknown>) };
}

export async function updatePosStaff(params: {
  storeId: string;
  staffId: string;
  draft: PosStaffDraft;
  actor: string;
}): Promise<StaffMutationResult> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return dbMissing();

  const patch: Record<string, unknown> = {
    staff_no: params.draft.staffNo,
    name: params.draft.name,
    role: params.draft.role,
    permissions: params.draft.permissions,
    active: params.draft.active,
    note: params.draft.note,
    updated_by: params.actor,
    updated_at: new Date().toISOString(),
  };

  // 只有真係改 PIN 才動 pin_* 欄；留空 = 保持不變（唔可以重設成空字串）
  if (params.draft.pin) {
    const { pinHash, pinSalt, pinAlgo } = hashPosStaffPin(params.draft.pin);
    patch.pin_hash = pinHash;
    patch.pin_salt = pinSalt;
    patch.pin_algo = pinAlgo;
    patch.failed_attempts = 0;
    patch.locked_until = null;
  }

  const { data, error } = await supabase
    .from("pos_staff")
    .update(patch)
    .eq("store_id", params.storeId)
    .eq("id", params.staffId)
    .select(STAFF_COLUMNS)
    .maybeSingle();

  if (error) {
    if (isMissingStaffTable(error)) return tableMissingFailure();
    if (error.code === "23505") {
      return { ok: false, error: `工號「${params.draft.staffNo}」已經有人用。`, status: 409 };
    }
    console.error("[pos-staff] 更新店員失敗", { storeId: params.storeId, message: error.message });
    return { ok: false, error: "更新店員失敗，請稍後再試。", status: 502 };
  }
  if (!data) return { ok: false, error: "找唔到呢位店員（可能已被刪除）。", status: 404 };

  return { ok: true, staff: toDto(data as Record<string, unknown>) };
}

/** 停用（軟刪除）—— 保留歷史審計，唔真刪 row。 */
export async function deactivatePosStaff(params: {
  storeId: string;
  staffId: string;
  actor: string;
}): Promise<StaffMutationResult> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return dbMissing();

  const { data, error } = await supabase
    .from("pos_staff")
    .update({
      active: false,
      updated_by: params.actor,
      updated_at: new Date().toISOString(),
    })
    .eq("store_id", params.storeId)
    .eq("id", params.staffId)
    .select(STAFF_COLUMNS)
    .maybeSingle();

  if (error) {
    if (isMissingStaffTable(error)) return tableMissingFailure();
    return { ok: false, error: "停用店員失敗，請稍後再試。", status: 502 };
  }
  if (!data) return { ok: false, error: "找唔到呢位店員（可能已被刪除）。", status: 404 };

  return { ok: true, staff: toDto(data as Record<string, unknown>) };
}

export type StaffAuthResult =
  | { ok: true; staff: PosStaffDto }
  | { ok: false; error: string; status: number; retryAfterSec?: number; tableMissing?: boolean };

/**
 * 店員簽到：工號 + PIN。
 *
 * 🔴 「工號唔存在」同「PIN 錯」一律回**同一句**，唔可以洩露邊個工號有效。
 * 🔴 鎖定期間**唔會再驗 PIN**（連正確都拒），否則鎖定期間照樣可以慢慢爆破。
 */
export async function authenticatePosStaff(params: {
  storeId: string;
  staffNo: string;
  pin: string;
}): Promise<StaffAuthResult> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return { ok: false, error: "資料庫未配置，暫時無法簽到。", status: 503 };

  const wanted = normalizeStaffNo(params.staffNo).toLowerCase();

  // 一間店最多 40 人 → 直接拉返嚟喺 JS 比對，避免 `ilike` 要 escape `%` / `_`
  const { data, error } = await supabase
    .from("pos_staff")
    .select(`${STAFF_COLUMNS}, pin_hash, pin_salt, pin_algo, failed_attempts`)
    .eq("store_id", params.storeId);

  if (error) {
    if (isMissingStaffTable(error)) {
      return {
        ok: false,
        error: "店員權限表未建立，請聯絡管理員執行 migration 0072。",
        status: 503,
        tableMissing: true,
      };
    }
    return { ok: false, error: "讀取店員資料失敗，請稍後再試。", status: 502 };
  }

  const row = (data ?? []).find(
    (item) => normalizeStaffNo((item as Record<string, unknown>).staff_no).toLowerCase() === wanted,
  ) as Record<string, unknown> | undefined;

  const invalid: StaffAuthResult = { ok: false, error: "工號或 PIN 不正確。", status: 401 };
  if (!row) return invalid;

  if (row.active !== true) {
    return { ok: false, error: "此員工帳號已停用，請聯絡店長。", status: 403 };
  }

  const nowMs = Date.now();
  const lockedUntilRaw = row.locked_until;
  const lockedUntilMs =
    typeof lockedUntilRaw === "string" ? new Date(lockedUntilRaw).getTime() : Number.NaN;
  if (Number.isFinite(lockedUntilMs) && lockedUntilMs > nowMs) {
    const retryAfterSec = Math.max(1, Math.ceil((lockedUntilMs - nowMs) / 1000));
    return {
      ok: false,
      error: `登入嘗試次數過多，請 ${Math.ceil(retryAfterSec / 60)} 分鐘後再試。`,
      status: 429,
      retryAfterSec,
    };
  }

  const passed = verifyPosStaffPin({
    pin: String(params.pin ?? ""),
    pinHash: String(row.pin_hash ?? ""),
    pinSalt: String(row.pin_salt ?? ""),
    pinAlgo: typeof row.pin_algo === "string" ? row.pin_algo : null,
  });

  if (!passed) {
    const failed = Number(row.failed_attempts ?? 0) + 1;
    const shouldLock = failed >= POS_STAFF_MAX_FAILED_ATTEMPTS;
    const nextLockIso = shouldLock ? new Date(nowMs + POS_STAFF_LOCK_MS).toISOString() : null;

    const { error: writeError } = await supabase
      .from("pos_staff")
      .update({
        failed_attempts: shouldLock ? 0 : failed,
        locked_until: nextLockIso,
        updated_at: new Date().toISOString(),
      })
      .eq("id", String(row.id));

    if (writeError) {
      // 寫入失敗唔阻流程，但一定要 log（否則鎖定靜默失效）
      console.warn("[pos-staff] 失敗次數寫入失敗", { message: writeError.message });
    }

    if (shouldLock) {
      return {
        ok: false,
        error: `PIN 錯誤次數過多，已鎖定 ${Math.round(POS_STAFF_LOCK_MS / 60000)} 分鐘。`,
        status: 429,
        retryAfterSec: Math.round(POS_STAFF_LOCK_MS / 1000),
      };
    }
    return invalid;
  }

  const nowIso = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("pos_staff")
    .update({ failed_attempts: 0, locked_until: null, last_login_at: nowIso, updated_at: nowIso })
    .eq("id", String(row.id));

  if (updateError) {
    // 唔阻簽到，但一定要 log —— 否則 last_login_at 靜默唔更新
    console.warn("[pos-staff] 簽到狀態更新失敗", { message: updateError.message });
  }

  return { ok: true, staff: toDto({ ...row, last_login_at: nowIso }) };
}
