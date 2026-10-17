import { NextResponse } from "next/server";

import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
import { readServerBuildId } from "@/lib/build-info";
import { getLedgerServiceClient } from "@/lib/ledger/admin-server";
import {
  clearPosSession,
  clearStalePosSessions,
  cleanupStalePosSessionsIfDue,
  listPosSessions,
  revokePosSession,
} from "@/lib/pos/session-registry-server";
import { canClearPosSession } from "@/lib/pos/session-record";

/**
 * `/api/admin/sessions` — POS 工作階段總覽（admin panel，migration 0047）。
 *
 * ## 為何要有呢支 API
 *
 * 2026-09-21 egress 事故嘅根源係「**商家唔為意開咗幾個分頁，舊分頁靜靜燒流量**」
 * （單一舊分頁 26 分鐘燒 123 MB，佔該窗口 97%）。事後只可以靠 Vercel log 反推
 * 邊部機跑住舊 bundle —— 呢支 API 令件事變成**一眼睇得到、一撳關得掉**。
 *
 * ## GET
 *
 * 回傳：`{ ok, serverBuildId, nowIso, sessions[], stores[] }`
 *   · `serverBuildId` ＝ **線上最新部署**（同 `/api/pos/state` 嘅 `x-pos-build` 同口徑）；
 *     同每個 session 嘅 `build_id`（＝該分頁實際跑緊嘅版本）一對照就知邊個落後。
 *   · `sessions` ＝ 原始 row（**唔喺 server 端分組／計 KPI**：分組邏輯放喺
 *     `session-record.ts`，admin 頁同 API 用同一份，避免兩邊漂移）。
 *   · `stores` ＝ 店名對照（Ledger `merchants`；冇 service key 就係空陣列，
 *     前端會 fallback 顯示 storeId）。
 *
 * ## PATCH（三種動作）
 *
 * · `revoke`：下達強制關閉（**軟踢**）—— POS 端下次請求見到
 *   `x-pos-session-closed: 1` 之後自己停輪詢＋出橫幅。server 唔可能關掉別人嘅分頁。
 * · `clear`  ：清除紀錄。**只准清「已離線」或「已強制關閉」嘅** ——
 *   唔准清一個仲活躍嘅工作階段（否則商家明明開住、admin 頁卻乜都睇唔到，反而更危險）。
 * · `clear-stale`：一撳清曬全部「已死」記錄（`last_seen_at` 超過 30 分鐘無上報，
 *   含軟踢窗口已過嘅已關閉行）。**唔使帶 ids**（判準見 `isStalePosSession()`）。
 *
 * ⚠️ 三種動作都**唔會**刪任何業務資料（訂單／班次／營業開關完全不受影響）。
 */

const MAX_BULK = 50;

export async function GET(request: Request) {
  const claims = readAdminSessionFromRequest(request);
  if (!claims) {
    return NextResponse.json({ ok: false, error: "未授權，請先登入管理後台。" }, { status: 401 });
  }

  // 🔴 自動清除「已死」記錄（2026-10-17，J 拍板）：節流後每個 process 5 分鐘一次，
  //    **先清再列** ⇒ admin 睇到嘅即係清完之後嘅實況。
  //    零新增請求（搭呢個 30 秒一輪嘅 GET）；失敗靜默放過，絕唔阻擋頁面。
  const cleanup = await cleanupStalePosSessionsIfDue();
  if (cleanup.ran && cleanup.deleted > 0) {
    console.warn(
      `[admin/sessions] 自動清除 ${cleanup.deleted} 個已死工作階段（>30 分鐘無上報，含已關閉）`,
    );
  }

  const sessions = await listPosSessions();

  // 店名對照（Ledger）。讀唔到（未配 LEDGER_SERVICE_ROLE_KEY）→ 回空陣列，
  // 前端 fallback 顯示 storeId —— 唔可以因為「冇店名」而令整個頁面用唔到。
  let stores: Array<{ id: string; name: string }> = [];
  try {
    const ledger = getLedgerServiceClient();
    if (ledger) {
      const { data } = await ledger.from("merchants").select("id, name").limit(2000);
      stores = (data ?? [])
        .map((row: { id?: string; name?: string | null }) => ({
          id: String(row.id ?? ""),
          name: row.name ?? String(row.id ?? ""),
        }))
        .filter((s) => s.id);
    }
  } catch {
    stores = [];
  }

  return NextResponse.json({
    ok: true,
    serverBuildId: readServerBuildId(),
    nowIso: new Date().toISOString(),
    stores,
    sessions,
  });
}

export async function PATCH(request: Request) {
  const claims = readAdminSessionFromRequest(request);
  if (!claims) {
    return NextResponse.json({ ok: false, error: "未授權，請先登入管理後台。" }, { status: 401 });
  }

  let payload: { id?: string; ids?: string[]; action?: string; reason?: string };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ ok: false, error: "請求格式錯誤。" }, { status: 400 });
  }

  const action = String(payload?.action ?? "").trim();
  const ids = [
    ...(typeof payload?.id === "string" && payload.id.trim() ? [payload.id.trim()] : []),
    ...(Array.isArray(payload?.ids) ? payload.ids.map((v) => String(v).trim()).filter(Boolean) : []),
  ];
  const uniqueIds = [...new Set(ids)].slice(0, MAX_BULK);

  if (action !== "revoke" && action !== "clear" && action !== "clear-stale") {
    return NextResponse.json({ ok: false, error: "action 只可以是 revoke、clear 或 clear-stale。" }, { status: 400 });
  }

  /**
   * `clear-stale`：一撳清曬全部「已死」記錄（`last_seen_at` 超過 30 分鐘，
   * 含軟踢窗口已過嘅已關閉行）。**唔使帶 ids**，所以唔受 `MAX_BULK` 限制。
   */
  if (action === "clear-stale") {
    const deleted = await clearStalePosSessions();
    console.warn(`[admin/sessions] ${claims.account} 清理 ${deleted} 個已死工作階段記錄`);
    return NextResponse.json({ ok: true, deleted });
  }

  if (uniqueIds.length === 0) {
    return NextResponse.json({ ok: false, error: "缺少 id。" }, { status: 400 });
  }

  const reason = typeof payload?.reason === "string" ? payload.reason.trim().slice(0, 200) : null;

  // `clear` 要逐行判斷「准唔准清」—— 判斷用 `canClearPosSession()`（同 admin 頁同一份邏輯）。
  if (action === "clear") {
    const rows = await listPosSessions(1000);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const nowMs = Date.now();
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of uniqueIds) {
      const row = byId.get(id);
      if (!row) {
        results.push({ id, ok: false, error: "紀錄不存在。" });
        continue;
      }
      if (!canClearPosSession(row, nowMs)) {
        results.push({ id, ok: false, error: "此工作階段仍然活躍（或未達離線門檻），唔可以清除。" });
        continue;
      }
      results.push({ id, ok: await clearPosSession(id) });
    }
    return NextResponse.json({ ok: results.every((r) => r.ok), results });
  }

  const results: Array<{ id: string; ok: boolean; revokedAt?: string | null }> = [];
  for (const id of uniqueIds) {
    const outcome = await revokePosSession({ id, by: claims.account, reason });
    results.push({ id, ok: outcome.ok, revokedAt: outcome.revokedAt });
  }
  console.warn(
    `[admin/sessions] ${claims.account} 強制關閉 ${results.filter((r) => r.ok).length}/${uniqueIds.length} 個工作階段` +
      (reason ? `（原因：${reason}）` : ""),
  );
  return NextResponse.json({ ok: results.every((r) => r.ok), results });
}
