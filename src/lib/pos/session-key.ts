/**
 * 《POS 工作階段識別碼》（2026-09-22）—— client 側，每個**分頁**一個。
 *
 * ## 🔴 為何一定要 `sessionStorage`（呢個係整個功能嘅命門）
 *
 * 本功能要解決嘅問題係「**商家唔為意開咗幾個分頁**」。
 * 如果用 `localStorage`：
 *   · 同一部機所有分頁讀到**同一個** key；
 *   · 兩個分頁會 upsert 成**同一行** ⇒ admin 頁永遠顯示「1 個工作階段」；
 *   · ⇒ 功能**靜默失效**（唔會報錯，只係永遠測唔到多開）。
 *
 * `sessionStorage` 嘅生命週期天生就係「一個分頁」：開新分頁 = 新 key、
 * 同一分頁 reload = 保留（啱好，reload 唔應該當新工作階段）。
 *
 * ## 為何零 import
 *
 * `npm test` ＝ `node --test`（唔行 bundler、唔認 `@/` 別名）⇒ 可測模組唔准 import。
 * 呢個模組連 `@/lib/storage` 都唔用 —— 佢係「跨模組共用嘅識別碼」，
 * 唔應該綁死喺某個儲存層。
 *
 * ## 讀唔到 `sessionStorage` 都要照跑
 *
 * Safari 私密模式、`file://`、或者被擴充封鎖時 `sessionStorage` 存取會 **throw**。
 * ⇒ 一律 try/catch，失敗就退回**模組記憶**（唔會影響落單，最多係該分頁
 * 重開之後換一個新 key —— 對「多開偵測」無害）。
 */

/** `sessionStorage` 嘅鍵名（帶前綴避免撞其他 app）。 */
export const POS_SESSION_KEY_STORAGE = "macau-pos-session-key";

/** key 長度上限（同 server 端 `SESSION_KEY_MAX_LEN` 一致）。 */
const KEY_MAX_LEN = 64;

/** 記憶 fallback（讀唔到 sessionStorage 時用）。 */
let memoryKey: string | null = null;

/** 產生一個 URL-safe 嘅識別碼（`crypto.randomUUID` 唔存在時退回時間 + 隨機）。 */
export function generatePosSessionKey(): string {
  try {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === "function") {
      // 標準 uuid v4（36 字元，含 `-`，符合 server 端 `[A-Za-z0-9_-]` 白名單）。
      return c.randomUUID();
    }
    if (c && typeof c.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      c.getRandomValues(bytes);
      let out = "";
      for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
      return out;
    }
  } catch {
    /* 落 fallback */
  }
  // 最後手段：時間 + 兩段隨機。**唔係**密碼學安全 —— 但呢個 key 唔係憑證，
  // 只係「分辨邊個分頁」嘅標籤（授權仍然靠 posDeviceToken）。
  const rand = () => Math.floor(Math.random() * 1e9).toString(36);
  return `${Date.now().toString(36)}-${rand()}-${rand()}`;
}

/** 讀 `sessionStorage`（失敗回 `null`，唔 throw）。 */
function readStored(): string | null {
  try {
    if (typeof window === "undefined" || !window.sessionStorage) return null;
    const value = window.sessionStorage.getItem(POS_SESSION_KEY_STORAGE);
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > KEY_MAX_LEN) return null;
    return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

/** 寫 `sessionStorage`（失敗靜默 —— 只影響「重開後仲認得同一個分頁」）。 */
function writeStored(key: string): void {
  try {
    if (typeof window === "undefined" || !window.sessionStorage) return;
    window.sessionStorage.setItem(POS_SESSION_KEY_STORAGE, key);
  } catch {
    /* 靜默 */
  }
}

/**
 * 拎當前分頁嘅工作階段識別碼（冇就即刻產生一個並記住）。
 *
 * ⚠️ 同一個分頁**一定要**回同一個值：server 靠佢做 row 嘅 primary key，
 * 中途換 key ＝ 同一部機變兩個工作階段（會出現假「多開」）。
 */
export function getPosSessionKey(): string {
  const stored = readStored();
  if (stored) {
    memoryKey = stored;
    return stored;
  }
  if (memoryKey) return memoryKey;
  const fresh = generatePosSessionKey();
  memoryKey = fresh;
  writeStored(fresh);
  return fresh;
}

/**
 * 換一個新識別碼 —— **只喺登入成功之後呼叫**。
 *
 * ## 為何要換（唔可以沿用）
 *
 * 管理員強制關閉之後，商家要**重新登入**。如果沿用同一個 key：
 * 新登入會續期**嗰行已經被撤銷**嘅紀錄 ⇒ admin 頁會顯示「已強制關閉」
 * 但商家明明用緊（或者反過來，橫幅一登入就又彈出）。
 * ⇒ 「重新登入」＝ 新工作階段，舊 row 留低做歷史。
 *
 * @returns 新識別碼
 */
export function rotatePosSessionKey(): string {
  const fresh = generatePosSessionKey();
  memoryKey = fresh;
  writeStored(fresh);
  return fresh;
}

/** 只供測試：清掉模組記憶同 `sessionStorage`。 */
export function resetPosSessionKeyForTest(): void {
  memoryKey = null;
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      window.sessionStorage.removeItem(POS_SESSION_KEY_STORAGE);
    }
  } catch {
    /* 靜默 */
  }
}
