import "server-only";

import { getSupabaseServerClient, getSupabaseWriteClient } from "@/lib/supabase-server";

import {
  SESSION_KEY_MAX_LEN,
  SESSION_RETENTION_DAYS,
  sanitizeBuildId,
  sanitizeSessionKey,
  sessionRowId,
  shouldTouchSession,
  type PosSessionRow,
} from "./session-record.ts";

/**
 * 《POS 工作階段》伺服器端註冊表（2026-09-22）—— 對 `pos_sessions`（migration 0047）。
 *
 * ## 兩條鐵律
 *
 * ### 1) 🔴 永遠唔可以 throw、永遠唔可以阻擋業務
 *
 * 呢個模組會被**落單路徑**（`/api/pos/sync`）同**讀取路徑**（`/api/pos/state`）呼叫。
 * 任何失敗（未跑 migration 42P01、網絡抖動、權限）都只可以**靜靜放過** ——
 * 「登記唔到工作階段」絕對唔可以變成「全店落唔到單」。
 * ⇒ 所有函式 `try/catch` 到底，回 `null`／`false`／`[]`。
 * ⇒ `42P01`（表唔存在）每個 process 只 log 一次，唔會洗版。
 *
 * ### 2) 🔴 零新增請求
 *
 * · **註冊**：`/api/ledger/login` 成功嗰刻（server 端唯一權威知道 `merchantId`）。
 * · **續期**：掛喺**已經存在**嘅請求上 ——
 *   POST 寫入（`/api/pos/sync`）用 60 秒節流、GET 讀取（`/api/pos/state`）用 5 分鐘節流。
 * · GET **只續期、唔建立 row**（保持「GET 唔創造狀態」嘅語義，同
 *   `loadPairedAgent(recordActivity)` 嘅教訓一致）；row 由 login／POST 建立。
 *
 * ## 寫入 client 嘅選擇
 *
 * · 寫入用 `getSupabaseWriteClient()`（service_role）—— 同 `pos/sync` 一致；
 * · 讀取列表用 `getSupabaseServerClient()` —— 同 `admin/merchants` 一致。
 * 兩者都係既有 pattern，唔新增 env。
 */

/** 表唔存在（未跑 migration）每個 process 只嘈一次。 */
let warnedMissingTable = false;

function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01") return true;
  return /does not exist/i.test(error.message ?? "");
}

function noteFailure(tag: string, error: { code?: string; message?: string } | null | undefined): void {
  if (isMissingTable(error)) {
    if (!warnedMissingTable) {
      warnedMissingTable = true;
      console.warn(
        "[pos/sessions] pos_sessions 表未建立（migration 0047 未跑）⇒ 工作階段功能停用，業務不受影響。",
      );
    }
    return;
  }
  console.warn(`[pos/sessions] ${tag} 失敗（已忽略）：${error?.message ?? "unknown"}`);
}

/** 只供測試／診斷：重設「表唔存在」警告。 */
export function resetSessionRegistryWarningForTest(): void {
  warnedMissingTable = false;
}

export type RegisterPosSessionInput = {
  storeId: string;
  sessionKey: string;
  account?: string | null;
  role?: string | null;
  buildId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** ISO 時間；唔傳 ＝ DB `now()`。 */
  at?: string;
};

/**
 * 註冊（或更新）一個工作階段。
 *
 * 用 `upsert` + `onConflict: id` ⇒ 同一分頁 reload 之後再 login 唔會多一行。
 * ⚠️ `opened_at` **唔**更新：工作階段嘅「開啟時間」定義為第一次註冊時間
 * （reload 唔應該令「已開 26 小時」變成「已開 1 分鐘」）。
 */
export async function registerPosSession(input: RegisterPosSessionInput): Promise<boolean> {
  try {
    const sessionKey = sanitizeSessionKey(input.sessionKey);
    const storeId = String(input.storeId ?? "").trim();
    if (!sessionKey || !storeId || storeId.length > SESSION_KEY_MAX_LEN) return false;

    const supabase = getSupabaseWriteClient();
    if (!supabase) return false;

    const nowIso = input.at ?? new Date().toISOString();
    const { error } = await supabase.from("pos_sessions").upsert(
      {
        id: sessionRowId(storeId, sessionKey),
        store_id: storeId,
        session_key: sessionKey,
        account: input.account ?? null,
        role: input.role ?? null,
        build_id: sanitizeBuildId(input.buildId),
        last_seen_at: nowIso,
        ip: input.ip ?? null,
        user_agent: typeof input.userAgent === "string" ? input.userAgent.slice(0, 300) : null,
      },
      { onConflict: "id", ignoreDuplicates: false },
    );
    if (error) {
      noteFailure("register", error);
      return false;
    }
    return true;
  } catch (err) {
    noteFailure("register", { message: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export type TouchPosSessionResult = {
  /** row 存在？`false` ＝ 從未註冊（GET 唔會建立）。 */
  found: boolean;
  /** 已下達強制關閉嘅時間（ISO）；`null` ＝ 未被關閉。 */
  revokedAt: string | null;
  revokeReason: string | null;
  /** 今次有冇真正寫入 `last_seen_at`（節流之下多數係 false）。 */
  touched: boolean;
};

const NOT_FOUND: TouchPosSessionResult = {
  found: false,
  revokedAt: null,
  revokeReason: null,
  touched: false,
};

/**
 * 讀取工作階段狀態（並在節流容許時續期 `last_seen_at`）。
 *
 * @param throttleMs 續期節流：POST 用 60 秒、GET 用 5 分鐘（見 `session-record.ts`）。
 *   `0` ＝ 每次都續期（登入時用）。
 * @param allowCreate `true` ＝ row 唔存在時順手建立（POST 寫入路徑用）。
 *   ⚠️ GET 一律傳 `false`（唔好令讀取請求創造狀態）。
 */
export async function touchPosSession(input: {
  storeId: string;
  sessionKey: string;
  buildId?: string | null;
  account?: string | null;
  role?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  throttleMs: number;
  allowCreate?: boolean;
  nowMs?: number;
}): Promise<TouchPosSessionResult> {
  try {
    const sessionKey = sanitizeSessionKey(input.sessionKey);
    const storeId = String(input.storeId ?? "").trim();
    if (!sessionKey || !storeId || storeId.length > SESSION_KEY_MAX_LEN) return NOT_FOUND;

    const supabase = getSupabaseWriteClient() ?? getSupabaseServerClient();
    if (!supabase) return NOT_FOUND;

    const id = sessionRowId(storeId, sessionKey);
    const nowMs = input.nowMs ?? Date.now();

    const { data, error } = await supabase
      .from("pos_sessions")
      .select("id, last_seen_at, revoked_at, revoke_reason")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      noteFailure("touch:select", error);
      return NOT_FOUND;
    }

    if (!data) {
      if (!input.allowCreate) return NOT_FOUND;
      const created = await registerPosSession({
        storeId,
        sessionKey,
        account: input.account ?? null,
        role: input.role ?? null,
        buildId: input.buildId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      });
      return created
        ? { found: true, revokedAt: null, revokeReason: null, touched: true }
        : NOT_FOUND;
    }

    const row = data as { last_seen_at: string | null; revoked_at: string | null; revoke_reason: string | null };

    // ⚠️ 已撤銷嘅工作階段**唔再續期**：否則 admin 頁永遠顯示「使用中」，
    //    管理員會以為未關到，然後重複撳（掩蓋咗「其實已經停咗」呢個事實）。
    if (row.revoked_at) {
      return { found: true, revokedAt: row.revoked_at, revokeReason: row.revoke_reason ?? null, touched: false };
    }

    if (input.throttleMs > 0 && !shouldTouchSession(row.last_seen_at, nowMs, input.throttleMs)) {
      return { found: true, revokedAt: null, revokeReason: null, touched: false };
    }

    const patch: Record<string, unknown> = { last_seen_at: new Date(nowMs).toISOString() };
    // 版本／身分有變就更新（部署之後第一下就會反映真實版本）。
    const buildId = sanitizeBuildId(input.buildId);
    if (buildId) patch.build_id = buildId;
    if (input.account) patch.account = input.account;

    const { error: updateError } = await supabase.from("pos_sessions").update(patch).eq("id", id);
    if (updateError) {
      noteFailure("touch:update", updateError);
      return { found: true, revokedAt: null, revokeReason: null, touched: false };
    }
    return { found: true, revokedAt: null, revokeReason: null, touched: true };
  } catch (err) {
    noteFailure("touch", { message: err instanceof Error ? err.message : String(err) });
    return NOT_FOUND;
  }
}

/**
 * 列出工作階段（admin 頁）。
 *
 * @param limit 上限（預設 500）。**唔**做分頁：正常一間店幾個，全平台幾十個。
 */
export async function listPosSessions(limit = 500): Promise<PosSessionRow[]> {
  try {
    const supabase = getSupabaseServerClient();
    if (!supabase) return [];
    const sinceIso = new Date(Date.now() - SESSION_RETENTION_DAYS * 86_400_000).toISOString();
    const { data, error } = await supabase
      .from("pos_sessions")
      .select(
        "id, store_id, session_key, account, role, build_id, opened_at, last_seen_at, ip, user_agent, revoked_at, revoked_by, revoke_reason, closed_at",
      )
      .gte("last_seen_at", sinceIso)
      .order("last_seen_at", { ascending: false })
      .limit(Math.min(Math.max(1, limit), 1000));
    if (error) {
      noteFailure("list", error);
      return [];
    }
    return (data ?? []) as PosSessionRow[];
  } catch (err) {
    noteFailure("list", { message: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/** 下達強制關閉（軟踢：POS 端下次請求先見到）。 */
export async function revokePosSession(input: {
  id: string;
  by: string;
  reason?: string | null;
}): Promise<{ ok: boolean; revokedAt: string | null }> {
  try {
    const id = String(input.id ?? "").trim();
    if (!id) return { ok: false, revokedAt: null };
    const supabase = getSupabaseWriteClient() ?? getSupabaseServerClient();
    if (!supabase) return { ok: false, revokedAt: null };

    const revokedAt = new Date().toISOString();
    const { error } = await supabase
      .from("pos_sessions")
      .update({
        revoked_at: revokedAt,
        revoked_by: input.by,
        revoke_reason: input.reason ? String(input.reason).slice(0, 300) : null,
      })
      .eq("id", id);
    if (error) {
      noteFailure("revoke", error);
      return { ok: false, revokedAt: null };
    }
    return { ok: true, revokedAt };
  } catch (err) {
    noteFailure("revoke", { message: err instanceof Error ? err.message : String(err) });
    return { ok: false, revokedAt: null };
  }
}

/**
 * 清除一行紀錄（已離線／已強制關閉嘅才可以）。
 *
 * ⚠️ 呼叫端（admin API）**必須**先用 `canClearPosSession()` 檢查 ——
 * 呢度只做 DB 動作，唔重複判斷（判斷只有一份，喺 `session-record.ts`）。
 */
export async function clearPosSession(id: string): Promise<boolean> {
  try {
    const key = String(id ?? "").trim();
    if (!key) return false;
    const supabase = getSupabaseWriteClient() ?? getSupabaseServerClient();
    if (!supabase) return false;
    const { error } = await supabase.from("pos_sessions").delete().eq("id", key);
    if (error) {
      noteFailure("clear", error);
      return false;
    }
    return true;
  } catch (err) {
    noteFailure("clear", { message: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
