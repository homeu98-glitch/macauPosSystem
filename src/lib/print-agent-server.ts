// Cloud Print Relay — server-side helpers（Vercel route 共用，見 docs/96 §8）。
//
// 安全模型（與現有 /api/pos/* 一致：信任 client 傳入嘅 storeId，service_role 寫入）：
//   · POST /pair 由已登入嘅 web（iPad）發起，帶 agentId + token + storeId。
//     token 只存 sha256（token_hash），明文 token 只喺配對嗰一刻經 HTTPS 交一次。
//   · claim / result / heartbeat 靠 `x-agent-id` + `x-agent-token` 做 agent 驗證：
//     sha256(x-agent-token) 必須等於 pos_print_agents.token_hash，且 revoked_at is null。
//     -> 驗唔過返 401，APK 會清配對返去配對畫面。

import "server-only";
import { createHash } from "crypto";

import { getSupabaseWriteClient } from "@/lib/supabase-server";

/** sha256 hex（用嚟將 agent token 轉 token_hash 儲存 / 比對）。 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
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
  if (!token || sha256Hex(token) !== agent.tokenHash) return null;
  return agent;
}

/** 由 request header 拎 `x-agent-id` / `x-agent-token`（APK 固定帶呢兩個）。 */
export function readAgentHeaders(request: Request): { agentId: string; token: string } {
  return {
    agentId: request.headers.get("x-agent-id") ?? "",
    token: request.headers.get("x-agent-token") ?? "",
  };
}
