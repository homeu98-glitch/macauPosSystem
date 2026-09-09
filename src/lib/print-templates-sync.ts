import { PrintTemplates } from "@/lib/types";

/**
 * 打印模板雲端同步 helper（0027 `pos_print_templates` 表）。
 *
 * print-center「進入即拉、儲存即 POST」同 pos-app 同步 merge 共用嘅 fetch 邏輯：
 * 全部經 server route `/api/pos/print-templates`，瀏覽器唔直接掂 Supabase。
 *
 * 任何網絡失敗都返 null（唔 throw）：離線 / server 503 時 caller 保留本地模板繼續用，
 * 同成個 POS 嘅「離線優先」一致（落唔到雲端就停喺本機，唔好彈 error 卡住收銀）。
 */

export type StorePrintTemplatesResult = {
  /** server 有冇存過呢間店嘅模板（false = 未設定 → 保留本地）。 */
  found: boolean;
  /** normalize 後嘅完整模板（found=false 時為 null）。 */
  templates: PrintTemplates | null;
  /** server 版本時間戳（LWW 基準；未設定過 / fallback 時為 null）。 */
  updatedAt: string | null;
};

/** 拉取某店模板（0027）。失敗 / 離線 → null（caller 保留本地）。 */
export async function fetchStorePrintTemplates(storeId: string): Promise<StorePrintTemplatesResult | null> {
  let res: Response;
  try {
    res = await fetch(`/api/pos/print-templates?storeId=${encodeURIComponent(storeId)}`, {
      cache: "no-store",
    });
  } catch {
    return null; // 離線 / 網絡錯
  }
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as
    | { ok?: boolean; found?: boolean; templates?: PrintTemplates | null; updatedAt?: string | null }
    | null;
  if (!data?.ok) return null;
  return {
    found: Boolean(data.found),
    templates: data.templates ?? null,
    updatedAt: data.updatedAt ?? null,
  };
}

/** 上傳該店整份模板（0027 upsert）。成功 → 回傳 server 新版本時間戳；失敗 / 離線 → null。 */
export async function pushStorePrintTemplates(
  storeId: string,
  templates: PrintTemplates,
): Promise<{ updatedAt: string } | null> {
  let res: Response;
  try {
    res = await fetch(`/api/pos/print-templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storeId, templates }),
    });
  } catch {
    return null; // 離線 / 網絡錯
  }
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { ok?: boolean; updatedAt?: string } | null;
  if (!data?.ok || !data.updatedAt) return null;
  return { updatedAt: data.updatedAt };
}
