import { findWorkbench, type WorkbenchId } from "@/lib/pos/module-catalog";

/**
 * 「呢部機嘅工作台偏好」（localStorage）。
 *
 * 呢個檔處理兩件獨立嘅事，唔好撈埋：
 *
 * 1. **上次用過邊個工作台**（`last*`）—— 純粹為咗喺「選擇工作台」頁
 *    標一個「上次使用」徽章，等店員一眼搵返自己部機嘅崗位。
 *    **即使冇開「記住」，都會記錄。**
 * 2. **要唔要自動進入**（`remember`）—— 開咗 + 有上次記錄 + 個工作台仍然開通
 *    → 登入完直接入去，唔使再揀。收銀機／後廚屏呢類固定崗位唔想每次開機都撳。
 *
 * ⚠️ 用 **per-store key**（`pos.lastWorkbench.<merchantId>`）而唔係單一 key：
 * 同一部平板可能今日做 A 店、聽日做 B 店（換登入帳號），
 * 單一 key 會令 B 店一開機就自動跳去 A 店嘅崗位。
 *
 * ⚠️ 呢個檔嘅所有寫入都要 try/catch —— 無痕模式 / 私隱設定會令 localStorage throw，
 * 唔可以因為「記唔到偏好」就令佢入唔到 POS。
 */

const REMEMBER_KEY = "pos.rememberWorkbench";
const LAST_KEY_PREFIX = "pos.lastWorkbench.";

function readRaw(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore：記唔到偏好唔應該影響登入
  }
}

function removeRaw(key: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function lastKey(storeId: string): string {
  return `${LAST_KEY_PREFIX}${storeId}`;
}

/** 「記住呢部機嘅選擇」開關。預設 **開**（收銀機係固定崗位，每次都問好煩）。 */
export function loadRememberWorkbenchEnabled(): boolean {
  // 冇寫過 = 預設開。只有明確寫過 "0" 才當關。
  return readRaw(REMEMBER_KEY) !== "0";
}

export function saveRememberWorkbenchEnabled(enabled: boolean) {
  writeRaw(REMEMBER_KEY, enabled ? "1" : "0");
}

/** 上次喺呢間店用過嘅工作台（唔理「記住」開關）。 */
export function loadLastWorkbench(storeId: string | undefined): WorkbenchId | null {
  if (!storeId) return null;
  const raw = readRaw(lastKey(storeId));
  if (!raw) return null;
  return findWorkbench(raw)?.id ?? null;
}

export function saveLastWorkbench(storeId: string | undefined, workbench: WorkbenchId) {
  if (!storeId) return;
  writeRaw(lastKey(storeId), workbench);
}

export function clearLastWorkbench(storeId: string | undefined) {
  if (!storeId) return;
  removeRaw(lastKey(storeId));
}

/**
 * 登入之後應唔應該**直接**入某個工作台（跳過選擇頁）？
 *
 * 三個條件全部要成立：
 * 1. 開咗「記住」；
 * 2. 有上次記錄；
 * 3. 嗰個工作台**而家仍然開通**。
 *
 * 第 3 點係關鍵 —— Admin 收窄咗授權之後，如果照樣自動進入已被閂嘅工作台，
 * 部機就會卡喺一個唔應該入到嘅畫面。呢種情況下要返去選擇頁（順便會顯示「未開通」）。
 */
export function resolveRememberedWorkbench(
  storeId: string | undefined,
  grantedWorkbenches: readonly WorkbenchId[],
): WorkbenchId | null {
  if (!loadRememberWorkbenchEnabled()) return null;
  const last = loadLastWorkbench(storeId);
  if (!last) return null;
  if (!grantedWorkbenches.includes(last)) return null;
  return last;
}
