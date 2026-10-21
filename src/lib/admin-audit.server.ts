import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase-server";

/**
 * Admin 操作審計（2026-10-21 · 多店控制台 P0-4，migration 0068 `admin_audit_log`）。
 *
 * ## 為何要有
 *
 * 一係「派帳號出去」就會有人問：邊個改咗邊間店、幾時改、改咗咩。
 * 冇審計 = 出事只可以靠推測。另外 4 位 PIN 一定要配登入紀錄，
 * 否則撞開咗都冇痕跡。
 *
 * ## 鐵律
 *
 * 1. **唔可以阻業務**：寫審計失敗（未跑 migration、DB 打嗝、權限）一律吞掉 + log 一次，
 *    絕對唔可以令登入／寫入失敗。審計係「有就好」，唔係交易的一部分。
 * 2. **唔記敏感資料**：只記帳號、動作、目標、店舖、IP。**唔記 PIN、唔記 token**。
 * 3. `detail` 只放結構化小資料（例如 diff 的欄位名），唔好塞整個 payload。
 */

export type AdminAuditAction =
  | "login_success"
  | "login_failed"
  | "login_locked"
  | "logout"
  | "write"
  | "read";

export type AdminAuditEntry = {
  account: string;
  action: AdminAuditAction;
  /** 資源／動作目標，例如 `merchant.status`、`menu.price`、`store.active` */
  target?: string;
  /** 涉及邊幾間店（merchantId） */
  storeIds?: string[];
  /** 細粒度補充（唔好塞大 payload） */
  detail?: Record<string, unknown>;
  ip?: string;
};

/** 只 log 一次（避免未跑 migration 時每次登入都刷幾行）。 */
let warnedAuditFailure = false;

export async function writeAdminAudit(entry: AdminAuditEntry): Promise<void> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return;

  try {
    const { error } = await supabase.from("admin_audit_log").insert({
      account: entry.account || "(unknown)",
      action: entry.action,
      target: entry.target ?? null,
      store_ids: entry.storeIds && entry.storeIds.length > 0 ? entry.storeIds : null,
      detail: entry.detail ?? null,
      ip: entry.ip ?? null,
    });
    if (error && !warnedAuditFailure) {
      warnedAuditFailure = true;
      console.warn(
        "[admin-audit] 寫入失敗（可能 migration 0068 未跑；**唔影響業務**）：",
        error.message,
      );
    }
  } catch (err) {
    if (!warnedAuditFailure) {
      warnedAuditFailure = true;
      console.warn("[admin-audit] 寫入例外（**唔影響業務**）：", err);
    }
  }
}

/** 由 Request 取客戶端 IP（只看 header，唔做任何驗證）。 */
export function readClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return request.headers.get("x-real-ip") ?? "unknown";
}
