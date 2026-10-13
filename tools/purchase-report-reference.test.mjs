// tools/purchase-report-reference.test.mjs
// 純函數單測：唔使 Redis / DB 都跑得到。對齊 docs/integration/ledger-purchase-report-reference-impl.md §3。
// 跑：node --test tools/purchase-report-reference.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

// ── 從 doc §3 抄出嚟嘅純函數（實際部署喺 expenseRecorder lib，呢度鎖死行為）──
const MERCHANT_ID_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|SHOP_[0-9A-Za-z_-]+)$/i;
function isMerchantId(v) {
  return typeof v === "string" && MERCHANT_ID_RE.test(v.trim());
}

function encodeCursor(d, id) {
  return Buffer.from(JSON.stringify({ d, id }), "utf8").toString("base64url");
}
function decodeCursor(c) {
  try {
    const o = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    if (o && typeof o.d === "string" && typeof o.id === "string") return { d: o.d, id: o.id };
    return null;
  } catch {
    return null;
  }
}

// 對齊 receipts RPC：攞 limit+1 行，hasMore = 行數 > limit；之後切到 limit。
// 修 point 8：nextCursor 只喺 hasMore 先有值（滿 50 最尾頁唔會多一頁空頁）。
function paginate(rows, limit) {
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.receiptDate, last.receiptId) : null;
  return { page, hasMore, nextCursor };
}

function validateSummaryRpc(raw) {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "rpc-not-object" };
  const r = raw;
  if (typeof r.found !== "boolean") return { ok: false, reason: "rpc-bad-found" };
  if (typeof r.dataVersion !== "number" || !Number.isSafeInteger(r.dataVersion))
    return { ok: false, reason: "rpc-bad-version" };
  // 修 point 4：supplierCount / itemLineCount 係 RPC 直接回嘅 range-level 真值，缺一不可。
  if (typeof r.supplierCount !== "number" || !Number.isFinite(r.supplierCount))
    return { ok: false, reason: "rpc-bad-supplierCount" };
  if (typeof r.itemLineCount !== "number" || !Number.isFinite(r.itemLineCount))
    return { ok: false, reason: "rpc-bad-itemLineCount" };
  return { ok: true, ...r };
}

test("isMerchantId 收 UUID 同 SHOP_ 前綴（point 7：待雙方確認，暫兩者都收）", () => {
  assert.equal(isMerchantId("3f1a-...-...."), false); // 唔完整 UUID
  assert.equal(isMerchantId("3f1a4b2c-1d2e-4f3a-9b8c-7d6e5f4a3b2c"), true);
  assert.equal(isMerchantId("SHOP_000123"), true);
  assert.equal(isMerchantId("garbage"), false);
});

test("cursor base64url round-trip（point 8：URL-safe、無換行）", () => {
  const c = encodeCursor("2026-10-11", "b1f0id");
  assert.equal(typeof c, "string");
  assert.ok(!c.includes("+") && !c.includes("/")); // URL-safe
  assert.ok(!c.includes("\n"));
  const back = decodeCursor(c);
  assert.deepEqual(back, { d: "2026-10-11", id: "b1f0id" });
  assert.equal(decodeCursor("!!!not-base64!!!"), null);
});

test("hasMore / nextCursor：滿 50 最尾頁唔出 cursor（point 8）", () => {
  const mk = (n) =>
    Array.from({ length: n }, (_, i) => ({ receiptDate: "2026-10-11", receiptId: "id" + i }));
  const a = paginate(mk(51), 50);
  assert.equal(a.hasMore, true);
  assert.equal(a.page.length, 50);
  assert.ok(a.nextCursor && a.nextCursor.length > 0);
  const b = paginate(mk(50), 50);
  assert.equal(b.hasMore, false);
  assert.equal(b.page.length, 50);
  assert.equal(b.nextCursor, null); // 修 point 8：唔會多一頁空頁
  const c = paginate(mk(0), 50);
  assert.equal(c.hasMore, false);
  assert.equal(c.nextCursor, null);
});

test("validateSummaryRpc 要求 supplierCount / itemLineCount（point 4：唔可以假零）", () => {
  const bad = validateSummaryRpc({ found: true, dataVersion: 1, byCurrency: [] });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "rpc-bad-supplierCount");
  const good = validateSummaryRpc({
    found: true,
    dataVersion: 1,
    supplierCount: 5,
    itemLineCount: 47,
    byCurrency: [],
  });
  assert.equal(good.ok, true);
});
