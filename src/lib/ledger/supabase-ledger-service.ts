import "server-only";

import { createClient } from "@supabase/supabase-js";

/**
 * Ledger 專案嘅 **service-role** client（server-only，2026-09-21）。
 *
 * ── 為咩需要 ─────────────────────────────────────────────────────────────
 * `merchants` 係 **Ledger** 專案嘅表，但 POS 專案嘅 service-role client
 * （`getSupabaseWriteClient()`）打過去會 **404 / `PGRST205`**。
 *
 * `/api/pos/print-agent/pair` 嘅 `lookupMerchant()` 就係咁樣靜默 fail-open：
 * 錯誤碼落入 `INFRA_ERROR_CODES` ⇒ `kind:"unknown"` ⇒ **放行**
 * ⇒「storeId 必須對應真實商戶」呢道驗真**從未生效**。
 * 實測證據（`supabase_logs (8).csv`）：`GET /rest/v1/merchants?id=eq.…` → **404**。
 *
 * 後果就係註釋講嘅嗰個 silent failure：配一個唔存在嘅 storeId 都會「成功」，
 * 但 Realtime filter 永遠唔 match、`claim` 返 0 列 ⇒ **顯示已連線但一張都印唔出**。
 *
 * ── 🔴 權限取捨（開之前要清楚接受）──────────────────────────────────────
 * 加入 `LEDGER_SUPABASE_SERVICE_ROLE_KEY` ＝ **畀 POS 部署完整讀寫 Ledger 資料庫嘅能力**
 * （service_role bypass RLS）。POS 目前只有 Ledger **anon** 權限，
 * 所以呢一步係一次**權限升級**：POS Vercel 專案一旦洩漏 service key，
 * 影響面由「pos_* 表」擴大到「整個 Ledger 資料庫」。
 *
 * **更保守嘅替代方案（長遠推薦）**：請 Ledger 側開一支
 * `GET /api/integration/pos/merchant-exists?storeId=`
 * （走既有 `LEDGER_INTEGRATION_BASE_URL` 通道 ＋ `LEDGER_WEBHOOK_SECRET` 簽名，
 *  同 `/api/ledger/ensure-customer` 同一個模式）
 * ⇒ POS 完全唔需要任何特權 Ledger 憑證，只保留「Ledger → POS」單向信任。
 *
 * ── 未設 env 時嘅行為（重要）────────────────────────────────────────────
 * 回 `null` ⇒ 呼叫端**維持現狀（fail-open 放行）**。
 * 即係「加咗 code 但未加 env」＝ **行為零變化**，只係少一個註注定失敗嘅查詢
 * ＋ 一條更清楚嘅 warning。所以呢個改動**可以先行上線，env 之後再補**。
 */

/** 新 env：Ledger 專案嘅 service_role key（**server-only，唔可以加 `NEXT_PUBLIC_`**）。 */
const LEDGER_SERVICE_ROLE_ENV = "LEDGER_SUPABASE_SERVICE_ROLE_KEY";

/** Ledger 專案 URL（同 A 段公開變數共用同一個值）。 */
function resolveLedgerUrl(): string | null {
  return process.env.NEXT_PUBLIC_SUPABASE_URL ?? null;
}

/** 只讀 `LEDGER_SUPABASE_SERVICE_ROLE_KEY` —— **刻意唔 fallback** 去其他 key。 */
export function resolveLedgerServiceRoleKey(): string | null {
  const raw = process.env[LEDGER_SERVICE_ROLE_ENV];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || null;
}

/**
 * 有冇配置 Ledger service-role（唔會建立 client，零成本）。
 * 用嚟喺 route 內出清晰訊息，唔使先建 client 再判斷。
 */
export function isLedgerServiceConfigured(): boolean {
  return Boolean(resolveLedgerUrl() && resolveLedgerServiceRoleKey());
}

/**
 * 建立 Ledger service-role client。
 *
 * @returns 未配置（缺 URL 或 key）→ `null`（呼叫端要 fail-open，唔可以 throw）。
 */
export function getLedgerServiceClient() {
  const url = resolveLedgerUrl();
  const key = resolveLedgerServiceRoleKey();
  if (!url || !key) return null;

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
