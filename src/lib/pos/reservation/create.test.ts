import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createReservationRecord, type CreateReservationOptions } from "./create.ts";

/**
 * 呢份測試守住 `/api/public/reservations` 嘅安全邊界。
 * 任何一條紅都要當 P0 —— 客人端係**匿名可寫入**嘅端點。
 */

const ALL_DAY = Object.fromEntries(
  ["1", "2", "3", "4", "5", "6", "7"].map((d) => [d, { open: "00:00", close: "23:59" }]),
);

const SETTINGS_ROW = {
  store_id: "store-a",
  enabled: true,
  service_hours: ALL_DAY,
  min_party_size: 1,
  max_party_size: 20,
  lead_days_max: 30,
  lead_minutes_min: 0,
  slot_interval_minutes: 30,
  slot_quota: 5,
  auto_confirm: false,
  large_party_threshold: 8,
};

const CREATED_ROW = {
  id: "res-1",
  store_id: "store-a",
  code: "R1106-018",
  biz_date: "2026-11-06",
  slot_at: "2026-11-06T11:00:00.000Z",
  party_size: 4,
  guest_name: "陳先生",
  guest_phone: "66123456",
  guest_note: null,
  status: "pending",
  source: "ledger",
  table_id: null,
  table_name: null,
  order_id: null,
  order_no: null,
  items: [],
  items_subtotal: 0,
  discount_amount: 0,
  payable_amount: 0,
  paid_amount: 0,
  paid_at: null,
  payment_ref: null,
  payment_method: null,
  refund_amount: 0,
  refunded_at: null,
  member_id: null,
  member_discount_rate: null,
  created_at: "2026-11-06T02:00:00.000Z",
  confirmed_at: null,
  arrived_at: null,
  seated_at: null,
  canceled_at: null,
  cancel_reason: null,
  updated_at: "2026-11-06T02:00:00.000Z",
};

type Harness = {
  client: SupabaseClient;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
};

function harness(opts: {
  menuItems?: Array<Record<string, unknown>>;
  rules?: Record<string, unknown>;
  rpcError?: { message: string };
  settingsRow?: Record<string, unknown> | null;
} = {}): Harness {
  const rpcCalls: Harness["rpcCalls"] = [];
  const client = {
    from(table: string) {
      const data =
        table === "pos_reservation_settings"
          ? opts.settingsRow === undefined
            ? SETTINGS_ROW
            : opts.settingsRow
          : { menu_items: opts.menuItems ?? [], rules: opts.rules ?? {} };
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data, error: null }) }),
        }),
      };
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (opts.rpcError) return { data: null, error: opts.rpcError };
      return { data: CREATED_ROW, error: null };
    },
  };
  return { client: client as unknown as SupabaseClient, rpcCalls };
}

const PUBLIC_OPTIONS: CreateReservationOptions = {
  allowedSources: ["ledger"],
  defaultSource: "ledger",
  allowForceStatus: false,
};

const POS_OPTIONS: CreateReservationOptions = {
  allowedSources: ["pos", "ledger", "phone", "walkin"],
  defaultSource: "pos",
  allowForceStatus: true,
};

function validPayload(extra: Record<string, unknown> = {}) {
  return {
    storeId: "store-a",
    slotAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    partySize: 4,
    guestName: "陳先生",
    guestPhone: "66123456",
    guestNote: "",
    items: [],
    ...extra,
  };
}

test("客人端唔可以偽造 source", async () => {
  const h = harness();
  await createReservationRecord(h.client, validPayload({ source: "pos" }), PUBLIC_OPTIONS);
  assert.equal(h.rpcCalls[0].args.p_source, "ledger");
});

test("客人端唔可以自己指定 confirmed 狀態", async () => {
  const h = harness();
  await createReservationRecord(h.client, validPayload({ forceStatus: "confirmed" }), PUBLIC_OPTIONS);
  assert.equal(h.rpcCalls[0].args.p_force_status, null);
});

test("POS 端可以指定 forceStatus，其他 source 亦照舊放行", async () => {
  const h = harness();
  await createReservationRecord(
    h.client,
    validPayload({ source: "phone", forceStatus: "confirmed" }),
    POS_OPTIONS,
  );
  assert.equal(h.rpcCalls[0].args.p_source, "phone");
  assert.equal(h.rpcCalls[0].args.p_force_status, "confirmed");
});

test("🔴 服務端核價：client 傳嘅假價錢同假菜名一律無效", async () => {
  const h = harness({
    menuItems: [{ id: "m1", name: "蜜汁叉燒", price: 88, memberPrice: null }],
  });
  const result = await createReservationRecord(
    h.client,
    validPayload({
      items: [
        {
          menuItemId: "m1",
          qty: 2,
          specs: {},
          specText: "",
          // 攻擊者嘗試改價／改名
          unitPrice: 0.01,
          name: "免費餐",
          payableAmount: 0.02,
        },
      ],
    }),
    PUBLIC_OPTIONS,
  );
  assert.equal(result.ok, true);
  const items = h.rpcCalls[0].args.p_items as Array<Record<string, unknown>>;
  assert.equal(items[0].unitPrice, 88);
  assert.equal(items[0].name, "蜜汁叉燒");
  assert.equal(items[0].qty, 2);
  assert.equal(h.rpcCalls[0].args.p_items_subtotal, 176);
  assert.equal(h.rpcCalls[0].args.p_payable_amount, 176);
});

test("全店會員折扣由 server 由 rules 讀，唔信 client", async () => {
  const h = harness({
    menuItems: [{ id: "m1", name: "蜜汁叉燒", price: 100 }],
    rules: { memberDiscountRate: 90 },
  });
  await createReservationRecord(
    h.client,
    validPayload({ items: [{ menuItemId: "m1", qty: 1, specs: {}, specText: "" }] }),
    PUBLIC_OPTIONS,
  );
  assert.equal(h.rpcCalls[0].args.p_member_discount_rate, 90);
  assert.equal(h.rpcCalls[0].args.p_payable_amount, 90);
});

test("已下架／不存在嘅菜直接拒絕，唔會入 RPC", async () => {
  const h = harness({ menuItems: [{ id: "m1", name: "叉燒", price: 88, active: false }] });
  const result = await createReservationRecord(
    h.client,
    validPayload({
      items: [
        { menuItemId: "m1", qty: 1, specs: {}, specText: "" },
        { menuItemId: "ghost", qty: 1, specs: {}, specText: "" },
      ],
    }),
    PUBLIC_OPTIONS,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "items_unavailable");
    assert.equal(result.rejected?.length, 2);
  }
  assert.equal(h.rpcCalls.length, 0);
});

test("未設定過訂位嘅店一律拒絕（唔可以用 default 值放人入嚟）", async () => {
  const h = harness({ settingsRow: null });
  const result = await createReservationRecord(h.client, validPayload(), PUBLIC_OPTIONS);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 403);
    assert.equal(result.code, "disabled");
  }
  assert.equal(h.rpcCalls.length, 0);
});

test("時段已滿 → 409 slot_full（配額衝突由 DB 擋）", async () => {
  const h = harness({ rpcError: { message: "ERROR: slot_full" } });
  const result = await createReservationRecord(h.client, validPayload(), PUBLIC_OPTIONS);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 409);
    assert.equal(result.code, "slot_full");
  }
});
