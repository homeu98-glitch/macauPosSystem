import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/admin-guard.server";
import { scopeSummary } from "@/lib/admin-scope-core";
import { getLedgerServiceClient } from "@/lib/ledger/admin-server";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

/**
 * GET /api/admin/me — 當前 admin 帳號嘅身份 + 可見範圍（2026-10-21 · P1）。
 *
 * ## 為何要有
 *
 * P1 之後「登入成功」唔再等於「睇到全部」。前端要知道：
 *   · 我係平台級定店舖級？
 *   · 我睇得到邊幾間店（連店名，畀店舖多選用）？
 * 呢啲資訊**只可以用嚟顯示／預設選店**，唔可以當授權 —— 真授權永遠喺每條 API 嘅
 * `requireAdmin()` + `storeFilterOrDeny()`。前端傳咩都改變唔到 server 端範圍。
 *
 * ## 為何唔併入 `/api/admin/session`
 *
 * 登入係「憑證交換」，scope 係「資料查詢」。分開之後：
 *   · 改 binding 唔需要重新登入（前端重新打一次 /me 就見到新範圍）；
 *   · `/session` 唔使為咗 scope 多查 3 條 SQL（登入本身已經夠慢）。
 */

export async function GET(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.res;

  const { claims, scope } = guard;
  const summary = scopeSummary(scope);

  // 店名：只有非平台帳號才需要（平台帳號嘅「全部」係動態的，唔應該 enumerate）。
  let stores: Array<{ id: string; name: string }> = [];
  if (!scope.all && summary.storeIds.length > 0) {
    const ledger = getLedgerServiceClient();
    if (ledger) {
      try {
        const { data } = await ledger
          .from("merchants")
          .select("id, name")
          .in("id", summary.storeIds);
        const nameById = new Map<string, string>();
        for (const row of (data ?? []) as Array<{ id?: string; name?: string | null }>) {
          if (row.id) nameById.set(String(row.id), row.name ?? String(row.id));
        }
        stores = summary.storeIds.map((id) => ({ id, name: nameById.get(id) ?? id }));
      } catch {
        // 讀唔到店名唔可以令 /me 失敗（前端會 fallback 顯示 id）
        stores = summary.storeIds.map((id) => ({ id, name: id }));
      }
    } else {
      stores = summary.storeIds.map((id) => ({ id, name: id }));
    }
  }

  return NextResponse.json({
    ok: true,
    account: claims.account,
    role: claims.role,
    // P2：首登／重設 PIN 後為 true（前端 AdminShell 會強制彈改 PIN 窗）。
    mustChangePin: await readMustChangePin(claims.account),
    scope: summary,
    stores,
  });
}

/** 讀 `must_change_pin`（0070 未跑 → 欄位唔存在，一律當 false，唔會阻登入）。 */
async function readMustChangePin(account: string): Promise<boolean> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return false;
  const { data } = await supabase
    .from("admin_account_users")
    .select("must_change_pin")
    .eq("account", account)
    .maybeSingle();
  return (data as { must_change_pin?: boolean } | null)?.must_change_pin === true;
}
