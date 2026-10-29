/**
 * 離線登入憑證（P4，2026-10-29）。
 *
 * ## 解決咩問題
 *
 * `AuthGuard` 冷啟一律踢去 `/login`（docs/162，防上一手店主權限被店員接手），
 * 而 `/login` 兩條路（店主 `POST /api/ledger/login`、店員
 * `POST /api/pos/login/identity`）**都要打 server**。
 * ⇒ 斷網 = 全店開唔到工。
 *
 * ## 🔴 存嘅係「本機驗證器」，唔係 server 嘅 `pinHash` / `pinSalt`
 *
 * server 側（`staff-pin.ts`）嘅 PBKDF2 hash 係**跨機通用**嘅機密：
 * 一旦離線快取落部機，任何拎到部機嘅人都可以用同一份 hash 去爆破，
 * 而且爆中之後**所有機、所有店**都認得。
 *
 * 呢度改為每次登入成功時，用**本機隨機 salt** 重新派生一次：
 *
 *     verifier = PBKDF2-SHA256(pin, 本機 salt, 120k)
 *
 * 後果分別：
 * - dump 走呢部機 ⇒ 只得到「呢部機、呢個員工」嘅 4 位 PIN（10⁴ 組合），
 *   PBKDF2 120k 之下離線爆破仍然要付代價；
 * - 同一張單據／同一份備份拎去第二部機 ⇒ **完全冇用**。
 *
 * 再加本機鎖定（錯 5 次 → 5 分鐘）壓住「坐喺機前面慢慢試」。
 *
 * ## 為何仍然要求打 PIN
 *
 * 唔可以「見到有快取就自動入」。咁樣等於回到 docs/162 之前：
 * 店主關機走開，店員一開機就有店主權限。冷啟一定要重新認人，
 * 只係認人嘅方法由「問 server」改成「問本機驗證器」。
 *
 * ⚠️ 呢個檔案**唔可以** import `node:crypto` 或任何 server-only 模組：
 *    佢會被打包入 client bundle。
 */

import type { AuthSession } from "@/lib/storage";

/** localStorage key（單一 key：一部機同一時間只服務一間店）。 */
export const OFFLINE_CREDENTIAL_KEY = "macau-pos/offline-credential";

export const OFFLINE_CREDENTIAL_VERSION = 1;

/**
 * 憑證有效期（J 2026-10-29 定：7 日）。
 *
 * 過期之後一定要聯網登入一次。理由：收銀機通常日日開，
 * 7 日唔聯網本身已經係異常；而跌落／被盜嘅機最多只可以用 7 日。
 */
export const OFFLINE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 連續錯幾次 PIN 就鎖。 */
export const OFFLINE_MAX_FAILS = 5;

/** 鎖幾耐。 */
export const OFFLINE_LOCK_MS = 5 * 60 * 1000;

/** 演算法標籤。同 server 側 `POS_STAFF_PIN_ALGO` 同名但**唔可以互換**（salt 唔同來源）。 */
export const OFFLINE_PIN_ALGO = "pbkdf2-sha256-120000";

const ITERATIONS = 120_000;
const KEY_BITS = 256;
const SALT_BYTES = 16;
const HASH_HEX_LEN = KEY_BITS / 4;

export type OfflinePinVerifier = {
  algo: typeof OFFLINE_PIN_ALGO;
  /** hex，16 bytes */
  salt: string;
  /** hex，32 bytes */
  hash: string;
};

export type OfflineIdentity = {
  kind: "owner" | "staff";
  /** `owner` 或店員 id（同 `/api/pos/login/identities` 回嘅 `id` 一致） */
  id: string;
  name: string;
  staffNo?: string;
  role: "owner" | "manager" | "cashier";
  verifier: OfflinePinVerifier;
  /**
   * **呢個身份**最後一次成功登入嘅 session（唔係全店共用一份）。
   *
   * 🔴 一定要逐個身份分開存：如果全店只得一份 session，
   *    店主登入完之後店員離線登入，就會靜靜雞得到**店主權限**。
   */
  session: AuthSession;
};

export type OfflineCredential = {
  version: number;
  merchantId: string;
  /** 8 位店舖帳號（店主嘅；店員模式唔需要打，但留低做核對） */
  account: string;
  storeName?: string;
  /** 最後一次寫入時間（epoch ms）—— TTL 由呢度計 */
  savedAt: number;
  identities: OfflineIdentity[];
  /** 連續錯 PIN 次數 */
  fails: number;
  /** 鎖到幾時（epoch ms）。0 = 冇鎖。 */
  lockedUntil: number;
};

/** 派生／驗證用嘅 WebCrypto。冇（非安全來源）就回 null —— 寧願唔提供離線登入。 */
function subtleCrypto(): SubtleCrypto | null {
  try {
    const c = globalThis.crypto;
    if (!c?.subtle) return null;
    return c.subtle;
  } catch {
    return null;
  }
}

/** 離線登入喺呢個環境根本做唔到（舊 WebView／http 來源）。 */
export function offlineLoginSupported(): boolean {
  return subtleCrypto() !== null;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) return null;
  // 明確用 ArrayBuffer-backed view：WebCrypto 嘅 BufferSource 唔收 SharedArrayBuffer
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function randomSaltHex(): string | null {
  try {
    const salt = new Uint8Array(SALT_BYTES);
    globalThis.crypto.getRandomValues(salt);
    return toHex(salt);
  } catch {
    return null;
  }
}

async function deriveHashHex(pin: string, saltHex: string): Promise<string | null> {
  const subtle = subtleCrypto();
  const salt = fromHex(saltHex);
  if (!subtle || !salt) return null;
  try {
    const key = await subtle.importKey(
      "raw",
      new TextEncoder().encode(pin),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
      key,
      KEY_BITS,
    );
    return toHex(new Uint8Array(bits));
  } catch {
    return null;
  }
}

/** 4 位數字 PIN 才接受 —— 同 server 側 `verifyPosStaffPin` 對齊。 */
function normalizePin(pin: string): string | null {
  const digits = String(pin ?? "").replace(/\D/g, "");
  return /^\d{4}$/.test(digits) ? digits : null;
}

/**
 * 產生本機驗證器。
 *
 * @param saltHex 唔傳 = 產生新 salt（登入成功、寫入憑證時用）。
 */
export async function deriveOfflineVerifier(
  pin: string,
  saltHex?: string,
): Promise<OfflinePinVerifier | null> {
  const normalized = normalizePin(pin);
  if (!normalized) return null;
  const salt = saltHex ?? randomSaltHex();
  if (!salt) return null;
  const hash = await deriveHashHex(normalized, salt);
  if (!hash) return null;
  return { algo: OFFLINE_PIN_ALGO, salt, hash };
}

/**
 * 驗證 PIN。任何可疑情況一律 **fail closed**（回 false）。
 *
 * 唔用 `===` 直接比較（V8 會提早結束）：逐 byte XOR 累加，
 * 令比較時間唔隨「中咗幾個字」變化。
 */
export async function verifyOfflinePin(
  pin: string,
  verifier: OfflinePinVerifier,
): Promise<boolean> {
  if (!verifier || verifier.algo !== OFFLINE_PIN_ALGO) return false;
  if (!/^[0-9a-f]+$/i.test(verifier.hash) || verifier.hash.length !== HASH_HEX_LEN) return false;
  const actual = await deriveOfflineVerifier(pin, verifier.salt);
  if (!actual) return false;
  if (actual.hash.length !== verifier.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.hash.length; i += 1) {
    diff |= actual.hash.charCodeAt(i) ^ verifier.hash.charCodeAt(i);
  }
  return diff === 0;
}

function isVerifier(value: unknown): value is OfflinePinVerifier {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<OfflinePinVerifier>;
  return (
    v.algo === OFFLINE_PIN_ALGO &&
    typeof v.salt === "string" &&
    typeof v.hash === "string" &&
    v.hash.length === HASH_HEX_LEN
  );
}

function normalizeIdentity(value: unknown): OfflineIdentity | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<OfflineIdentity>;
  if (v.kind !== "owner" && v.kind !== "staff") return null;
  if (typeof v.id !== "string" || !v.id) return null;
  if (typeof v.name !== "string" || !v.name) return null;
  if (!isVerifier(v.verifier)) return null;
  if (!v.session || typeof v.session !== "object") return null;
  const role = v.role === "manager" || v.role === "cashier" ? v.role : "owner";
  return {
    kind: v.kind,
    id: v.id,
    name: v.name,
    staffNo: typeof v.staffNo === "string" ? v.staffNo : undefined,
    role,
    verifier: v.verifier,
    session: v.session as AuthSession,
  };
}

function normalizeCredential(value: unknown): OfflineCredential | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<OfflineCredential>;
  if (v.version !== OFFLINE_CREDENTIAL_VERSION) return null;
  if (typeof v.merchantId !== "string" || !v.merchantId) return null;
  if (typeof v.savedAt !== "number" || !Number.isFinite(v.savedAt)) return null;
  const identities: OfflineIdentity[] = [];
  for (const raw of Array.isArray(v.identities) ? v.identities : []) {
    const identity = normalizeIdentity(raw);
    // 逐個剔走壞記錄，唔好一個壞就全份報廢（否則一個 corrupt entry = 全店冇得離線登入）
    if (identity) identities.push(identity);
  }
  if (identities.length === 0) return null;
  return {
    version: OFFLINE_CREDENTIAL_VERSION,
    merchantId: v.merchantId,
    account: typeof v.account === "string" ? v.account : "",
    storeName: typeof v.storeName === "string" ? v.storeName : undefined,
    savedAt: v.savedAt,
    identities,
    fails: typeof v.fails === "number" && v.fails >= 0 ? v.fails : 0,
    lockedUntil: typeof v.lockedUntil === "number" && v.lockedUntil > 0 ? v.lockedUntil : 0,
  };
}

function readRaw(): OfflineCredential | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(OFFLINE_CREDENTIAL_KEY);
    if (!raw) return null;
    return normalizeCredential(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function writeRaw(cred: OfflineCredential): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(OFFLINE_CREDENTIAL_KEY, JSON.stringify(cred));
  } catch {
    // quota／私隱模式：最多下次要聯網登入，唔可以令登入流程失敗
  }
}

export function loadOfflineCredential(): OfflineCredential | null {
  return readRaw();
}

export function clearOfflineCredential(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(OFFLINE_CREDENTIAL_KEY);
  } catch {
    // ignore
  }
}

export function isCredentialExpired(cred: OfflineCredential, now = Date.now()): boolean {
  return now - cred.savedAt > OFFLINE_TTL_MS;
}

/** 剩幾日（向上取整；已過期回 0）。橫幅文案用。 */
export function credentialDaysLeft(cred: OfflineCredential, now = Date.now()): number {
  const left = cred.savedAt + OFFLINE_TTL_MS - now;
  if (left <= 0) return 0;
  return Math.ceil(left / (24 * 60 * 60 * 1000));
}

/** 仲鎖幾耐（毫秒）。0 = 冇鎖。 */
export function lockRemainingMs(cred: OfflineCredential, now = Date.now()): number {
  if (!cred.lockedUntil) return 0;
  return Math.max(0, cred.lockedUntil - now);
}

/** 錯一次：累加；到上限就鎖。回傳更新後嘅憑證（已寫入）。 */
export function recordOfflineFailure(
  cred: OfflineCredential,
  now = Date.now(),
): OfflineCredential {
  const fails = cred.fails + 1;
  const next: OfflineCredential =
    fails >= OFFLINE_MAX_FAILS
      ? { ...cred, fails: 0, lockedUntil: now + OFFLINE_LOCK_MS }
      : { ...cred, fails };
  writeRaw(next);
  return next;
}

/** 成功一次：清走錯誤計數同鎖。 */
export function clearOfflineFailures(cred: OfflineCredential): OfflineCredential {
  if (cred.fails === 0 && cred.lockedUntil === 0) return cred;
  const next: OfflineCredential = { ...cred, fails: 0, lockedUntil: 0 };
  writeRaw(next);
  return next;
}

/**
 * 登入成功之後記住呢個身份。
 *
 * 規則：
 * - 換咗店（merchantId 唔同）⇒ **整份重來**，唔可以留住上一間店嘅身份；
 * - 同一個身份再登入 ⇒ 覆蓋佢嘅 verifier 同 session（PIN 可能改過）；
 * - 其他身份保留（店主登入唔會令店員嘅離線憑證消失）。
 */
export async function rememberOfflineIdentity(input: {
  merchantId: string;
  account: string;
  storeName?: string;
  identity: {
    kind: "owner" | "staff";
    id: string;
    name: string;
    staffNo?: string;
    role: "owner" | "manager" | "cashier";
  };
  pin: string;
  session: AuthSession;
  now?: number;
}): Promise<boolean> {
  // 🔴 呢個函式**唔可以拋錯**：佢喺「server 已經話登入成功」之後才跑，
  //    拋錯會被上層 `catch` 當成「登入失敗」，令明明成功嘅登入卡死在登入頁。
  //    寫唔到憑證最多下次要求聯網，唔應該影響今次登入。
  try {
    if (!offlineLoginSupported()) return false;
    if (!input.merchantId) return false;
    const verifier = await deriveOfflineVerifier(input.pin);
    if (!verifier) return false;

    const now = input.now ?? Date.now();
    const previous = readRaw();
    const sameStore = previous?.merchantId === input.merchantId;
    const kept = sameStore ? previous.identities : [];
    const entry: OfflineIdentity = {
      ...input.identity,
      verifier,
      session: input.session,
    };
    const identities = [
      ...kept.filter((it) => it.id !== entry.id),
      entry,
    ];
    // 店主排最前，同 `/login` 身份清單一致
    identities.sort((a, b) => (a.kind === "owner" ? -1 : b.kind === "owner" ? 1 : 0));

    writeRaw({
      version: OFFLINE_CREDENTIAL_VERSION,
      merchantId: input.merchantId,
      account: input.account,
      storeName: input.storeName || (sameStore ? previous?.storeName : undefined),
      savedAt: now,
      identities,
      fails: 0,
      lockedUntil: 0,
    });
    return true;
  } catch {
    return false;
  }
}
