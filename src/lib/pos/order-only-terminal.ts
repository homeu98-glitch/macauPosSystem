/**
 * 「落單專用終端」旗標（localStorage，per-store）—— 2026-09-16。
 *
 * ## 呢個係咩
 *
 * 一部手機揀咗「店員手機」工作台之後，就當佢係**落單專用終端**：
 * 只應該喺 `/staff` 落單，唔應該去收銀台結帳、退菜、免單。
 *
 * ## 🔴🔴 一定要講清楚：呢個**唔係**安全邊界
 *
 * 呢個旗標住喺 localStorage，而且**只係前端路由層嘅攔截**。
 * 任何識技術嘅人（或者直接打 API）都可以完全繞過：
 *
 * ```
 * localStorage.removeItem("pos.orderOnlyTerminal.<storeId>")   // 一秒解除
 * curl -X POST /api/pos/sync  -d '{"events":[{"type":"ORDER_SETTLED",...}]}'  // 直接結帳
 * ```
 *
 * 佢真正解決嘅問題係**誤操作**：店員撳錯書籤／撳返上一頁，
 * 結果喺手機上面結咗一張唔應該由佢結嘅單。呢種係**便利性**，唔係**權限**。
 *
 * ## 真權限要點做（未做，見 docs/staff-mobile-ordering-plan-2026-09-16.md）
 *
 * ① POS 端要有「邊個帳號係 waiter」嘅真源（Ledger 只有 `owner` / `staff`，
 *    冇 waiter 概念 ⇒ 一定要新表）；
 * ② 登入時把該角色簽入 POS 終端憑證；
 * ③ `/api/pos/sync` 對 `ORDER_SETTLED` / 退菜類事件檢查憑證角色。
 *
 * ⚠️ 而 ③ **前提係`POS_REQUIRE_DEVICE_AUTH` 要開返**（`1` 或未設）。
 *    設成 `0` 時 `resolvePosRouteAuth()` 第一條分支直接放行、**根本唔會讀憑證**
 *    ⇒ 就算做完上面三步，角色檢查一樣形同虛設。
 *
 * ## 為何唔用 `loadLastWorkbench()` 代替
 *
 * `lastWorkbench` 係「上次用過邊個」，每次揀工作台都會變；
 * 而且佢係俾「選擇工作台」頁顯示「上次使用」徽章用嘅。
 * 攞嚟當「呢部機係落單專用」會出現「上次揀過收銀台，旗標就自己熄咗」。
 * 所以另外開一個**專用旗標**，語意唔同就唔好撈埋。
 */

const ORDER_ONLY_KEY_PREFIX = "pos.orderOnlyTerminal.";

/**
 * 落單專用終端**唯一可以去**嘅路徑。
 *
 * - `/staff` —— 落單介面本身。
 * - `/login` —— 憑證過期要重新登入；攔住佢 = 部機永遠入唔返。
 * - `/select-workbench` —— **逃生門**：一定要留，否則揀錯工作台部機就廢咗。
 *
 * ⚠️ 2026-09-17：`/` 已經成為**統一入口**（工作台選擇頁），但**刻意唔加入白名單**。
 *
 * 原因：唔加 ⇒ 落單專用終端去 `/` 會被導向 `/staff`，
 * 店員就唔會誤入選擇頁再揀「堂食收銀台」去結帳。
 *
 * 副作用（要知）：`/select-workbench` 同樣 render 選擇頁，所以逃生門本身
 * 就係一條繞過路徑。呢個係**刻意保留**嘅 —— 冇逃生門，揀錯工作台部機就廢咗。
 * 反正呢個旗標本來就唔係安全邊界（見檔頭），擋誤操作已經達到目的。
 */
export const ORDER_ONLY_ALLOWED_PATHS: readonly string[] = [
  "/staff",
  "/login",
  "/select-workbench",
];

function key(storeId: string): string {
  return `${ORDER_ONLY_KEY_PREFIX}${storeId}`;
}

function readRaw(k: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(k);
  } catch {
    // 無痕模式 / 私隱設定會 throw —— 讀唔到就當「唔係落單專用」（fail-open）。
    // ⚠️ 呢度刻意 fail-open：寧願少攔一次，都唔好因為讀唔到 localStorage
    //    就把部正常收銀機鎖死喺 /staff。
    return null;
  }
}

function writeRaw(k: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(k, value);
  } catch {
    // ignore
  }
}

function removeRaw(k: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(k);
  } catch {
    // ignore
  }
}

/** 呢部機（呢間店）係咪設咗做落單專用？ */
export function isOrderOnlyTerminal(storeId: string | undefined): boolean {
  if (!storeId) return false;
  return readRaw(key(storeId)) === "1";
}

export function setOrderOnlyTerminal(storeId: string | undefined, enabled: boolean) {
  if (!storeId) return;
  if (enabled) writeRaw(key(storeId), "1");
  else removeRaw(key(storeId));
}

/**
 * 落單專用終端可唔可以去呢條路徑？
 *
 * 純函式（唔碰 localStorage）→ 可以被 `node --test` 直接覆蓋。
 *
 * 規則：
 * - 白名單路徑（`/staff` `/login` `/select-workbench`）→ 可以。
 * - 帶 query / 子路徑（`/staff?x=1`、`/staff/foo`）→ 按**路徑前綴**判斷，可以。
 * - 其餘（`/`、`/orders`、`/reports`…）→ 唔可以。
 *
 * ⚠️ 一定要用**段邊界**比對（`/staff` 唔可以匹配 `/staffing`）。
 */
export function isPathAllowedOnOrderOnlyTerminal(pathname: string): boolean {
  const path = (pathname || "/").split("?")[0].split("#")[0];
  return ORDER_ONLY_ALLOWED_PATHS.some(
    (allowed) => path === allowed || path.startsWith(`${allowed}/`),
  );
}

/** 落單專用終端被攔截時應該去邊。 */
export const ORDER_ONLY_FALLBACK_PATH = "/staff";
