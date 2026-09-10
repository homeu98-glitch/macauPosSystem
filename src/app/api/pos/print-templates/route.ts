import { NextResponse } from "next/server";

import {
  KitchenTemplate,
  LabelTemplate,
  PrintTemplates,
  ReceiptTemplate,
  ShiftTemplate,
  ShiftTemplateVariant,
} from "@/lib/types";
import { getSupabaseServerClient, getSupabaseWriteClient } from "@/lib/supabase-server";
import { normalizePrintTemplateSet } from "@/lib/storage";
import {
  DEFAULT_SHIFT_TEMPLATE_PRESET_ID,
  normalizeShiftTemplatePresets,
} from "@/lib/escpos-template";

/**
 * 打印模板（按店）。`pos_print_templates` 表，0027 migration。
 *
 * 背景（docs/71 擱置嘅 "push seam" 落地）：print-center 以前淨係寫 localStorage
 * （`macau-pos/stores/{storeId}/local-settings` → printTemplates），從未 POST 後台，
 * 令模板跨終端各自為政、新終端入打印頁永遠只見到 local default。而家模板喺呢度做
 * per-store 真源：GET 進入打印頁即拉，POST 儲存即上傳。
 *
 * 點解唔用 `pos_device_configs`：嗰張表嘅讀取係 `.order("updated_at", { ascending: false })
 * .limit(1)` **冇 store filter** = 「全店最新一條（任何 terminal）」，用嚟存 per-store
 * 設定一定會錯亂（同 docs/52 autoAccept 同一個坑）。所以模板獨立一張 `pos_print_templates`，
 * store_id 係 primary key → 一店一行，天然唔會互蓋。
 *
 * 授權：同 kiosk-settings / shift 一致 —— 寫入行 server service_role（0016/0023 已將
 * 業務表收做 service_role-only + revoke anon），讀取行 server client。storeId 由 client
 * resolveStoreId()（登入 merchantId / kiosk 綁定）帶嚟，route 唔自行斷言「屬於邊間店」，
 * 同 /api/pos/state 嘅信任模型一致（店舖 scope 由上游 auth 層決定）。
 */

/**
 * 「欄位唔存在」錯誤判斷（Postgres `undefined_column` = 42703）。
 *
 * 用途：0030 migration 未跑就想讀 / 寫 `shift` / `shift_presets` 兩個新欄。
 * 呢個 repo 有前科 —— 「代碼部署咗但 migration 未跑」係常見事故（見 docs/103 §2.3）。
 * 若果唔兜，整條模板同步（連收據 / 廚房單模板）都會一齊壞；兜咗就只係
 * 交班模板暫時退回本機預設，其餘四個槽位照同步。
 */
function isMissingColumnError(err: { code?: string | null; message?: string | null } | null): boolean {
  if (!err) return false;
  if (err.code === "42703") return true;
  return /column .* does not exist/i.test(err.message ?? "");
}

/** 完整欄位（0030 之後）。 */
const TEMPLATE_COLUMNS = "receipt, label, kitchen, kiosk, shift, shift_presets, updated_at";
/** 降級欄位（0030 之前）——migration 未跑時用，令其餘四個槽位照樣同步。 */
const TEMPLATE_COLUMNS_LEGACY = "receipt, label, kitchen, kiosk, updated_at";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  if (!storeId) {
    return NextResponse.json({
      ok: true,
      found: false,
      templates: null,
      updatedAt: null,
      reason: "no-store-id",
    });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    // 未配 Supabase：唔好當錯誤 —— 返「無 server 記錄」，等 client 保留本地模板（離線優先）
    return NextResponse.json({
      ok: true,
      fallback: true,
      found: false,
      templates: null,
      updatedAt: null,
    });
  }

  // ⚠️ 兩個 select 一定要各自 inline，唔好抽成 `(columns: string) => supabase...select(columns)`
  // 呢種包裝 —— 參數一寫 `string`，supabase-js 嘅 `select<Query extends string>` 就推導唔到
  // 欄位名，`data` 會變成 `GenericStringError`，之後 `data.receipt` 全部報 TS2339。
  let data: LooseTemplateRow | null;
  let error: { code?: string | null; message?: string | null } | null;
  let legacyColumns = false;

  const primary = await supabase
    .from("pos_print_templates")
    .select(TEMPLATE_COLUMNS)
    .eq("store_id", storeId)
    .maybeSingle();

  if (primary.error && isMissingColumnError(primary.error)) {
    // 0030 未跑：降級讀舊欄位（交班模板會用 client 本機預設）。
    legacyColumns = true;
    const fallback = await supabase
      .from("pos_print_templates")
      .select(TEMPLATE_COLUMNS_LEGACY)
      .eq("store_id", storeId)
      .maybeSingle();
    data = (fallback.data ?? null) as unknown as LooseTemplateRow | null;
    error = fallback.error;
  } else {
    data = (primary.data ?? null) as unknown as LooseTemplateRow | null;
    error = primary.error;
  }

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  if (!data) {
    // 未設定過 → found:false，client 保留本機（向後兼容舊店已設計但未上傳嘅模板）
    return NextResponse.json({
      ok: true,
      found: false,
      templates: null,
      updatedAt: null,
    });
  }

  // 用同 client 一致嘅 normalize：舊 DB 記錄缺新 section（例如 shift 未存過）都唔會
  // 被當成權威蓋走預設 —— normalize 會補返預設 + 保留已存嘅用戶設定。
  const templates = normalizePrintTemplateSet(rowToTemplates(data));

  return NextResponse.json({
    ok: true,
    found: true,
    templates,
    // 交班模板範本庫（2026-09-10）：同模板一齊同步，令另一部收銀機都見到同一批範本。
    // 0030 未跑（legacyColumns）→ 舊 select 冇呢欄 → 一律 null，client 保留本機範本。
    shiftPresets: normalizeShiftPresetsPayload(data.shift_presets),
    updatedAt: typeof data.updated_at === "string" ? data.updated_at : null,
    // 診斷用：true = 讀唔到 shift / shift_presets 欄（0030 migration 未跑），
    // 交班模板暫時只用本機設定。唔影響其餘四個槽位。
    legacyColumns,
  });
}

/**
 * 範本庫 payload normalize（server 端）。
 *
 * DB 欄係 jsonb，可能係 `{}`（0030 之前嘅 row）／舊結構／手改過嘅殘缺值。
 * 一律收斂成 `{ presets, activeId }`，且 `presets` 保證非空（出廠至少一套「標準交班單」），
 * 令 client 唔需要為「server 傳咗個空陣列」寫額外 fallback。
 */
function normalizeShiftPresetsPayload(raw: unknown): { presets: ShiftTemplateVariant[]; activeId: string } {
  const obj = raw && typeof raw === "object" ? (raw as { presets?: unknown; activeId?: unknown }) : {};
  const presets = normalizeShiftTemplatePresets(obj.presets);
  const activeId =
    typeof obj.activeId === "string" && obj.activeId.trim()
      ? obj.activeId
      : DEFAULT_SHIFT_TEMPLATE_PRESET_ID;
  return { presets, activeId };
}

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => null)) as {
    storeId?: string;
    templates?: Partial<PrintTemplates>;
    /** 交班模板範本庫（2026-09-10）；舊 client 唔會帶，缺就保留 DB 舊值。 */
    shiftPresets?: { presets?: ShiftTemplateVariant[]; activeId?: string };
  } | null;
  const storeId = String(payload?.storeId ?? "").trim();

  if (!storeId) {
    return NextResponse.json({ ok: false, error: "缺少 storeId。" }, { status: 400 });
  }

  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "Supabase 伺服器端未配置（缺 service role key），打印模板無法同步到後台。" },
      { status: 503 },
    );
  }

  // 一店一行 upsert：任何一部終端儲存都會覆寫該店模板（last-write-wins）。
  // 為咗唔好整份 replace 前剷走「呢次請求冇帶但 DB 已有」嘅槽位（理論上舊 client 只帶
  // 部分槽位），先讀返現有 row，missing 槽位用 DB 舊值補返再寫。
  //
  // 0030 未跑（legacyColumns）→ 讀 / 寫都只掂四個舊欄，其餘照原樣（見 isMissingColumnError）。
  const old = await readExistingRow(storeId);
  if ("errorMessage" in old) {
    return NextResponse.json({ ok: false, error: old.errorMessage }, { status: 500 });
  }
  const legacyColumns = old.legacy;
  const oldRow = old.row;

  // 逐個槽位 `??`：client 冇帶（undefined）或帶 null → 用 DB 舊值，避免「舊 client
  // 只帶部分槽位」時把其餘槽位清空。（唔可以直接 spread：spread 會令顯式 null 覆蓋舊值。）
  const oldTemplates = rowToTemplates(oldRow);
  const incoming = payload?.templates;
  const merged = normalizePrintTemplateSet({
    receipt: incoming?.receipt ?? oldTemplates.receipt,
    label: incoming?.label ?? oldTemplates.label,
    kitchen: incoming?.kitchen ?? oldTemplates.kitchen,
    kiosk: incoming?.kiosk ?? oldTemplates.kiosk,
    shift: incoming?.shift ?? oldTemplates.shift,
  });

  // 範本庫：有帶 → 用 client 版本；冇帶 → 保留 DB 舊值（避免舊 client 一儲存就清空範本）。
  const shiftPresets = payload?.shiftPresets
    ? normalizeShiftPresetsPayload(payload.shiftPresets)
    : normalizeShiftPresetsPayload(oldRow?.shift_presets);

  const updatedAt = new Date().toISOString();
  /** 四個舊槽位（0030 之前就有）——降級時只寫呢部分。 */
  const baseRow = {
    store_id: storeId,
    receipt: merged.receipt as unknown as object,
    label: merged.label as unknown as object,
    kitchen: merged.kitchen as unknown as object,
    kiosk: merged.kiosk as unknown as object,
    updated_at: updatedAt,
  };
  const fullRow = {
    ...baseRow,
    shift: merged.shift as unknown as object,
    shift_presets: shiftPresets as unknown as object,
  };

  let writeError = legacyColumns
    ? (await supabase.from("pos_print_templates").upsert(baseRow, { onConflict: "store_id" })).error
    : null;
  if (!legacyColumns) {
    const first = await supabase.from("pos_print_templates").upsert(fullRow, { onConflict: "store_id" });
    if (first.error && isMissingColumnError(first.error)) {
      // 讀得成功但寫唔到（例如 migration 中途）→ 再兜一次，只寫四個舊槽位。
      writeError = (await supabase.from("pos_print_templates").upsert(baseRow, { onConflict: "store_id" })).error;
    } else {
      writeError = first.error;
    }
  }

  if (writeError) {
    return NextResponse.json({ ok: false, error: writeError.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    storeId,
    updatedAt,
    legacyColumns,
  });
}

/** 讀現有 row 嘅結果（成功 → row + legacy；失敗 → errorMessage）。 */
type ExistingRowResult =
  | { legacy: boolean; row: LooseTemplateRow | null }
  | { errorMessage: string };

/** 鬆散 row：唔同 select 欄位組合都接得住（見 route 內兩個 select 分支）。 */
type LooseTemplateRow = {
  receipt?: unknown;
  label?: unknown;
  kitchen?: unknown;
  kiosk?: unknown;
  shift?: unknown;
  shift_presets?: unknown;
  updated_at?: unknown;
};

/**
 * 把 DB row 收窄成 `Partial<PrintTemplates>`。
 *
 * 點解要特登做一層：`LooseTemplateRow` 嘅欄位係 `unknown`（同一個 type 要同時接住
 * 「有 shift 欄」同「冇 shift 欄」兩種 select 結果），而 `normalizePrintTemplateSet()`
 * 收 `Partial<PrintTemplates>`，`unknown` 唔可以當 template 型別傳入。
 * jsonb 內容本來就冇得喺編譯期保證（可能係舊結構 / 手改過），所以集中喺呢一個位
 * 做斷言，其餘路徑（normalize / render / 出紙）照樣受型別保護。
 */
function rowToTemplates(row: LooseTemplateRow | null | undefined): Partial<PrintTemplates> {
  if (!row) return {};
  return {
    receipt: row.receipt as ReceiptTemplate | undefined,
    label: row.label as LabelTemplate | undefined,
    kitchen: row.kitchen as KitchenTemplate | undefined,
    kiosk: row.kiosk as ReceiptTemplate | undefined,
    shift: row.shift as ShiftTemplate | undefined,
  };
}

/**
 * 讀現有模板 row，自動處理「0030 未跑」降級。
 *
 * ⚠️ 呢個兜底唔係多餘：`shift` / `shift_presets` 係 0030 新加嘅欄。
 * 若果代碼部署咗而 migration 未跑，`select` 會直接報 42703，
 * 唔兜就會令**整條模板同步**（連收據 / 標籤 / 廚房模板）一齊壞。
 * 兜咗之後：交班模板暫時只用本機，其餘槽位照舊。
 */
async function readExistingRow(storeId: string): Promise<ExistingRowResult> {
  const supabase = getSupabaseWriteClient();
  if (!supabase) return { errorMessage: "Supabase 伺服器端未配置（缺 service role key）。" };

  const primary = await supabase
    .from("pos_print_templates")
    .select("receipt, label, kitchen, kiosk, shift, shift_presets")
    .eq("store_id", storeId)
    .maybeSingle();

  if (!primary.error) return { legacy: false, row: primary.data as LooseTemplateRow | null };
  if (!isMissingColumnError(primary.error)) return { errorMessage: primary.error.message };

  const legacy = await supabase
    .from("pos_print_templates")
    .select("receipt, label, kitchen, kiosk")
    .eq("store_id", storeId)
    .maybeSingle();

  if (legacy.error) return { errorMessage: legacy.error.message };
  return { legacy: true, row: legacy.data as LooseTemplateRow | null };
}
