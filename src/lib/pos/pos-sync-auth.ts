import { loadAuthSession, saveAuthSession, type AuthSession } from "@/lib/storage";

import { readClientBuildInfo } from "@/lib/build-info";
import { POS_BUILD_HEADER, POS_SESSION_HEADER } from "./session-record";
import { getPosSessionKey } from "./session-key";

/**
 * POS 終端憑證（`Authorization: Bearer`）嘅 **client 側** 讀取 + 續期。
 *
 * 2026-09-10 掃碼點餐審查 P0-3：`/api/pos/sync`（寫入）、`/api/pos/state`（讀取）、
 * `/api/pos/bootstrap` POST、`/api/pos/kiosk-settings` POST 都需要證明「我係店內終端」。
 * Token 由 `/api/ledger/login` 登入成功時簽發（server 端唯一權威知道 merchantId 嘅地方），
 * 存喺 `authSession.posDeviceToken`。
 *
 * ⚠️ 掃碼客人（匿名）冇 authSession → 冇 token → 屬「匿名通道」，
 * server 只放行 ORDER_CREATED / ORDER_UPDATED（source ∈ scan / kiosk）。
 *
 * 【續期】token TTL 12 小時，收銀機全日開住，所以一定要有自動續期，
 * 否則每日會定時失效、部署當日舊 session 亦會即刻 401。
 * 續期行 `/api/pos/device-token`（用 authSession 已存嘅 Ledger access token 換新憑證）。
 */

export function getPosDeviceToken(): string | null {
  if (typeof window === "undefined") return null;
  const token = loadAuthSession()?.posDeviceToken;
  return typeof token === "string" && token ? token : null;
}

/**
 * 需要授權嘅 POS 端點用：`fetch(url, { headers: { ...jsonHeaders, ...posDeviceAuthHeaders() } })`
 *
 * ── 2026-09-22 加兩個標頭：工作階段身分 + 分頁實際跑緊嘅版本 ──────────────
 *
 * | 標頭 | 值 | 用途 |
 * |---|---|---|
 * | `x-pos-session` | 每個分頁一個（`sessionStorage`）| server 登記／續期 `pos_sessions` |
 * | `x-pos-build` | 內聯嘅 `NEXT_PUBLIC_BUILD_ID` | 管理員睇「邊個分頁跑住舊版」|
 *
 * 🔴 **零新增請求**：呢兩個標頭只係搭喺**已經會發生**嘅請求上。server 收到就順手
 * 續期（POST 60 秒節流、GET 5 分鐘節流），唔會多打任何一次網絡。
 *
 * 🔴 為何要由 client 報版本：server 只知「線上最新部署」，**唔可能**知呢個分頁
 * 實際跑緊邊份 JS（舊分頁跑舊 bundle 正是 2026-09-21 egress 事故嘅根源）。
 */
export function posDeviceAuthHeaders(): Record<string, string> {
  const token = getPosDeviceToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  // 匿名端點（掃碼客人）唔會有 token，但一樣會行到呢度 —— 唔緊要：
  // 「客人手機開咗幾個分頁」唔係我哋要管嘅事，server 端亦只認已授權嘅請求。
  if (token) {
    headers[POS_SESSION_HEADER] = getPosSessionKey();
    const buildId = readClientBuildInfo().id;
    if (buildId) headers[POS_BUILD_HEADER] = buildId;
  }
  return headers;
}

/**
 * 「先續期、後取 header」一次搞掂 —— 需要授權嘅 POS 端點**一律用呢個**。
 *
 * ⚠️ 點解要有呢個 helper（2026-09-10 補）：
 * `posDeviceAuthHeaders()` 只係讀 `authSession.posDeviceToken`，**唔會續期**。
 * Token TTL 12 小時，收銀機／設定頁開住過夜就一定過期，於是
 * 「掣撳得落、但 server 回 401 未經授權」——最易被誤判成「帳號權限問題」嘅一種 bug。
 * `/api/pos/bootstrap` POST（上傳菜單 / 桌台）、`/api/pos/kiosk-settings` POST
 * （掃碼模式 / 自動接單）都係咁樣中過。
 *
 * 用法：`fetch(url, { headers: { "Content-Type": "application/json", ...(await posDeviceAuthHeadersFresh()) } })`
 * 續期失敗（冇 authSession / 離線）唔會 throw，只會回空 object ——
 * 之後嘅 401 由 caller 自己按業務需要提示。
 */
export async function posDeviceAuthHeadersFresh(): Promise<Record<string, string>> {
  await refreshPosDeviceTokenIfNeeded();
  return posDeviceAuthHeaders();
}

/** 讀 token payload 嘅 `exp`（epoch ms）。解唔到回 `null`。 */
function readTokenExp(token: string): number | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  try {
    const json = JSON.parse(atob(token.slice(0, dot).replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json?.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}

/** 續期提前量：剩返少過 10 分鐘就當「要續」。 */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
/** 同一次續期請求去重（多個 component 同時 boot 都只打一次）。 */
let inflight: Promise<boolean> | null = null;

/**
 * 需要時續期 POS 終端憑證。
 *
 * - 冇 authSession / 冇 ledgerAccessToken → 直接回 false（匿名，唔會阻擋落單）。
 * - token 仍然有效（> 10 分鐘）→ 回 true，唔打網絡。
 * - 否則打 `/api/pos/device-token`，成功就寫返 authSession 並回 true。
 *
 * 呢個函式**永遠唔會 throw**：續期失敗唔應該令畫面爆，頂多係跟住嘅 POS 讀取 401。
 */
export async function refreshPosDeviceTokenIfNeeded(force = false): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const session = loadAuthSession();
  if (!session?.ledgerAccessToken) return false;

  const current = getPosDeviceToken();
  if (!force && current) {
    const exp = readTokenExp(current);
    if (exp !== null && exp - Date.now() > REFRESH_MARGIN_MS) return true;
  }

  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch("/api/pos/device-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken: session.ledgerAccessToken,
          refreshToken: session.ledgerRefreshToken,
        }),
      });
      const payload = (await res.json().catch(() => null)) as { ok?: boolean; token?: string } | null;
      if (!res.ok || !payload?.ok || !payload.token) return false;

      const latest = loadAuthSession() ?? session;
      // ⚠️ 一定要經 saveAuthSession（會保留其他欄位）；直接寫 localStorage 會漏 normalise。
      const next: AuthSession = { ...latest, posDeviceToken: payload.token };
      saveAuthSession(next);
      return true;
    } catch {
      return false;
    } finally {
      // 下一個 tick 先清（等同一輪嘅 caller 共用同一個 promise）
      setTimeout(() => {
        inflight = null;
      }, 0);
    }
  })();

  return inflight;
}
