/**
 * 《商戶端活躍上報》執行端（2026-09-24）—— Ledger 契約 §4.6。
 *
 * ## 三條鐵律
 *
 * ### 1) 🔴 永遠唔可以 throw、永遠唔可以阻擋業務
 *
 * 呼叫點分別係 **`/api/ledger/login`**（店員登入成功）同 **`ensureLedgerSession()`**
 * （分頁重開恢復 session）。前者係**店員返工嘅唯一入口** ——
 * 「Ledger Admin 睇唔到活躍」絕對唔可以變成「全店登入唔到 POS」。
 * ⇒ 所有錯誤 `try/catch` 到底，一律回 `false`；`console.warn` 就夠
 *   （同 Ledger Web／商米 App 一致，同 `session-registry-server.ts` 同一鐵律）。
 *
 * ### 2) 🔴 一定要用店員 JWT 嘅 Ledger client
 *
 * 呢度只要求一個「有 `rpc()` 嘅 client」＝**Ledger 專案 + 店員 session**。
 * · 唔可以用 POS 自有 Supabase client 打（唔同專案，RPC 根本唔存在）；
 * · 唔可以用顧客 JWT 打（契約禁止項，會 `not authorized` 或誤報）。
 *
 * ### 3) 🔴 超時要兜住
 *
 * `await` 係必要嘅：Vercel serverless 回應之後會凍結，唔 await 嘅 promise
 * 隨時永遠唔完成（＝永遠冇上報，而且係靜默咁冇）。但 Ledger 側打嗝時，
 * await 一個無上限嘅請求＝**登入一齊死**。所以用 `Promise.race` 封頂。
 *
 * ## 節流
 *
 * Ledger DB 端同一 `(merchant_id, 'pos')` **6 小時內**重複呼叫通常唔更新
 * `last_login_at`（但版本字串一變就更新）⇒ POS **唔需要**自做 6 小時 timer。
 * 我哋自己只做「每個分頁載入最多一次」（見 `session.ts`），避免為每個
 * 訂單／會員查詢多打一支 RPC。
 */

import {
  CLIENT_PRESENCE_RPC,
  buildClientPresenceParams,
  type ClientPresenceParams,
} from "./client-presence-params.ts";

/** 呼叫端：Supabase client 嘅 `rpc()` 回傳係 thenable（唔一定係真 Promise）⇒ 只用最小介面。 */
export type ClientPresenceRpcClient = {
  rpc: (
    fn: string,
    args: ClientPresenceParams,
  ) => PromiseLike<{ error?: { code?: string; message?: string } | null } | null | undefined>;
};

/** 上報超時上限。Ledger 打嗝最多拖慢登入呢個時間，唔會拖死。 */
export const CLIENT_PRESENCE_TIMEOUT_MS = 3_000;

/** 「Ledger 未跑 migration」每個 process 只嘈一次，唔洗版。 */
let warnedMissingRpc = false;

/** 只供測試。 */
export function resetClientPresenceWarningForTest(): void {
  warnedMissingRpc = false;
}

/**
 * RPC 唔存在（Ledger 未跑 `20260924120000_merchant_client_presence.sql`）。
 *
 * `PGRST202` ＝ PostgREST 搵唔到函式；`42883` ＝ Postgres `undefined_function`。
 * 兩者都係**對方側未部署**，唔係我哋嘅 bug ⇒ 只提醒一次，行為照舊（靜默停用）。
 */
function isMissingRpc(error: { code?: string; message?: string }): boolean {
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return /could not find the function|function .* does not exist|undefined_function/i.test(
    error.message ?? "",
  );
}

function noteFailure(source: string, error: { code?: string; message?: string }): void {
  const detail = error.message ?? "unknown";
  if (isMissingRpc(error)) {
    if (!warnedMissingRpc) {
      warnedMissingRpc = true;
      console.warn(
        "[ledger/presence] Ledger 未部署 record_merchant_client_login（migration 20260924120000 未跑）" +
          "⇒ 商戶端活躍上報停用，POS 業務不受影響。請 Ledger 方 db:push。",
      );
    }
    return;
  }
  console.warn(`[ledger/presence] ${source} 上報失敗（已忽略）：${detail}`);
}

function describeThrown(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "unknown";
}

type PresenceOutcome = {
  /** `true` ＝ 等唔到回應（已放過，唔影響業務）。 */
  timedOut: boolean;
  error: { code?: string; message?: string } | null;
};

export type ReportPosClientPresenceInput = {
  /** **Ledger** client（已 `setSession()` 成店員 session）。`null` ⇒ 唔報。 */
  client: ClientPresenceRpcClient | null | undefined;
  /** `merchant_staff.merchant_id`（UUID）。 */
  merchantId: unknown;
  /** 版本字串（建議 = 客戶端 build id，即呢個分頁實際跑緊邊份 JS）。可疑／缺值 ⇒ 唔報版本。 */
  appVersion?: unknown;
  /** 只作 log 分辨呼叫來源。 */
  source: "login" | "restore";
  /** 只供測試注入。 */
  timeoutMs?: number;
};

/**
 * 上報一次「POS 端活躍」。**永不 throw**。
 *
 * @returns 成功 ＝ `true`；被跳過／失敗／超時 ＝ `false`。
 *
 * 呼叫端**唔應該**因為 `false` 做任何事（唔可以彈提示、唔可以阻 UI、唔可以重試）。
 */
export async function reportPosClientPresence(
  input: ReportPosClientPresenceInput,
): Promise<boolean> {
  const params = buildClientPresenceParams(input.merchantId, input.appVersion);
  if (!params) return false;

  const client = input.client;
  if (!client || typeof client.rpc !== "function") return false;

  const timeoutMs =
    typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? input.timeoutMs
      : CLIENT_PRESENCE_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 🔴 `Promise.resolve()` 包住 thenable（supabase-js 嘅 builder 係 thenable 唔係 Promise）；
    //    兩個 then 參數都收 ⇒ 之後就算 reject 都唔會變成 unhandled rejection。
    const call: Promise<PresenceOutcome> = Promise.resolve(
      client.rpc(CLIENT_PRESENCE_RPC, params),
    ).then(
      (result) => ({ timedOut: false, error: result?.error ?? null }),
      (error: unknown) => ({ timedOut: false, error: { message: describeThrown(error) } }),
    );

    const timeout = new Promise<PresenceOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true, error: null }), timeoutMs);
    });

    const outcome = await Promise.race([call, timeout]);
    if (outcome.timedOut) {
      noteFailure(input.source, { message: `超時 ${timeoutMs}ms` });
      return false;
    }
    if (outcome.error) {
      noteFailure(input.source, outcome.error);
      return false;
    }
    return true;
  } catch (error: unknown) {
    // 理論上到唔到（上面已經兜齊），但呢條鐵律唔可以有例外。
    noteFailure(input.source, { message: describeThrown(error) });
    return false;
  } finally {
    // 🔴 一定要清 timer：唔清就會吊住 Node 事件迴圈（測試會卡 3 秒，server 亦多餘）。
    if (timer) clearTimeout(timer);
  }
}
