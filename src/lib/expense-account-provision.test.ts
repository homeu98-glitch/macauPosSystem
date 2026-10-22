import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  provisionExpenseShopUser,
  createExpenseShopUserStore,
  validateAccountForProvision,
  validateLoginPin,
  type ShopUserStore,
  type ShopUserRow,
} from "./expense-account-provision.ts";

/**
 * 假 `ShopUserStore`：用 selQueue / insertFactory 控制 resolve-or-create 嘅分支，
 * 唔使連真實 supabase。selQueue[i] = 第 i+1 次 selectByLoginId 嘅回傳；
 * insertFactory(call) = 第 call+1 次 insert 嘅結果（可 throw）。
 */
function fakeStore(opts: {
  selQueue: (ShopUserRow | null)[];
  insertFactory: (call: number) => { id: string } | never;
}): ShopUserStore & { selectCalls: number; insertCalls: number } {
  let sc = 0;
  let ic = 0;
  const api = {
    async selectByLoginId(): Promise<ShopUserRow | null> {
      sc += 1;
      return opts.selQueue[sc - 1] ?? null;
    },
    async insert() {
      const call = ic;
      ic += 1;
      return opts.insertFactory(call);
    },
    get selectCalls() {
      return sc;
    },
    get insertCalls() {
      return ic;
    },
  };
  return api;
}

function dupError(): never {
  throw Object.assign(new Error("duplicate key"), { code: "23505" });
}
function missingColumnError(): never {
  throw Object.assign(new Error("column does not exist"), { code: "42703" });
}
function otherError(): never {
  throw Object.assign(new Error("boom"), { code: "XXXXX" });
}

const opts = {
  loginId: "66001234",
  loginPin: "1234",
  shopName: "興發小食店",
  externalShopId: "8291f843-9def-4956-9d0b-1cfef2598306",
  authSource: "macau-pos" as const,
};

describe("validateAccountForProvision", () => {
  it("接受 8 位數字", () => {
    assert.deepEqual(validateAccountForProvision("66001234"), { ok: true });
  });
  it("拒絕非 8 位", () => {
    assert.equal(validateAccountForProvision("123").ok, false);
  });
  it("拒絕保留號 60000000", () => {
    assert.equal(validateAccountForProvision("60000000").ok, false);
  });
});

describe("validateLoginPin", () => {
  it("接受 4 位", () => assert.equal(validateLoginPin("1234"), true));
  it("拒絕非 4 位", () => assert.equal(validateLoginPin("12"), false));
});

describe("provisionExpenseShopUser", () => {
  it("已存在 → created:false，唔 call insert（鐵律：唔 UPDATE 現有戶口）", async () => {
    const store = fakeStore({ selQueue: [{ id: "u-existing", external_shop_id: null }], insertFactory: () => ({ id: "x" }) });
    const r = await provisionExpenseShopUser(store, opts);
    assert.deepEqual(r, { ok: true, userId: "u-existing", created: false, account: opts.loginId });
    assert.equal(store.insertCalls, 0);
  });

  it("不存在 → INSERT 成功，created:true", async () => {
    const store = fakeStore({ selQueue: [null], insertFactory: () => ({ id: "u-new" }) });
    const r = await provisionExpenseShopUser(store, opts);
    assert.deepEqual(r, { ok: true, userId: "u-new", created: true, account: opts.loginId });
    assert.equal(store.insertCalls, 1);
  });

  it("INSERT 撞 23505 但並發已建 → created:false（第二次 select 搵到）", async () => {
    const store = fakeStore({
      selQueue: [null, { id: "u-race", external_shop_id: null }],
      insertFactory: () => dupError(),
    });
    const r = await provisionExpenseShopUser(store, opts);
    assert.deepEqual(r, { ok: true, userId: "u-race", created: false, account: opts.loginId });
    assert.equal(store.insertCalls, 1);
  });

  it("external_shop_id 撞 unique → 降級唔寫 external_shop_id 再 INSERT，created:true", async () => {
    let secondInsertExternal: string | null | undefined = "unset";
    const store = fakeStore({
      selQueue: [null, null],
      insertFactory: (call) => {
        if (call === 0) return dupError();
        // 第二次 insert 由 insertWithoutExternalShopId 發出（externalShopId=null）
        secondInsertExternal = "called";
        return { id: "u-noext" };
      },
    });
    const r = await provisionExpenseShopUser(store, opts);
    assert.deepEqual(r, { ok: true, userId: "u-noext", created: true, account: opts.loginId });
    assert.equal(store.insertCalls, 2);
    assert.equal(secondInsertExternal, "called");
  });

  it("INSERT 兩次都 23505 → 409 LOGIN_ID_TAKEN", async () => {
    const store = fakeStore({ selQueue: [null, null, null], insertFactory: () => dupError() });
    const r = await provisionExpenseShopUser(store, opts);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 409);
      assert.equal(r.code, "LOGIN_ID_TAKEN");
    }
  });

  it("account 唔合法 → 400（唔 call store）", async () => {
    const store = fakeStore({ selQueue: [null], insertFactory: () => ({ id: "x" }) });
    const r = await provisionExpenseShopUser(store, { ...opts, loginId: "123" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
    assert.equal(store.selectCalls, 0);
    assert.equal(store.insertCalls, 0);
  });

  it("PIN 唔合法 → 400", async () => {
    const store = fakeStore({ selQueue: [null], insertFactory: () => ({ id: "x" }) });
    const r = await provisionExpenseShopUser(store, { ...opts, loginPin: "12" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  });

  it("保留號 → 400", async () => {
    const store = fakeStore({ selQueue: [null], insertFactory: () => ({ id: "x" }) });
    const r = await provisionExpenseShopUser(store, { ...opts, loginId: "60000000" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  });

  it("INSERT 非 23505/42703 錯 → 500（caller 靜默放過）", async () => {
    const store = fakeStore({ selQueue: [null], insertFactory: () => otherError() });
    const r = await provisionExpenseShopUser(store, opts);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 500);
  });

  it("INSERT 撞 42703 → adapter 降級（本層唔需要額外處理，caller 收 500/ok）", async () => {
    // adapter 內部會 catch 42703 降級；純邏輯層遇到 42703 當一般 DB 錯 → 500。
    const store = fakeStore({ selQueue: [null], insertFactory: () => missingColumnError() });
    const r = await provisionExpenseShopUser(store, opts);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 500);
  });

  it("初始 SELECT 拋錯 → 當未搵到，照 INSERT（唔可以令開通靜默失敗）", async () => {
    let selectCalls = 0;
    const store: ShopUserStore = {
      async selectByLoginId() {
        selectCalls += 1;
        throw Object.assign(new Error("column does not exist"), { code: "42703" });
      },
      async insert() {
        return { id: "u-after-throw" };
      },
    };
    const r = await provisionExpenseShopUser(store, opts);
    assert.deepEqual(r, { ok: true, userId: "u-after-throw", created: true, account: opts.loginId });
    assert.equal(selectCalls, 1);
  });
});

// ── adapter（createExpenseShopUserStore）降級測試 ─────────────────────────
// 用最小 fake client 驗證 schema 漂移時嘅行為，唔使連真實 supabase。
type FakeClient = Parameters<typeof createExpenseShopUserStore>[0];

describe("createExpenseShopUserStore（schema 漂移降級）", () => {
  it("selectByLoginId：缺 external_shop_id 欄（42703）→ 降級只 select id", async () => {
    const cols: string[] = [];
    const client = {
      from: () => ({
        select: (c: string) => {
          cols.push(c);
          return {
            eq: () => ({
              maybeSingle: async () =>
                c.includes("external_shop_id")
                  ? {
                      data: null,
                      error: {
                        code: "42703",
                        message: "column shop_users.external_shop_id does not exist",
                      },
                    }
                  : { data: { id: "u1" }, error: null },
            }),
          };
        },
      }),
    } as unknown as FakeClient;
    const store = createExpenseShopUserStore(client);
    const row = await store.selectByLoginId("68189891");
    assert.deepEqual(row, { id: "u1", external_shop_id: null });
    assert.equal(cols.length, 2);
    assert.equal(cols[1], "id");
  });

  it("insert：缺欄回 PGRST204 → 降級只寫基礎三欄", async () => {
    let n = 0;
    const payloads: Record<string, unknown>[] = [];
    const client = {
      from: () => ({
        insert: (p: Record<string, unknown>) => {
          n += 1;
          payloads.push(p);
          const hasExt = "external_shop_id" in p;
          return {
            select: () => ({
              single: async () =>
                hasExt
                  ? {
                      data: null,
                      error: {
                        code: "PGRST204",
                        message:
                          "Could not find the 'external_shop_id' column of 'shop_users' in the schema cache",
                      },
                    }
                  : { data: { id: "u-new" }, error: null },
            }),
          };
        },
      }),
    } as unknown as FakeClient;
    const store = createExpenseShopUserStore(client);
    const r = await store.insert({
      loginId: "68189891",
      loginPin: "1234",
      shopName: "Brewlab Coffee",
      externalShopId: "uuid-1",
      authSource: "macau-pos",
    });
    assert.deepEqual(r, { id: "u-new" });
    assert.equal(n, 2);
    assert.equal("external_shop_id" in payloads[1], false);
  });

  it("insert：非缺欄錯誤照 throw（唔可以當缺欄亂降級）", async () => {
    const client = {
      from: () => ({
        insert: () => ({
          select: () => ({
            single: async () => ({ data: null, error: { code: "23503", message: "fk violation" } }),
          }),
        }),
      }),
    } as unknown as FakeClient;
    const store = createExpenseShopUserStore(client);
    await assert.rejects(() =>
      store.insert({
        loginId: "68189891",
        loginPin: "1234",
        shopName: "x",
        externalShopId: null,
        authSource: "macau-pos",
      }),
    );
  });
});
