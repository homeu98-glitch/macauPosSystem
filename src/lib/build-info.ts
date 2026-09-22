/**
 * 《建置版本資訊》（2026-09-22）—— 設置頁「版本號」嘅唯一真源。
 *
 * ── 呢個版本號代表咩（最重要）──────────────────────────────────────────
 * 佢係**內聯入 JS bundle** 嘅建置識別碼（見 `next.config.ts`）⇒
 * **代表「而家跑緊嘅嗰份 JS 係邊次建置」**。
 *
 * 🔴 **唔可以**改成由 server 提供（例如 `/api/version`）：
 * 一個跑住舊 JS 嘅分頁一樣會顯示「最新版本」⇒ 完全失去「確認商家實際用邊個版本」嘅作用。
 *
 * ── 兩個識別碼嘅分工 ────────────────────────────────────────────────────
 * | 名稱 | 來源 | 意義 |
 * |---|---|---|
 * | **客戶端版本** | 內聯（`next.config` `env`）| **呢部機而家跑緊嘅 JS** ← 設置頁顯示嘅主角 |
 * | **伺服器版本** | `/api/pos/state` 回應標頭 `x-pos-build` | **線上最新部署** |
 * 兩者唔同 ＝ 呢個分頁過期（＝伺服器 log 嗰個 `legacy=1` 嘅客戶端對應）。
 *
 * ── 本模組刻意零 import ──────────────────────────────────────────────────
 * 專案 `npm test` ＝ `node --test`（唔行 bundler、唔認 `@/` 別名）⇒ 可測模組唔准 import。
 */

export type BuildInfo = {
  /** 短版本號（commit sha 7 位 / deployment id / `dev`）；空字串 ＝ 未注入。 */
  id: string;
  /** 建置時間（ISO 8601，UTC）；`null` ＝ 未注入。 */
  builtAt: string | null;
  /** `production` / `preview` / `development`；空字串 ＝ 未注入。 */
  env: string;
};

/**
 * 讀取**內聯**嘅建置資訊（client 端用）。
 *
 * 🔴 **一定要逐個字面寫 `process.env.NEXT_PUBLIC_XXX`** ——
 * Next 用 DefinePlugin 做**字面文字替換**，`const { X } = process.env` 或者
 * `process.env[name]` **都唔會被替換**（會變 `undefined`）。
 */
export function readClientBuildInfo(): BuildInfo {
  // `typeof process` 唔會被 DefinePlugin 替換 ⇒ 呢個係真實 runtime 防護
  // （理論上 Next 一定會 shim `process.env`，但唔想因為版本差異而爆 ReferenceError）。
  if (typeof process === "undefined" || !process.env) {
    return { id: "", builtAt: null, env: "" };
  }
  const id = process.env.NEXT_PUBLIC_BUILD_ID;
  const builtAt = process.env.NEXT_PUBLIC_BUILD_TIME;
  const env = process.env.NEXT_PUBLIC_BUILD_ENV;
  return {
    id: typeof id === "string" ? id : "",
    builtAt: typeof builtAt === "string" && builtAt ? builtAt : null,
    env: typeof env === "string" ? env : "",
  };
}

/**
 * **伺服器端**嘅建置識別碼（⚠️ 只可以喺 server 呼叫）。
 *
 * 用喺 `/api/pos/state` 嘅 `x-pos-build` 回應標頭 —— 令設置頁可以對照
 * 「呢部機跑緊嘅版本」同「線上最新部署」。
 *
 * 🔴 喺 **client** 呼叫會永遠回 `"dev"` —— 因為 `VERCEL_*` 唔會內聯入 JS bundle
 * （只有 `next.config` `env` 嗰三個 `NEXT_PUBLIC_BUILD_*` 才會）。
 *
 * fallback 次序同 `next.config.ts` 一致（同一口徑，改一處要改兩處）。
 */
export function readServerBuildId(): string {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (typeof sha === "string" && sha) return sha.slice(0, 7);
  const deployment = process.env.VERCEL_DEPLOYMENT_ID;
  if (typeof deployment === "string" && deployment) return deployment.slice(0, 12);
  return "dev";
}

/** ISO 時間 → 澳門（UTC+8）可讀字串 `YYYY-MM-DD HH:mm`；非法／缺值 → `""`。 */export function formatMacauStamp(iso: string | null): string {
  const ms = Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return "";
  // 唔用 toLocaleString：想要**確定性**輸出（測試唔可以受執行環境時區影響）。
  const d = new Date(ms + 8 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  );
}

/** 環境標籤（講人話，唔露出枚舉值）。 */
export function envLabel(env: string): string {
  if (env === "production") return "正式";
  if (env === "preview") return "預覽";
  if (env === "development") return "本機";
  return env;
}

/**
 * 設置頁顯示用嘅一行字。
 * @returns 例：`1a2b3c4（2026-09-21 23:54 · 正式）`；未注入 → `未知（未注入）`
 */
export function buildLabel(info: BuildInfo): string {
  const stamp = formatMacauStamp(info.builtAt);
  const details: string[] = [];
  if (stamp) details.push(stamp);
  if (info.env) details.push(envLabel(info.env));
  if (!info.id) return details.length ? `未知（${details.join(" · ")}）` : "未知（未注入）";
  return details.length ? `${info.id}（${details.join(" · ")}）` : info.id;
}

/** 兩個版本係唔係同一次建置。任一未知 → `false`（唔可以當「一致」）。 */
export function isSameBuild(clientId: string, serverId: string | null): boolean {
  if (!clientId || !serverId) return false;
  return clientId === serverId;
}

export type BuildMismatchHint = { text: string };
/**
 * 「呢個分頁已經過期」提示（**只提示，唔會自動 reload**）。
 *
 * @returns 冇需要提示 → `null`。
 *
 * ## 兩個刻意嘅保守決定
 * 1. **任一未知 → 唔提示**：本機開發（`dev`）或者標頭讀唔到時，唔應該嘈。
 * 2. **唔自動 reload**：收銀落單／結帳中途 reload 會出事（本專案明確禁用）。
 *    提示 + 叫用戶自己閂掉重開，係唯一安全做法。
 */
export function describeBuildMismatch(
  client: BuildInfo,
  serverId: string | null,
): BuildMismatchHint | null {
  if (!client.id || !serverId) return null;
  if (client.id === "dev" || serverId === "dev") return null;
  if (client.id === serverId) return null;
  return {
    text: "此裝置仍運行舊版本（伺服器已更新），請完全閂掉此視窗再重新打開。",
  };
}

export type ReloadRiskInput = {
  /** 目前購物車（未落單）嘅菜品數。 */
  cartItemCount: number;
  /** 結帳／付款畫面係唔係開住。 */
  settlementOpen: boolean;
  /** 本機仲有幾多筆未上雲嘅事件（**reload 唔會令佢哋消失**，只作提示）。 */
  pendingSyncCount: number;
};

export type ReloadRisk = { needsConfirm: boolean; message: string };

/**
 * 一鍵「重新載入」之前要唔要確認（2026-09-22）。
 *
 * ## 為何要分兩種情況
 *
 * reload 之後：`orders` / `queue` / `printJobs` / `shift` / `bootstrap` 全部喺
 * **localStorage** ⇒ 全部保留 ✓；但**喺記憶體嘅購物車（`cartItems`）同開住嘅結帳畫面
 * 會即刻消失**（收銀要重新入過所有菜）。
 *
 * ⇒ 冇未完成工作 → 直接 reload（一按即好，唔想俾商家多一步）；
 *   有未完成工作 → **一定要確認**，而且要講清楚**邊樣會冇**、
 *   同埋**邊樣唔會冇**（未上雲嘅單安全）—— 只講「會失去資料」會令人卻步或者盲撳。
 *
 * ⚠️ 語氣紀律：講「會清空購物車」，唔可以講「會失去資料」（後者係錯，會嚇到人）。
 */
export function describeReloadRisk(input: ReloadRiskInput): ReloadRisk {
  const losses: string[] = [];
  if (input.cartItemCount > 0) losses.push(`目前未落單嘅 ${input.cartItemCount} 項菜品`);
  if (input.settlementOpen) losses.push("開住嘅結帳畫面");

  if (losses.length === 0) {
    const safe =
      input.pendingSyncCount > 0
        ? `（本機 ${input.pendingSyncCount} 筆未上雲嘅紀錄會保留）`
        : "";
    return { needsConfirm: false, message: `會重新載入頁面${safe}。` };
  }

  const kept =
    input.pendingSyncCount > 0
      ? `已落單／未上雲嘅 ${input.pendingSyncCount} 筆紀錄會保留。`
      : "已落單嘅訂單會保留。";
  return {
    needsConfirm: true,
    message: `重新載入會清空${losses.join("同")}。${kept}`,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 觀測到嘅「伺服器版本」（由 `/api/pos/state` 回應標頭 `x-pos-build` 寫入）
 *
 * 為何要 module store：pos-app 收到標頭嗰刻同設置頁 render 唔同時機，
 * 而且設置頁要即刻反映到。呢個 store 唔做任何請求，純記憶。
 * ──────────────────────────────────────────────────────────────────────────── */

let observedServerBuildId: string | null = null;
const observedListeners = new Set<() => void>();

export function setObservedServerBuildId(id: string | null): void {
  const next = typeof id === "string" && id.trim() ? id.trim() : null;
  if (next === observedServerBuildId) return;
  observedServerBuildId = next;
  for (const listener of observedListeners) listener();
}

export function getObservedServerBuildId(): string | null {
  return observedServerBuildId;
}

export function subscribeObservedServerBuild(listener: () => void): () => void {
  observedListeners.add(listener);
  return () => {
    observedListeners.delete(listener);
  };
}

/** 只供測試。 */
export function resetObservedServerBuildForTest(): void {
  observedServerBuildId = null;
  observedListeners.clear();
}
