import { NextResponse } from "next/server";

import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
import { RELEASE_STORAGE_BUCKET, validateReleaseDraft } from "@/lib/release/release-core";
import {
  mapReleaseVersionRow,
  mapReleaseVersionRows,
  pickActiveReleases,
  sortReleaseVersions,
  type ReleaseVersionDto,
  type ReleaseVersionRow,
} from "@/lib/release/release-row";
import {
  ACTIVATE_RELEASE_RPC,
  RELEASE_MIGRATION_HINT,
  RELEASE_VERSION_COLUMNS,
  RELEASE_VERSIONS_TABLE,
  isReleaseRpcMissing,
  isReleaseTableMissing,
  releaseStoragePrefix,
  resolveReleaseStorageBaseUrl,
} from "@/lib/release/release-server";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

/**
 * `/api/admin/release-versions` —— Admin「版本控制」頁嘅讀寫 API（2026-09-23）。
 *
 * | Method | 用途 |
 * |---|---|
 * | GET    | 列出**全部**版本（含已停用），按平台 + 建立時間排序 |
 * | POST   | 新增一個版本（預設唔 active；`activate: true` 就順手切過去） |
 * | PATCH  | 改版本資料；`activate: true/false` 切換／取消 active |
 * | DELETE | 刪除一個版本（`?id=`） |
 *
 * ## 四條紀律
 *
 * 1. **鑑權一律 `readAdminSessionFromRequest`**（同 `/api/admin/traffic`、
 *    `/api/admin/sessions` 一致）。呢張表控制「對外派邊個安裝包」⇒ 屬 admin 權限。
 * 2. **寫入用 `getSupabaseAdminClient()`**（只認 service role）。migration 0050 已經
 *    revoke anon ⇒ 用 anon key 寫入會**靜默失敗**（前端以為成功、DB 冇變）。
 * 3. **驗證只用 `validateReleaseDraft()`**（`@/lib/release/release-core`），
 *    admin 表單用同一份 ⇒ 唔會出現「前端話 OK、後端話錯」。
 * 4. **切換 active 用 RPC `pos_activate_release_version`**，
 *    唔喺 route 分兩條 update 做：分兩條做，中間失敗會撞 partial unique index
 *    或者留低「一個 active 都冇」。
 *
 * ## migration 未跑要 graceful
 *
 * `pos_release_versions` 唔存在（42P01 / PGRST205）→ GET 回
 * `{ ok: true, available: false, reason }`，令 admin 頁顯示提示而唔係爆 500
 * （同 `/api/admin/traffic` 嘅做法一致）。
 */

function bad(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

type Ctx = { baseUrl: string | null };

function meta(ctx: Ctx) {
  return {
    bucket: RELEASE_STORAGE_BUCKET,
    storagePrefix: releaseStoragePrefix(ctx.baseUrl),
    baseUrlConfigured: Boolean(ctx.baseUrl),
  };
}

/** 統一嘅「Supabase / migration 未就緒」回應。 */
function notReady(reason: string, ctx: Ctx) {
  return NextResponse.json({
    ok: true,
    available: false,
    reason,
    versions: [] as ReleaseVersionDto[],
    ...meta(ctx),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET · 列出全部版本
// ─────────────────────────────────────────────────────────────────────────────
export async function GET(request: Request) {
  const claims = readAdminSessionFromRequest(request);
  if (!claims) return bad("未授權，請先登入管理後台。", 401);

  const ctx: Ctx = { baseUrl: resolveReleaseStorageBaseUrl() };
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return notReady("未配置 SUPABASE_SERVICE_ROLE_KEY（Supabase 管理憑證）→ 讀寫版本資料。", ctx);
  }

  const { data, error } = await supabase
    .from(RELEASE_VERSIONS_TABLE)
    .select(RELEASE_VERSION_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    if (isReleaseTableMissing(error)) return notReady(RELEASE_MIGRATION_HINT, ctx);
    console.error("[admin/release-versions] 讀取失敗:", error.message);
    return NextResponse.json({ ok: false, error: "讀取版本資料失敗。" }, { status: 500 });
  }

  const versions = sortReleaseVersions(
    mapReleaseVersionRows(data as ReleaseVersionRow[], { supabaseBaseUrl: ctx.baseUrl }),
  );

  /**
   * 「每個平台而家對外派緊邊條 id」——**呼叫同公開 API 一樣嘅 `pickActiveReleases()`**，
   * 唔喺前端自己 filter。理由：admin 頁要顯示「呢條就係而家對外派緊嘅」，
   * 若前端用另一套判斷（例如「第一個 is_active」），一旦資料壞咗（同平台兩條 active）
   * 就會出現「admin 話係 A、登入頁實際派 B」——最難查嘅一類不一致。
   */
  const active = pickActiveReleases(versions);

  return NextResponse.json({
    ok: true,
    available: true,
    versions,
    ...meta(ctx),
    active: {
      android: active.android?.id ?? null,
      desktop: active.desktop?.id ?? null,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST · 新增版本
// ─────────────────────────────────────────────────────────────────────────────
export async function POST(request: Request) {
  const claims = readAdminSessionFromRequest(request);
  if (!claims) return bad("未授權，請先登入管理後台。", 401);

  const ctx: Ctx = { baseUrl: resolveReleaseStorageBaseUrl() };
  const supabase = getSupabaseAdminClient();
  if (!supabase) return bad("未配置 SUPABASE_SERVICE_ROLE_KEY（Supabase 管理憑證）。", 503);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad("請求格式錯誤（唔係合法 JSON）。");
  }

  const parsed = validateReleaseDraft(body);
  if (!parsed.ok) return bad(parsed.error);

  const { platform, version, filePath, downloadUrl, fileSize, notes } = parsed.value;
  // 新增一律**唔 active**（除非明確 activate: true）——
  // 避免「填錯連結但一生效就即刻對外派」。
  const shouldActivate = (body as { activate?: unknown })?.activate === true;

  const { data, error } = await supabase
    .from(RELEASE_VERSIONS_TABLE)
    .insert({
      platform,
      version,
      file_path: filePath,
      download_url: downloadUrl,
      file_size: fileSize,
      notes,
      is_active: false,
    })
    .select(RELEASE_VERSION_COLUMNS)
    .single();

  if (error) {
    if (isReleaseTableMissing(error)) return bad(RELEASE_MIGRATION_HINT, 503);
    console.error("[admin/release-versions] 新增失敗:", error.message);
    return bad(`新增失敗：${error.message}`, 500);
  }

  const created = mapReleaseVersionRow(data as ReleaseVersionRow, { supabaseBaseUrl: ctx.baseUrl });
  if (!created) return bad("新增成功但回傳資料唔完整，請重新載入。", 500);

  if (shouldActivate) {
    const activated = await activate(supabase, created.id);
    if (!activated.ok) return activated.response;
    return NextResponse.json({
      ok: true,
      available: true,
      version: { ...created, isActive: true },
      ...meta(ctx),
    });
  }

  return NextResponse.json({ ok: true, available: true, version: created, ...meta(ctx) });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH · 改資料 / 切換 active
// ─────────────────────────────────────────────────────────────────────────────
export async function PATCH(request: Request) {
  const claims = readAdminSessionFromRequest(request);
  if (!claims) return bad("未授權，請先登入管理後台。", 401);

  const ctx: Ctx = { baseUrl: resolveReleaseStorageBaseUrl() };
  const supabase = getSupabaseAdminClient();
  if (!supabase) return bad("未配置 SUPABASE_SERVICE_ROLE_KEY（Supabase 管理憑證）。", 503);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("請求格式錯誤（唔係合法 JSON）。");
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return bad("缺少版本 id。");

  // 先讀現行 row —— 要「局部更新」就一定要有底，否則唔知未填嘅欄位原本係咩。
  const existing = await supabase
    .from(RELEASE_VERSIONS_TABLE)
    .select(RELEASE_VERSION_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (existing.error) {
    if (isReleaseTableMissing(existing.error)) return bad(RELEASE_MIGRATION_HINT, 503);
    console.error("[admin/release-versions] 讀取目標失敗:", existing.error.message);
    return bad("讀取版本資料失敗。", 500);
  }
  if (!existing.data) return bad("搵唔到呢個版本（可能已經被刪除）。", 404);

  const row = existing.data as ReleaseVersionRow;

  // 合併：有傳嘅欄位覆蓋，冇傳就保留原值。
  const merged = {
    platform: body.platform ?? row.platform,
    version: body.version ?? row.version,
    filePath: body.filePath ?? row.file_path,
    downloadUrl: body.downloadUrl ?? row.download_url,
    fileSize: body.fileSize ?? row.file_size,
    notes: body.notes ?? row.notes,
  };

  const parsed = validateReleaseDraft(merged);
  if (!parsed.ok) return bad(parsed.error);

  const { platform, version, filePath, downloadUrl, fileSize, notes } = parsed.value;
  const activateFlag = typeof body.activate === "boolean" ? body.activate : null;

  const { data, error } = await supabase
    .from(RELEASE_VERSIONS_TABLE)
    .update({
      platform,
      version,
      file_path: filePath,
      download_url: downloadUrl,
      file_size: fileSize,
      notes,
      // `activate: false` ⇒ 順手落閘（容許「該平台暫時冇 active 版本」）。
      // `activate: true` ⇒ 交俾 RPC 做（下面），呢度唔可以直接寫 true，
      //   否則會同 partial unique index 撞。
      ...(activateFlag === false ? { is_active: false } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select(RELEASE_VERSION_COLUMNS)
    .single();

  if (error) {
    if (isReleaseTableMissing(error)) return bad(RELEASE_MIGRATION_HINT, 503);
    console.error("[admin/release-versions] 更新失敗:", error.message);
    return bad(`更新失敗：${error.message}`, 500);
  }

  let updated = mapReleaseVersionRow(data as ReleaseVersionRow, { supabaseBaseUrl: ctx.baseUrl });
  if (!updated) return bad("更新成功但回傳資料唔完整，請重新載入。", 500);

  if (activateFlag === true) {
    const activated = await activate(supabase, id);
    if (!activated.ok) return activated.response;
    updated = { ...updated, isActive: true };
  }

  return NextResponse.json({ ok: true, available: true, version: updated, ...meta(ctx) });
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE · 刪除版本
// ─────────────────────────────────────────────────────────────────────────────
export async function DELETE(request: Request) {
  const claims = readAdminSessionFromRequest(request);
  if (!claims) return bad("未授權，請先登入管理後台。", 401);

  const supabase = getSupabaseAdminClient();
  if (!supabase) return bad("未配置 SUPABASE_SERVICE_ROLE_KEY（Supabase 管理憑證）。", 503);

  const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
  if (!id) return bad("缺少版本 id。");

  const { error } = await supabase.from(RELEASE_VERSIONS_TABLE).delete().eq("id", id);
  if (error) {
    if (isReleaseTableMissing(error)) return bad(RELEASE_MIGRATION_HINT, 503);
    console.error("[admin/release-versions] 刪除失敗:", error.message);
    return bad(`刪除失敗：${error.message}`, 500);
  }

  // ⚠️ 只刪 DB 記錄，**唔會**刪 Storage 入面嘅檔案 ——
  //    Storage 刪除屬破壞性操作（舊版本可能仲有人用緊），要人手喺 Dashboard 做。
  return NextResponse.json({ ok: true, deleted: id, storageUntouched: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// 共用：原子切換 active
// ─────────────────────────────────────────────────────────────────────────────
type ActivateResult = { ok: true } | { ok: false; response: NextResponse };

async function activate(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdminClient>>,
  id: string,
): Promise<ActivateResult> {
  const { data, error } = await supabase.rpc(ACTIVATE_RELEASE_RPC, { p_id: id });

  if (error) {
    if (isReleaseRpcMissing(error)) {
      return {
        ok: false,
        response: bad(
          "RPC pos_activate_release_version 唔存在 —— migration 0050 只跑咗一半（表已建、function 未建）。請重新貼一次完整 migration。",
          503,
        ),
      };
    }
    if (isReleaseTableMissing(error)) return { ok: false, response: bad(RELEASE_MIGRATION_HINT, 503) };
    console.error("[admin/release-versions] 切換 active 失敗:", error.message);
    return { ok: false, response: bad(`切換失敗：${error.message}`, 500) };
  }

  // RPC 回 null＝目標 row 唔存在（function 內已經查過）
  if (!data) return { ok: false, response: bad("搵唔到呢個版本，切換取消。", 404) };

  return { ok: true };
}
