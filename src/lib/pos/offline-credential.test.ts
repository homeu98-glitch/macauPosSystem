import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { AuthSession } from "@/lib/storage.ts";
import {
  OFFLINE_CREDENTIAL_KEY,
  OFFLINE_LOCK_MS,
  OFFLINE_MAX_FAILS,
  OFFLINE_TTL_MS,
  clearOfflineFailures,
  credentialDaysLeft,
  deriveOfflineVerifier,
  isCredentialExpired,
  loadOfflineCredential,
  lockRemainingMs,
  recordOfflineFailure,
  rememberOfflineIdentity,
  verifyOfflinePin,
} from "./offline-credential.ts";

/**
 * 離線登入憑證（P4，2026-10-29）。
 *
 * 呢個模組嘅失效模式全部係**靜靜錯**，所以要用測試鎖死：
 *   · 驗證器太寬鬆（例如空 PIN 都過）⇒ 任何人開機就入得；
 *   · 驗證器太嚴格（例如 salt 亂咁重新產生）⇒ 明明打啱 PIN 都入唔到，
 *     而且係**斷網**先發生 —— 店門最需要開工嗰刻才爆；
 *   · TTL／鎖定計錯 ⇒ 要麼鎖死全店，要麼永遠唔鎖。
 */

// ── localStorage shim（node 冇 window）────────────────────────────────
class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  getItem(key: string) {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
  key(index: number) {
    return Array.from(this.map.keys())[index] ?? null;
  }
}

const storage = new MemoryStorage();
(globalThis as unknown as { window: unknown }).window = { localStorage: storage };

function session(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    account: "staff:01",
    name: "阿明",
    role: "cashier",
    merchantId: "store-a",
    permissions: { refundOrder: false, voidItem: false } as AuthSession["permissions"],
    loggedInAt: "2026-10-29T00:00:00.000Z",
    ledgerAccessToken: "tok",
    ledgerRefreshToken: "ref",
    ...overrides,
  };
}

async function seedOwner(overrides: { merchantId?: string; pin?: string } = {}) {
  return rememberOfflineIdentity({
    merchantId: overrides.merchantId ?? "store-a",
    account: "66123456",
    storeName: "好味茶餐廳",
    identity: { kind: "owner", id: "owner", name: "陳老闆", role: "owner" },
    pin: overrides.pin ?? "1234",
    session: session({ account: "66123456", name: "陳老闆", role: "admin" }),
    now: 1_000_000,
  });
}

beforeEach(() => {
  storage.clear();
});

describe("PIN 驗證器", () => {
  it("同一個 PIN 用同一 salt 派生，結果一致（否則永遠登入唔到）", async () => {
    const a = await deriveOfflineVerifier("1234", "00112233445566778899aabbccddeeff");
    const b = await deriveOfflineVerifier("1234", "00112233445566778899aabbccddeeff");
    assert.ok(a);
    assert.ok(b);
    assert.equal(a.hash, b.hash);
  });

  it("唔傳 salt 就每次新 salt，hash 唔會相同（彩虹表失效）", async () => {
    const a = await deriveOfflineVerifier("1234");
    const b = await deriveOfflineVerifier("1234");
    assert.ok(a);
    assert.ok(b);
    assert.notEqual(a.salt, b.salt);
    assert.notEqual(a.hash, b.hash);
  });

  it("正確 PIN 驗證通過，錯 PIN 唔通過", async () => {
    const verifier = await deriveOfflineVerifier("1234");
    assert.ok(verifier);
    assert.equal(await verifyOfflinePin("1234", verifier), true);
    assert.equal(await verifyOfflinePin("4321", verifier), false);
    // 少一位／多一位都唔可以過
    assert.equal(await verifyOfflinePin("123", verifier), false);
    assert.equal(await verifyOfflinePin("12345", verifier), false);
  });

  it("非 4 位數字 PIN 一律唔產生驗證器（fail closed）", async () => {
    for (const bad of ["", "12a4", "12345", "abcd"]) {
      assert.equal(await deriveOfflineVerifier(bad), null, `應該拒絕：${bad}`);
    }
  });

  it("演算法標籤唔對（將來換算法）就唔通過，唔會亂猜", async () => {
    const verifier = await deriveOfflineVerifier("1234");
    assert.ok(verifier);
    const foreign = { ...verifier, algo: "pbkdf2-sha256-999" } as unknown as typeof verifier;
    assert.equal(await verifyOfflinePin("1234", foreign), false);
  });

  it("hash 長度唔對就唔通過（唔好靠 prefix 比對）", async () => {
    const verifier = await deriveOfflineVerifier("1234");
    assert.ok(verifier);
    assert.equal(await verifyOfflinePin("1234", { ...verifier, hash: "ab" }), false);
  });
});

describe("有效期（7 日）", () => {
  it("7 日內仍然可用，過咗就過期", async () => {
    assert.equal(await seedOwner(), true);
    const cred = loadOfflineCredential();
    assert.ok(cred);
    assert.equal(isCredentialExpired(cred, 1_000_000 + OFFLINE_TTL_MS - 1), false);
    assert.equal(isCredentialExpired(cred, 1_000_000 + OFFLINE_TTL_MS + 1), true);
  });

  it("剩餘日數向上取整，過期回 0", async () => {
    assert.equal(await seedOwner(), true);
    const cred = loadOfflineCredential();
    assert.ok(cred);
    assert.equal(credentialDaysLeft(cred, 1_000_000), 7);
    assert.equal(credentialDaysLeft(cred, 1_000_000 + OFFLINE_TTL_MS), 0);
  });
});

describe("錯誤鎖定", () => {
  it(`連續錯 ${OFFLINE_MAX_FAILS} 次就鎖 ${OFFLINE_LOCK_MS / 60000} 分鐘`, async () => {
    assert.equal(await seedOwner(), true);
    let cred = loadOfflineCredential();
    assert.ok(cred);

    for (let i = 0; i < OFFLINE_MAX_FAILS - 1; i += 1) {
      cred = recordOfflineFailure(cred, 5_000);
      assert.equal(cred.lockedUntil, 0, `第 ${i + 1} 次唔應該鎖`);
      assert.equal(cred.fails, i + 1);
    }
    cred = recordOfflineFailure(cred, 5_000);
    assert.equal(cred.lockedUntil, 5_000 + OFFLINE_LOCK_MS);
    // 鎖咗之後計數重置，解鎖後有完整 5 次機會
    assert.equal(cred.fails, 0);
    assert.equal(lockRemainingMs(cred, 5_000), OFFLINE_LOCK_MS);
    assert.equal(lockRemainingMs(cred, 5_000 + OFFLINE_LOCK_MS), 0);
  });

  it("成功一次就清走計數同鎖", async () => {
    assert.equal(await seedOwner(), true);
    let cred = loadOfflineCredential();
    assert.ok(cred);
    cred = recordOfflineFailure(cred, 5_000);
    cred = recordOfflineFailure(cred, 5_000);
    assert.equal(cred.fails, 2);
    cred = clearOfflineFailures(cred);
    assert.equal(cred.fails, 0);
    assert.equal(cred.lockedUntil, 0);
  });
});

describe("寫入策略", () => {
  it("同店再登入：合併身份，唔會清走另一個", async () => {
    assert.equal(await seedOwner(), true);
    await rememberOfflineIdentity({
      merchantId: "store-a",
      account: "66123456",
      identity: { kind: "staff", id: "s-1", name: "阿明", staffNo: "01", role: "cashier" },
      pin: "5678",
      session: session(),
      now: 2_000_000,
    });
    const cred = loadOfflineCredential();
    assert.ok(cred);
    assert.equal(cred.identities.length, 2);
    // 店主排最前（同登入頁一致）
    assert.equal(cred.identities[0].kind, "owner");
    assert.equal(cred.storeName, "好味茶餐廳", "合併時要保留店名");
  });

  it("換店（merchantId 唔同）就整份重來，唔可以帶住上一間店嘅身份", async () => {
    assert.equal(await seedOwner(), true);
    await rememberOfflineIdentity({
      merchantId: "store-b",
      account: "66999999",
      storeName: "另一間",
      identity: { kind: "owner", id: "owner", name: "李老闆", role: "owner" },
      pin: "9999",
      session: session({ merchantId: "store-b", name: "李老闆", role: "admin" }),
      now: 3_000_000,
    });
    const cred = loadOfflineCredential();
    assert.ok(cred);
    assert.equal(cred.merchantId, "store-b");
    assert.equal(cred.identities.length, 1);
    assert.equal(cred.identities[0].name, "李老闆");
  });

  it("同一身份再登入會覆蓋舊 verifier（改過 PIN 都認得新嘅）", async () => {
    assert.equal(await seedOwner({ pin: "1234" }), true);
    assert.equal(await seedOwner({ pin: "8888" }), true);
    const cred = loadOfflineCredential();
    assert.ok(cred);
    assert.equal(cred.identities.length, 1);
    const owner = cred.identities[0];
    assert.equal(await verifyOfflinePin("8888", owner.verifier), true);
    assert.equal(await verifyOfflinePin("1234", owner.verifier), false);
  });

  it("冇 merchantId 就唔寫（寧願冇離線登入，都唔好寫一份無主憑證）", async () => {
    const ok = await rememberOfflineIdentity({
      merchantId: "",
      account: "1",
      identity: { kind: "owner", id: "owner", name: "X", role: "owner" },
      pin: "1234",
      session: session(),
    });
    assert.equal(ok, false);
    assert.equal(storage.getItem(OFFLINE_CREDENTIAL_KEY), null);
  });
});

describe("讀取容錯", () => {
  it("壞 JSON／舊版本唔會拋錯，回 null", () => {
    storage.setItem(OFFLINE_CREDENTIAL_KEY, "{not json");
    assert.equal(loadOfflineCredential(), null);
    storage.setItem(OFFLINE_CREDENTIAL_KEY, JSON.stringify({ version: 999, merchantId: "s" }));
    assert.equal(loadOfflineCredential(), null);
  });

  it("壞身份逐個剔走，剩低嘅仍然可用（一個 corrupt entry 唔應該令全店死）", async () => {
    assert.equal(await seedOwner(), true);
    const raw = JSON.parse(storage.getItem(OFFLINE_CREDENTIAL_KEY) as string) as {
      identities: unknown[];
    };
    raw.identities.push({ kind: "staff", id: "bad" });
    storage.setItem(OFFLINE_CREDENTIAL_KEY, JSON.stringify(raw));
    const cred = loadOfflineCredential();
    assert.ok(cred);
    assert.equal(cred.identities.length, 1);
    assert.equal(cred.identities[0].kind, "owner");
  });
});
