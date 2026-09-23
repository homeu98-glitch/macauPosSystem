"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { AdminShell } from "@/components/admin-shell";
import {
  RELEASE_PLATFORMS,
  RELEASE_PLATFORM_BUTTON_LABEL,
  RELEASE_PLATFORM_FILE_LABEL,
  RELEASE_PLATFORM_LABEL,
  RELEASE_STORAGE_BUCKET,
  RELEASE_SUGGESTED_FILE_NAME,
  formatReleaseFileSize,
  validateReleaseDraft,
  type ReleasePlatform,
} from "@/lib/release/release-core";
import type { ReleaseVersionDto } from "@/lib/release/release-row";
import { loadAuthSession } from "@/lib/storage";

/**
 * Admin panel · 版本控制（2026-09-23，migration 0050）。
 *
 * ## 為何要有呢一頁
 *
 * 之前「派邊個安裝包」係**寫死喺代碼**：出新 APK 要改代碼 → commit → push
 * → 等 Vercel Redeploy；想出錯時退回上一個版本，更加係「改代碼 + 重新部署」。
 * 呢一頁將件事變成：**填一條資料、撳一下「設為目前版本」**（最多 60 秒生效）。
 *
 * ## 兩條獨立線
 *
 * `android` 同 `desktop` **各自**有一條 active —— 切換 APK 唔會影響桌面安裝包。
 * 呢個係刻意設計：兩個平台嘅出版節奏根本唔同步（APK 可能要跟打印機固件，
 * 桌面版跟 Electron）。DB 有 partial unique index 保證「每平台最多一個 active」。
 *
 * ## 🔴 「設為目前版本」係唯一嘅對外生效操作
 *
 * 其餘操作（新增、改資料、刪除）**都唔會**改變商家下載到嘅嘢。
 * 所以 UI 上一定要一眼睇得出「呢個平台而家派緊邊條」——呢頁用綠色邊框 + 「目前版本」標籤標示，
 * 並且每個平台只會有一條。
 *
 * ## 檔案本體
 *
 * 放 Supabase Storage（POS 專案 `iyrywzormzisyppkokbi`）嘅 **public** bucket
 * `macauposapk`。呢頁只填**相對路徑**（例如 `macau-pos.apk`），
 * 完整連結由 server 砌（`/storage/v1/object/public/macauposapk/<路徑>`）。
 * 亦可以直接填完整外部連結（CDN / GitHub Release），非空時會覆蓋砌出嚟嘅連結。
 *
 * ⚠️ 刪除只會刪 DB 記錄，**唔會**刪 Storage 入面嘅檔案（UI 有寫明）——
 *    Storage 刪除屬破壞性操作，而且舊版本可能仲有機用緊。
 */

type Meta = {
  bucket?: string;
  storagePrefix?: string | null;
  baseUrlConfigured?: boolean;
};

type ListPayload = Meta & {
  ok?: boolean;
  available?: boolean;
  reason?: string;
  error?: string;
  versions?: ReleaseVersionDto[];
  active?: Record<string, string | null>;
};

type Row = ReleaseVersionDto;

/** 新增／編輯表單狀態（全部係字串，方便直接綁 input）。 */
type DraftForm = {
  platform: ReleasePlatform;
  version: string;
  filePath: string;
  downloadUrl: string;
  fileSize: string;
  notes: string;
};

const EMPTY_FORM: DraftForm = {
  platform: "android",
  version: "",
  filePath: "",
  downloadUrl: "",
  fileSize: "",
  notes: "",
};

function formFromRow(row: Row): DraftForm {
  return {
    platform: row.platform,
    version: row.version,
    filePath: row.filePath ?? "",
    // 🔴 一定要用 `explicitDownloadUrl`（DB 原值）而唔係 `downloadUrl`（已解析結果）：
    //    用解析結果會把「由 file_path 砌出嚟」變成「寫死一條完整 URL」，
    //    之後換網域／改環境就唔會跟住變。
    downloadUrl: row.explicitDownloadUrl ?? "",
    fileSize: row.fileSize === null ? "" : String(row.fileSize),
    notes: row.notes ?? "",
  };
}

/** 澳門時間顯示（同 admin 其他頁一致）。 */
function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("zh-HK", {
    timeZone: "Asia/Macau",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(t));
}

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500";

export default function AdminVersionsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [meta, setMeta] = useState<Meta>({});
  const [available, setAvailable] = useState(true);
  const [reason, setReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 新增表單
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState<DraftForm>(EMPTY_FORM);
  const [addActivate, setAddActivate] = useState(true);
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // 編輯（一次只開一條）
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<DraftForm>(EMPTY_FORM);
  const [editError, setEditError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = loadAuthSession()?.adminSessionToken;
      if (!token) {
        setError("未授權，請先登入。");
        return;
      }
      const res = await fetch("/api/admin/release-versions", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = (await res.json()) as ListPayload;
      if (!res.ok || !json.ok) {
        setError(json.error ?? `載入失敗（HTTP ${res.status}）`);
        setRows([]);
        return;
      }
      setAvailable(json.available !== false);
      setReason(json.reason ?? null);
      setRows(json.versions ?? []);
      setMeta({
        bucket: json.bucket,
        storagePrefix: json.storagePrefix,
        baseUrlConfigured: json.baseUrlConfigured,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(
    method: "POST" | "PATCH" | "DELETE",
    body?: unknown,
    query?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const token = loadAuthSession()?.adminSessionToken;
    if (!token) return { ok: false, error: "未授權，請重新登入。" };
    try {
      const res = await fetch(`/api/admin/release-versions${query ?? ""}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) return { ok: false, error: json.error ?? `操作失敗（HTTP ${res.status}）` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 前端先驗一次（同 server 用同一支 `validateReleaseDraft`）⇒ 錯誤即時顯示，唔使等網絡。 */
  function preflight(form: DraftForm): string | null {
    const parsed = validateReleaseDraft({
      platform: form.platform,
      version: form.version,
      filePath: form.filePath,
      downloadUrl: form.downloadUrl,
      fileSize: form.fileSize,
      notes: form.notes,
    });
    return parsed.ok ? null : parsed.error;
  }

  async function submitAdd() {
    setAddError(null);
    const invalid = preflight(addForm);
    if (invalid) {
      setAddError(invalid);
      return;
    }
    setAdding(true);
    const result = await send("POST", { ...addForm, activate: addActivate });
    setAdding(false);
    if (!result.ok) {
      setAddError(result.error ?? "新增失敗。");
      return;
    }
    setNotice(
      addActivate
        ? `已新增 v${addForm.version.trim()} 並設為「${RELEASE_PLATFORM_LABEL[addForm.platform]}」目前版本。登入頁最多 60 秒後生效。`
        : `已新增 v${addForm.version.trim()}（未設為目前版本）。`,
    );
    setAddForm(EMPTY_FORM);
    setShowAdd(false);
    await load();
  }

  async function submitEdit(id: string) {
    setEditError(null);
    const invalid = preflight(editForm);
    if (invalid) {
      setEditError(invalid);
      return;
    }
    setBusyId(id);
    const result = await send("PATCH", { id, ...editForm });
    setBusyId(null);
    if (!result.ok) {
      setEditError(result.error ?? "更新失敗。");
      return;
    }
    setNotice("已更新版本資料。");
    setEditingId(null);
    await load();
  }

  async function activate(id: string, version: string, platform: ReleasePlatform) {
    if (
      !window.confirm(
        `將「${RELEASE_PLATFORM_LABEL[platform]}」目前版本切換為 v${version}？\n\n登入頁嘅下載按鈕最多 60 秒後會連去呢個版本。`,
      )
    ) {
      return;
    }
    setBusyId(id);
    const result = await send("PATCH", { id, activate: true });
    setBusyId(null);
    if (!result.ok) {
      window.alert(result.error ?? "切換失敗。");
      return;
    }
    setNotice(`已將「${RELEASE_PLATFORM_LABEL[platform]}」切換為 v${version}。`);
    await load();
  }

  async function remove(row: Row) {
    if (
      !window.confirm(
        `確定刪除 v${row.version}（${RELEASE_PLATFORM_LABEL[row.platform]}）？\n\n` +
          "⚠️ 只會刪除資料庫記錄，Storage 入面嘅檔案唔會被刪。\n" +
          (row.isActive ? "⚠️ 呢條係目前版本，刪除後該平台會變成「未設版本」，登入頁唔會再顯示下載按鈕。" : ""),
      )
    ) {
      return;
    }
    setBusyId(row.id);
    const result = await send("DELETE", undefined, `?id=${encodeURIComponent(row.id)}`);
    setBusyId(null);
    if (!result.ok) {
      window.alert(result.error ?? "刪除失敗。");
      return;
    }
    setNotice(`已刪除 v${row.version}。`);
    await load();
  }

  const byPlatform = useMemo(() => {
    const map: Record<ReleasePlatform, Row[]> = { android: [], desktop: [] };
    for (const row of rows) map[row.platform].push(row);
    return map;
  }, [rows]);

  const activeByPlatform = useMemo(() => {
    const map: Record<ReleasePlatform, Row | null> = { android: null, desktop: null };
    for (const row of rows) {
      if (row.isActive) map[row.platform] = row;
    }
    return map;
  }, [rows]);

  function formFields(form: DraftForm, setForm: (next: DraftForm) => void, idPrefix: string) {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">
          <span className="text-xs font-medium text-slate-600">平台</span>
          <select
            className={INPUT_CLASS}
            onChange={(e) => setForm({ ...form, platform: e.target.value as ReleasePlatform })}
            value={form.platform}
          >
            {RELEASE_PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {RELEASE_PLATFORM_LABEL[p]}
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-1">
          <span className="text-xs font-medium text-slate-600">版本號</span>
          <input
            className={INPUT_CLASS}
            onChange={(e) => setForm({ ...form, version: e.target.value })}
            placeholder="例如 1.4.2"
            value={form.version}
          />
        </label>

        <label className="grid gap-1 sm:col-span-2">
          <span className="text-xs font-medium text-slate-600">
            Storage 檔案路徑（bucket <span className="font-mono">{RELEASE_STORAGE_BUCKET}</span> 之內）
          </span>
          <input
            className={`${INPUT_CLASS} font-mono`}
            id={`${idPrefix}-file-path`}
            onChange={(e) => setForm({ ...form, filePath: e.target.value })}
            placeholder={RELEASE_SUGGESTED_FILE_NAME[form.platform]}
            value={form.filePath}
          />
          <span className="text-[11px] text-slate-400">
            可填子目錄，例如 <span className="font-mono">1.4.2/macau-pos.apk</span>。
            留空就要填下面嘅完整連結。
          </span>
        </label>

        <label className="grid gap-1 sm:col-span-2">
          <span className="text-xs font-medium text-slate-600">完整下載連結（可選，填咗會覆蓋上面嘅路徑）</span>
          <input
            className={`${INPUT_CLASS} font-mono`}
            onChange={(e) => setForm({ ...form, downloadUrl: e.target.value })}
            placeholder="https://…（CDN / GitHub Release / signed URL）"
            value={form.downloadUrl}
          />
        </label>

        <label className="grid gap-1">
          <span className="text-xs font-medium text-slate-600">檔案大小（bytes，可選）</span>
          <input
            className={INPUT_CLASS}
            inputMode="numeric"
            onChange={(e) => setForm({ ...form, fileSize: e.target.value.replace(/[^\d]/g, "") })}
            placeholder="例如 12345678"
            value={form.fileSize}
          />
          <span className="text-[11px] text-slate-400">
            會顯示喺登入頁（目前：{formatReleaseFileSize(form.fileSize ? Number.parseInt(form.fileSize, 10) : null)}）
          </span>
        </label>

        <label className="grid gap-1">
          <span className="text-xs font-medium text-slate-600">更新內容（可選）</span>
          <input
            className={INPUT_CLASS}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            placeholder="例如：修正廚房單漏印"
            value={form.notes}
          />
        </label>
      </div>
    );
  }

  return (
    <AdminShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-slate-900">版本控制</h1>
            <p className="mt-1 text-sm text-slate-500">
              管理「登入頁下載按鈕」連去邊個安裝包版本。Android 與 Desktop 各自一條線、各自一個「目前版本」。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
            >
              重新載入
            </button>
            <button
              type="button"
              onClick={() => {
                setShowAdd((v) => !v);
                setAddError(null);
              }}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              {showAdd ? "取消新增" : "新增版本"}
            </button>
          </div>
        </div>

        {notice ? (
          <div className="flex items-start justify-between gap-3 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
            <span>{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="shrink-0 rounded-lg px-2 py-1 text-xs text-green-700 hover:bg-green-100"
            >
              知道了
            </button>
          </div>
        ) : null}

        {!available && reason ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <p className="font-semibold">版本控制尚未啟用</p>
            <p className="mt-1">{reason}</p>
          </div>
        ) : null}

        {available && !meta.baseUrlConfigured ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            未偵測到 POS 專案嘅 Supabase URL（<code>SUPABASE_URL</code>）⇒
            由「檔案路徑」砌唔到下載連結。你可以暫時改填「完整下載連結」，或補齊環境變數後重新部署。
          </div>
        ) : null}

        {meta.storagePrefix ? (
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">
            Storage 公開前綴：
            <span className="ml-1 break-all font-mono text-slate-700">{meta.storagePrefix}</span>
            <span className="ml-2">（bucket <span className="font-mono">{meta.bucket ?? RELEASE_STORAGE_BUCKET}</span> 必須係 public）</span>
          </div>
        ) : null}

        {error ? <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}

        {/* 新增表單 */}
        {showAdd ? (
          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-900">新增版本</h2>
            <p className="mt-1 text-xs text-slate-500">
              新版本預設<b>唔會</b>對外生效，要另外撳「設為目前版本」；想即刻生效就勾下面嘅選項。
            </p>
            <div className="mt-4">{formFields(addForm, setAddForm, "add")}</div>

            <label className="mt-3 inline-flex cursor-pointer items-center gap-2.5 text-sm text-slate-700">
              <input
                checked={addActivate}
                className="h-4 w-4 accent-orange-500"
                onChange={(e) => setAddActivate(e.target.checked)}
                type="checkbox"
              />
              新增後即刻設為該平台嘅「目前版本」
            </label>

            {addError ? <p className="mt-3 text-sm text-red-600">{addError}</p> : null}

            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                disabled={adding}
                onClick={() => void submitAdd()}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {adding ? "新增中…" : "確認新增"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAddForm(EMPTY_FORM);
                  setAddError(null);
                  setShowAdd(false);
                }}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                取消
              </button>
            </div>
          </section>
        ) : null}

        {loading ? (
          <p className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">載入中…</p>
        ) : (
          RELEASE_PLATFORMS.map((platform) => {
            const list = byPlatform[platform];
            const active = activeByPlatform[platform];
            return (
              <section key={platform} className="rounded-xl border border-slate-200 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900">{RELEASE_PLATFORM_LABEL[platform]}</h2>
                    <p className="mt-0.5 text-xs text-slate-500">
                      登入頁按鈕文案：<span className="font-medium text-slate-700">{RELEASE_PLATFORM_BUTTON_LABEL[platform]}</span>
                    </p>
                  </div>
                  <div className="text-xs">
                    {active ? (
                      <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-1 font-medium text-green-700">
                        目前版本 v{active.version}
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-600">
                        未設版本（登入頁唔會顯示按鈕）
                      </span>
                    )}
                  </div>
                </div>

                {list.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-slate-500">
                    尚未新增 {RELEASE_PLATFORM_FILE_LABEL[platform]} 版本。
                  </p>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {list.map((row) => {
                      const editing = editingId === row.id;
                      return (
                        <div
                          key={row.id}
                          className={`px-4 py-3 ${row.isActive ? "bg-green-50/60" : ""}`}
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-semibold text-slate-900">v{row.version}</span>
                                {row.isActive ? (
                                  <span className="rounded-full bg-green-600 px-2 py-0.5 text-[11px] font-bold text-white">
                                    目前版本
                                  </span>
                                ) : null}
                                {!row.downloadUrl ? (
                                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-bold text-red-700">
                                    連結無法產生
                                  </span>
                                ) : null}
                                <span className="text-[11px] text-slate-400">建立 {fmtTime(row.createdAt)}</span>
                              </div>

                              {row.filePath ? (
                                <p className="mt-1 break-all font-mono text-xs text-slate-600">{row.filePath}</p>
                              ) : null}

                              {row.downloadUrl ? (
                                <p className="mt-1 break-all text-xs text-slate-400">{row.downloadUrl}</p>
                              ) : null}

                              <p className="mt-1 text-xs text-slate-500">
                                大小 {formatReleaseFileSize(row.fileSize)}
                                {row.notes ? ` · 更新內容：${row.notes}` : ""}
                              </p>
                            </div>

                            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                              {!row.isActive ? (
                                <button
                                  type="button"
                                  disabled={busyId === row.id || !row.downloadUrl}
                                  onClick={() => void activate(row.id, row.version, row.platform)}
                                  className="rounded-lg bg-green-600 px-3 py-2 text-xs font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-40"
                                  title={!row.downloadUrl ? "連結無法產生，唔可以設為目前版本" : undefined}
                                >
                                  設為目前版本
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  disabled={busyId === row.id}
                                  onClick={() => {
                                    if (
                                      window.confirm(
                                        `停用 v${row.version}？\n\n停用後「${RELEASE_PLATFORM_LABEL[platform]}」會變成未設版本，登入頁唔會再顯示下載按鈕。`,
                                      )
                                    ) {
                                      void (async () => {
                                        setBusyId(row.id);
                                        const r = await send("PATCH", { id: row.id, activate: false });
                                        setBusyId(null);
                                        if (!r.ok) {
                                          window.alert(r.error ?? "停用失敗。");
                                          return;
                                        }
                                        setNotice(`已停用 v${row.version}。`);
                                        await load();
                                      })();
                                    }
                                  }}
                                  className="rounded-lg border border-amber-300 px-3 py-2 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-40"
                                >
                                  停用
                                </button>
                              )}

                              <button
                                type="button"
                                onClick={() => {
                                  if (editing) {
                                    setEditingId(null);
                                    setEditError(null);
                                    return;
                                  }
                                  setEditingId(row.id);
                                  setEditForm(formFromRow(row));
                                  setEditError(null);
                                }}
                                className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                              >
                                {editing ? "取消" : "編輯"}
                              </button>

                              <button
                                type="button"
                                disabled={busyId === row.id}
                                onClick={() => void remove(row)}
                                className="rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40"
                              >
                                刪除
                              </button>
                            </div>
                          </div>

                          {editing ? (
                            <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                              {formFields(editForm, setEditForm, `edit-${row.id}`)}
                              {editError ? <p className="mt-3 text-sm text-red-600">{editError}</p> : null}
                              <div className="mt-3 flex items-center gap-2">
                                <button
                                  type="button"
                                  disabled={busyId === row.id}
                                  onClick={() => void submitEdit(row.id)}
                                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                                >
                                  {busyId === row.id ? "儲存中…" : "儲存變更"}
                                </button>
                                <span className="text-xs text-slate-500">
                                  改資料唔會影響「目前版本」，要切換請撳上面嘅按鈕。
                                </span>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })
        )}

        <p className="text-xs text-slate-400">
          登入頁嘅下載入口有 60 秒 CDN 快取 ⇒ 切換版本後最多 60 秒生效。刪除只清 DB 記錄，Storage 檔案請自行喺
          Supabase Dashboard 管理。
        </p>
      </div>
    </AdminShell>
  );
}
