/**
 * `pos_release_versions` row → API/UI DTO 映射（2026-09-23）。
 *
 * ## 為何要獨立一層
 *
 * 有三個地方要講同一種「版本」物件：
 *   · `/api/release/versions/active`（公開，登入頁用）
 *   · `/api/admin/release-versions`（管理，版本控制頁用）
 *   · client 元件嘅型別
 *
 * 若各寫一份映射，就會出現「公開頁有 `url`、admin 頁冇」、「一條 trim 咗一條冇」
 * 之類嘅漂移。所以收喺呢度一份，並且**保持純函式**（唔讀 env、唔碰 DB）：
 * `supabaseBaseUrl` 由呼叫方傳入（server 端讀 env），client 端就傳 `""` —— 因為
 * 公開 API 已經回傳**解析好**嘅 `downloadUrl`，client 唔需要自己砌。
 *
 * ⚠️ 保持可被 `node --test` 載入：只 import `./release-core.ts`（相對路徑 + 顯式 `.ts`）。
 */

import {
  isReleasePlatform,
  resolveReleaseDownloadUrl,
  type ReleasePlatform,
} from "./release-core.ts";

/** DB row 形狀（snake_case，同 migration 0050 一致）。 */
export type ReleaseVersionRow = {
  id?: string | null;
  platform?: string | null;
  version?: string | null;
  file_path?: string | null;
  download_url?: string | null;
  file_size?: number | string | null;
  notes?: string | null;
  is_active?: boolean | null;
  created_at?: string | null;
  updated_at?: string | null;
};

/** 對外 DTO（camelCase，`downloadUrl` 已經係最終可用連結）。 */
export type ReleaseVersionDto = {
  id: string;
  platform: ReleasePlatform;
  version: string;
  filePath: string | null;
  /** 最終下載連結；`null` ＝ 砌唔到（呼叫方要當「冇」處理，唔好顯示死 link）。 */
  downloadUrl: string | null;
  /**
   * DB 入面**原樣儲存**嘅 `download_url`（未經解析、冇 fallback）。
   *
   * 為何要同 `downloadUrl` 分開：`downloadUrl` 係「最終結果」（有 `file_path` 時
   * 由 server 砌出嚟），唔可以再寫返 DB —— 否則會把「由路徑砌」變成
   * 「寫死一條完整 URL」，之後改環境／換網域就唔會跟住變。
   * admin 編輯表單要顯示「原本填咗咩」，所以要留住原值。
   * 公開 API 唔會出呢個欄位（只出 5 個精簡欄位）。
   */
  explicitDownloadUrl: string | null;
  fileSize: number | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 映射一條 row。**唔會 throw**。
 *
 * @returns `null` ＝ 呢條 row 唔合法（`platform` 唔係 android/desktop、或者冇 id／版本號）
 *          ⇒ 呼叫方過濾走，唔好 render 一條撳唔到嘅版本出嚟。
 */
export function mapReleaseVersionRow(
  row: ReleaseVersionRow | null | undefined,
  options: { supabaseBaseUrl?: string | null; bucket?: string | null } = {},
): ReleaseVersionDto | null {
  if (!row || typeof row !== "object") return null;

  const id = textOrNull(row.id);
  if (!id) return null;
  if (!isReleasePlatform(row.platform)) return null;

  const version = textOrNull(row.version);
  if (!version) return null;

  const filePath = textOrNull(row.file_path);
  const explicitUrl = textOrNull(row.download_url);

  return {
    id,
    platform: row.platform,
    version,
    filePath,
    downloadUrl: resolveReleaseDownloadUrl({
      downloadUrl: explicitUrl,
      filePath,
      supabaseUrl: options.supabaseBaseUrl,
      bucket: options.bucket,
    }),
    explicitDownloadUrl: explicitUrl,
    fileSize: numberOrNull(row.file_size),
    notes: textOrNull(row.notes),
    isActive: row.is_active === true,
    createdAt: textOrNull(row.created_at),
    updatedAt: textOrNull(row.updated_at),
  };
}

/** 批次映射 + 掉走非法 row（順序保持）。 */
export function mapReleaseVersionRows(
  rows: ReadonlyArray<ReleaseVersionRow> | null | undefined,
  options: { supabaseBaseUrl?: string | null; bucket?: string | null } = {},
): ReleaseVersionDto[] {
  if (!Array.isArray(rows)) return [];
  const out: ReleaseVersionDto[] = [];
  for (const row of rows) {
    const mapped = mapReleaseVersionRow(row, options);
    if (mapped) out.push(mapped);
  }
  return out;
}

/** 每個平台目前 active 嘅版本（`null` ＝ 該平台未設 active，登入頁就唔顯示按鈕）。 */
export type ActiveReleaseMap = Record<ReleasePlatform, ReleaseVersionDto | null>;

/**
 * 由**已映射**嘅 DTO 清單抽出每個平台嘅 active 版本。
 *
 * DB 有 partial unique index 保證「每平台最多一個 active」，但呢度仍然寫成
 * 「取 updatedAt 最新嘅一個」而唔係「取第一個」：
 *   · 萬一 index 未跑到（migration 順序問題）、或者資料由 SQL 手改壞，
 *     登入頁都唔會因為「唔知揀邊條」而亂派連結 —— 永遠派最新改動嘅嗰條。
 *   · 唔會 throw、唔會回 undefined，型別上兩個平台一定有 key。
 */
export function pickActiveReleases(dtos: ReadonlyArray<ReleaseVersionDto>): ActiveReleaseMap {
  const result: ActiveReleaseMap = { android: null, desktop: null };

  for (const dto of dtos) {
    if (!dto.isActive) continue;
    const current = result[dto.platform];
    if (!current) {
      result[dto.platform] = dto;
      continue;
    }
    const currentTime = Date.parse(current.updatedAt ?? current.createdAt ?? "") || 0;
    const nextTime = Date.parse(dto.updatedAt ?? dto.createdAt ?? "") || 0;
    if (nextTime >= currentTime) result[dto.platform] = dto;
  }

  return result;
}

/** 排序：平台（android 先）→ created_at 新 → 舊。admin 列表用。 */
export function sortReleaseVersions(dtos: ReadonlyArray<ReleaseVersionDto>): ReleaseVersionDto[] {
  const platformRank: Record<ReleasePlatform, number> = { android: 0, desktop: 1 };
  return [...dtos].sort((a, b) => {
    if (a.platform !== b.platform) return platformRank[a.platform] - platformRank[b.platform];
    const at = Date.parse(a.createdAt ?? "") || 0;
    const bt = Date.parse(b.createdAt ?? "") || 0;
    if (bt !== at) return bt - at;
    return a.version.localeCompare(b.version);
  });
}
