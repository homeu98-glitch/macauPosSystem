/**
 * `pos_note_presets`（0028 · per-store 備註真源）嘅伺服器端讀寫。
 *
 * 為咩要抽一個共用模組：呢張表嘅欄位清單喺 3 個地方出現（`/api/pos/state` 讀、
 * `/api/pos/note-presets` 讀 + 寫、`0034` 之後多咗一個折扣備註槽位），任何一處
 * 漏帶就會出現「store A 儲到、store B 讀唔到」嘅靜默漂移；同 types.ts ↔ storage.ts
 * 白名單嗰個歷史坑同源，所以集中一處維護。
 *
 * ⚠️ 0034 migration 未跑時，Supabase 會回 **42703（column does not exist）**。
 * 呢個模組一定要**降級而唔係拋錯**：寧願「折扣備註暫時唔同步」，都唔可以連帶
 * 令既有三個備註清單（常用 / 取消 / 免單）一齊死。降級時 key 一律 **omit / null**，
 * **唔可以回 `[]`** —— 回空陣列會令 client 以為「server 話冇備註」而清走本機設定。
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { isMissingColumnError } from "@/lib/supabase-errors";

export interface NotePresets {
  notePresets: string[];
  cancelNotePresets: string[];
  compNotePresets: string[];
  /** 折扣備註（0034 新增）。未跑 migration → 讀唔到，deprecated 降級由 caller 處理。 */
  discountNotePresets: string[];
}

/** 完整欄位（0034 之後） */
export const NOTE_PRESET_COLUMNS =
  "note_presets, cancel_note_presets, comp_note_presets, discount_note_presets, updated_at";

/** 降級欄位（0034 之前） */
export const NOTE_PRESET_COLUMNS_LEGACY = "note_presets, cancel_note_presets, comp_note_presets, updated_at";

export const EMPTY_NOTE_PRESETS: NotePresets = {
  notePresets: [],
  cancelNotePresets: [],
  compNotePresets: [],
  discountNotePresets: [],
};

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export { isMissingColumnError };

export type NotePresetsReadResult =
  | { ok: true; found: false; presets: null; updatedAt: null; hasDiscountColumn: boolean }
  | { ok: true; found: true; presets: NotePresets; updatedAt: string | null; hasDiscountColumn: boolean }
  | { ok: false; error: string };

/** 由 DB row 砌 `NotePresets`。`hasDiscountColumn = false` 時 discountNotePresets 一律 `[]`（真源唔存在）。 */
export function notePresetsFromRow(row: Record<string, unknown>, hasDiscountColumn: boolean): NotePresets {
  return {
    notePresets: normalizeStringArray(row.note_presets),
    cancelNotePresets: normalizeStringArray(row.cancel_note_presets),
    compNotePresets: normalizeStringArray(row.comp_note_presets),
    discountNotePresets: hasDiscountColumn ? normalizeStringArray(row.discount_note_presets) : [],
  };
}

/**
 * 讀一間店嘅備註預設。冇記錄 → `found:false`（client 保留本機，唔會被清空）。
 * 未跑 0034 → 自動唔帶 `discount_note_presets` 再讀一次（`hasDiscountColumn:false`）。
 */
export async function readNotePresets(
  supabase: SupabaseClient,
  storeId: string,
): Promise<NotePresetsReadResult> {
  const full = await supabase
    .from("pos_note_presets")
    .select(NOTE_PRESET_COLUMNS)
    .eq("store_id", storeId)
    .maybeSingle();

  if (full.error && isMissingColumnError(full.error)) {
    const legacy = await supabase
      .from("pos_note_presets")
      .select(NOTE_PRESET_COLUMNS_LEGACY)
      .eq("store_id", storeId)
      .maybeSingle();
    if (legacy.error) return { ok: false, error: legacy.error.message };
    if (!legacy.data) return { ok: true, found: false, presets: null, updatedAt: null, hasDiscountColumn: false };
    return {
      ok: true,
      found: true,
      presets: notePresetsFromRow(legacy.data as Record<string, unknown>, false),
      updatedAt: (legacy.data as { updated_at?: string | null }).updated_at ?? null,
      hasDiscountColumn: false,
    };
  }

  if (full.error) return { ok: false, error: full.error.message };
  if (!full.data) return { ok: true, found: false, presets: null, updatedAt: null, hasDiscountColumn: true };

  return {
    ok: true,
    found: true,
    presets: notePresetsFromRow(full.data as Record<string, unknown>, true),
    updatedAt: (full.data as { updated_at?: string | null }).updated_at ?? null,
    hasDiscountColumn: true,
  };
}

export type NotePresetsWriteResult =
  | { ok: true; updatedAt: string; discountNoteSynced: boolean }
  | { ok: false; error: string; detail?: string };

/**
 * 寫備註預設（一店一行 upsert，last-write-wins）。
 *
 * 語意同 0028 一致：**只有 request 有帶嘅槽位才覆寫**，冇帶嘅槽位保留 DB 舊值
 * （舊 client 唔識 `discountNotePresets`，唔可以因為佢冇帶就剷走）。
 * 未跑 0034 → 降級寫（唔帶新欄），其餘三個槽位照樣儲到。
 */
export async function writeNotePresets(
  supabase: SupabaseClient,
  storeId: string,
  patch: Partial<NotePresets>,
): Promise<NotePresetsWriteResult> {
  const current = await readNotePresets(supabase, storeId);
  if (!current.ok) return { ok: false, error: current.error };

  const old: Partial<NotePresets> = current.found ? (current.presets as NotePresets) : {};
  const merged: NotePresets = {
    notePresets: normalizeStringArray(patch.notePresets ?? old.notePresets),
    cancelNotePresets: normalizeStringArray(patch.cancelNotePresets ?? old.cancelNotePresets),
    compNotePresets: normalizeStringArray(patch.compNotePresets ?? old.compNotePresets),
    discountNotePresets: normalizeStringArray(patch.discountNotePresets ?? old.discountNotePresets),
  };

  const updatedAt = new Date().toISOString();
  const base = {
    store_id: storeId,
    note_presets: merged.notePresets,
    cancel_note_presets: merged.cancelNotePresets,
    comp_note_presets: merged.compNotePresets,
    updated_at: updatedAt,
  };

  if (current.hasDiscountColumn) {
    const { error } = await supabase
      .from("pos_note_presets")
      .upsert({ ...base, discount_note_presets: merged.discountNotePresets }, { onConflict: "store_id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true, updatedAt, discountNoteSynced: true };
  }

  // 降級：0034 未跑。一定要 **omit** 新欄（唔可以傳 null / []），否則 upsert 一樣會爆 42703。
  const { error } = await supabase.from("pos_note_presets").upsert(base, { onConflict: "store_id" });
  if (error) return { ok: false, error: error.message };
  return { ok: true, updatedAt, discountNoteSynced: false };
}
