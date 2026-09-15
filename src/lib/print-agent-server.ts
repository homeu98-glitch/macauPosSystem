// Cloud Print Relay — server-side helpers（Vercel route 共用，見 docs/96 §8）。
//
// 安全模型（與現有 /api/pos/* 一致：信任 client 傳入嘅 storeId，service_role 寫入）：
//   · POST /pair 由已登入嘅 web（iPad）發起，帶 agentId + token + storeId。
//     token 只存 sha256（token_hash），明文 token 只喺配對嗰一刻經 HTTPS 交一次。
//   · claim / result / heartbeat 靠 `x-agent-id` + `x-agent-token` 做 agent 驗證：
//     sha256(x-agent-token) 必須等於 pos_print_agents.token_hash，且 revoked_at is null。
//     -> 驗唔過返 401，APK 會清配對返去配對畫面。

import "server-only";
import { createHash, timingSafeEqual } from "crypto";

import { getSupabaseWriteClient } from "@/lib/supabase-server";

/** sha256 hex（用嚟將 agent token 轉 token_hash 儲存 / 比對）。 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * 定時安全嘅 hex 字串比對（2026-09-15 資安加固）。
 *
 * 為何要：`token` 係由 client（APK）提供嘅值，屬**可遠端量測**嘅輸入。
 * 以前用 `sha256Hex(token) !== agent.tokenHash` 直接字串比較 —— JS 嘅 `!==`
 * 會喺第一個唔同嘅字元就返回，理論上可以用回應時間逐步還原 hash
 * （timing side-channel）。同專案其他簽名驗證（`webhook-signature.ts`、
 * `pos-device-token.ts`）都已用 `timingSafeEqual`，呢度係唯一漏網。
 *
 * 行為完全不變：只係「唔同長度 → false」＋「等長 → 定時安全比較」。
 */
function safeEqualHex(a: string, b: string): boolean {
  // 防禦性：`0020` 已寫明 `token_hash text not null`，但 DB 始終係外部輸入，
  // 型別保證唔可以當成 runtime 保證（null 會令 `b.length` 直接 throw）。
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

export interface PairedAgent {
  agentId: string;
  storeId: string;
  storeName: string | null;
  name: string | null;
  revokedAt: string | null;
  tokenHash: string;
}

/**
 * 由 agent_id 載入已配對 agent（service_role，可讀 token_hash）。
 *
 * ⚠️ **唔好 select `store_name`** —— `pos_print_agents` 冇呢條欄（0020 migration 只係
 * 喺 `pos_print_jobs` 加咗 `store_name`，agents 表淨得 `name`）。Select 佢會出
 * `42703 column pos_print_agents.store_name does not exist` → 成個 function 返 null，
 * 連鎖爆三處：① `GET /pair` 永遠 pending（Hub 拎唔到憑證）② `/pair-status` 500
 * ③ **claim / result / heartbeat 嘅 verifyAgent() 全部驗唔過 → 成條中繼斷晒**。
 *
 * 店名喺 web 端由 auth session（`loadAuthSession().name`，即 `merchants.name`）直接攞，
 * 唔使落 DB，亦唔使為咗個顯示名加 migration。
 */
export async function loadPairedAgent(agentId: string): Promise<PairedAgent | null> {
  const supabase = getSupabaseWriteClient();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("pos_print_agents")
    .select("agent_id, store_id, name, revoked_at, token_hash")
    .eq("agent_id", agentId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    agentId: data.agent_id,
    storeId: data.store_id,
    storeName: null, // 見上面註解：agents 表冇 store_name 欄
    name: data.name ?? null,
    revokedAt: data.revoked_at ?? null,
    tokenHash: data.token_hash,
  };
}

/** 驗證 agent（agentId + token 對得上且未 revoke）。失敗返 null。 */
export async function verifyAgent(agentId: string, token: string): Promise<PairedAgent | null> {
  const agent = await loadPairedAgent(agentId);
  if (!agent) return null;
  if (agent.revokedAt) return null;
  if (!token || !safeEqualHex(sha256Hex(token), agent.tokenHash)) return null;
  return agent;
}

/** 由 request header 拎 `x-agent-id` / `x-agent-token`（APK 固定帶呢兩個）。 */
export function readAgentHeaders(request: Request): { agentId: string; token: string } {
  return {
    agentId: request.headers.get("x-agent-id") ?? "",
    token: request.headers.get("x-agent-token") ?? "",
  };
}

/**
 * 🔴 交畀 APK 嘅 Realtime 連線目標 —— **一定要係 POS 自有專案**。
 *
 * `GET /pair` 同 `GET /pair-status` 共用呢一個函數，確保兩邊口徑**永遠唔會漂移**
 * （2026-09-16：之前 `/pair` 用 `SUPABASE_URL ?? NEXT_PUBLIC_SUPABASE_URL` fallback，
 * 而 `/pair-status` 完全唔睇呢件事，兩者可以一個回錯專案、一個照回「已配對」）。
 *
 * 【為何唔可以 fallback 去 `NEXT_PUBLIC_SUPABASE_URL`】
 * `NEXT_PUBLIC_SUPABASE_URL` 係 **Ledger** 專案（見 `.env.example` A 段，
 * 同 `supabase-client.ts` / `member-login.server.ts` 一致）。Ledger **冇任何 `pos_*` 表**。
 *
 * 一旦 fallback 生效，`/pair` 會照樣回 `status:"paired"` 加一組**錯專案**嘅
 * `supabaseUrl` + `anonKey`，APK 存落 `RelayPrefs` 之後：
 *   · WebSocket 打得開、`phx_join` 一樣回 `status:"ok"`
 *     （`RealtimeClient.sendJoin()` 只認 phx_reply，**唔會**驗證 `pos_print_jobs` 存唔存在）→
 *     App 顯示「已連線（Realtime）」；
 *   · 但訂嘅係一張**唔存在嘅表** → 永遠收唔到 wake-up；
 *   · `GET /pair` 唔報錯、`/pair-status` 又係綠 → **兩邊都話正常，一張都印唔出**。
 * 呢個正是 `realtime-target.ts` 記錄嘅 2026-09-10 P0 同類病（靜默失效）。
 *
 * 所以：**寧願缺值（APK 有 fallback 可見），都唔可以回錯專案**。
 * 缺值時 APK 行 `RelayService.startRealtimeIfNeeded()` 會 note
 * 「欠 supabaseUrl / anonKey，用 30s 輪詢兜底」，而佢本身嘅 30s 對帳 tick 仍然
 * `POST /claim` 拎得到單 → **退化而唔係斷線**，比靜默失效好得多。
 *
 * ⚠️ anon key 亦刻意唔 fallback：Ledger 嘅 anon key 對 POS 專案無效，
 *    配埋一齊只會令 Realtime 認證失敗（更難查）。
 * ⚠️ 兩個值必須**成對** —— 半對（有 url 冇 key）同樣令 Realtime 開唔到，
 *    所以只要其中一個缺就回 `null`，唔好交半截憑證畀 APK 存落本機。
 */
export function resolveRelayRealtimeConfig(): { url: string; anonKey: string } | null {
  const url = process.env.SUPABASE_URL?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return null;
  return { url, anonKey };
}
