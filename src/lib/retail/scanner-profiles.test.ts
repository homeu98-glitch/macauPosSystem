// 掃碼槍型號庫 + 自動學習測試（docs/124 §2.6）
// 用 Node 內建 test runner：node --test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TIMEOUT_MS,
  HUMAN_INTERVAL_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  SCANNER_BEHAVIOR_PRESETS,
  SCANNER_VENDORS,
  buildVendorIndex,
  commonPrefixOf,
  defaultScannerProfile,
  describeSuffix,
  extractPrefix,
  getScannerModelOptions,
  intervalsOf,
  learnProfile,
  median,
  profileFromBehavior,
  resolveScannerMeta,
  toHexId,
} from "./scanner-profiles.ts";
import type { ScanSample, ScannerSuffix } from "./types.ts";

/** 造一個樣本：`chars` 每個字元相隔 `intervalMs` */
function sample(
  chars: string,
  intervalMs = 8,
  terminatedBy: ScannerSuffix = "enter",
): ScanSample {
  const keyTimestamps = [0];
  for (let i = 1; i < chars.length; i++) keyTimestamps.push(keyTimestamps[i - 1] + intervalMs);
  return { keyTimestamps, chars, terminatedBy };
}

/** 三個開頭字元唔同嘅真條碼（避免共同前綴污染前綴偵測） */
const DIFFERENT_CODES = ["4891028001232", "6934177701234", "1234567890128"];

// ─────────────────────────────────────────────────────────────
// 基礎工具
// ─────────────────────────────────────────────────────────────

test("median：單數 / 雙數 / 空 / 單一值", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([8]), 8);
  assert.equal(median([]), null);
  // 非有限值要剔走
  assert.equal(median([8, Number.NaN, 10]), 9);
});

test("intervalsOf：每鍵間隔；時間戳不足回空", () => {
  assert.deepEqual(intervalsOf(sample("12345", 8)), [8, 8, 8, 8]);
  assert.deepEqual(intervalsOf({ keyTimestamps: [5], chars: "1" }), []);
  assert.deepEqual(intervalsOf({ keyTimestamps: [], chars: "" }), []);
});

test("commonPrefixOf：最長共同前綴", () => {
  assert.equal(commonPrefixOf(["abc", "abd"]), "ab");
  assert.equal(commonPrefixOf(["abc", "abc"]), "abc");
  assert.equal(commonPrefixOf(["abc"]), ""); // 單一字串分離唔到
  assert.equal(commonPrefixOf([]), "");
  assert.equal(commonPrefixOf(["~4", "~5"]), "~");
  assert.equal(commonPrefixOf(["abc", ""]), "");
});

test("🔴 extractPrefix：數字開頭嘅共同前綴唔可以當裝置前綴（否則剝錯令全部條碼對唔中）", () => {
  // 同一廠商嘅條碼本身就開頭相同 → 分唔清 → 唔可以亂剝
  assert.deepEqual(extractPrefix(["4891028001232", "4891028700311"]), {
    prefix: "",
    confidence: "none",
  });
  // 完全唔同開頭 → 冇前綴
  assert.deepEqual(extractPrefix(DIFFERENT_CODES), { prefix: "", confidence: "none" });
});

test("extractPrefix：純符號前綴 → high（掃碼槍出廠前綴幾乎一定係符號）", () => {
  assert.deepEqual(extractPrefix(["~4891028001232", "~6934177701234"]), {
    prefix: "~",
    confidence: "high",
  });
  assert.deepEqual(extractPrefix(["%1234", "%5678"]), { prefix: "%", confidence: "high" });
  assert.deepEqual(extractPrefix(["##1234", "##5678"]), { prefix: "##", confidence: "high" });
});

test("extractPrefix：字母前綴 → low（要商家喺測試框確認）", () => {
  assert.deepEqual(extractPrefix(["PRD1001", "PRD1002"]), { prefix: "PRD", confidence: "low" });
});

// ─────────────────────────────────────────────────────────────
// learnProfile
// ─────────────────────────────────────────────────────────────

test("learnProfile：無前綴嘅掃碼槍 → 學到速度 / 結尾 / 長度", () => {
  const r = learnProfile(DIFFERENT_CODES.map((c) => sample(c)));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.profile.prefix, undefined);
  assert.equal(r.profile.suffix, "enter");
  assert.equal(r.profile.charset, "digits");
  assert.equal(r.profile.minLength, 13);
  assert.equal(r.profile.maxLength, 13);
  assert.equal(r.profile.source, "auto-learn");
  assert.equal(r.metrics.medianIntervalMs, 8);
  assert.equal(r.metrics.distinctCodes, 3);
  assert.equal(r.metrics.fixedLength, true);
  assert.equal(r.metrics.prefixConfidence, "none");
  // 超時 = 中位數 × 5 = 40，喺 [30,150] 之內
  assert.equal(r.profile.timeoutMs, 40);
});

test("learnProfile：帶 `~` 前綴 → 剝到前綴，長度唔含前綴", () => {
  const r = learnProfile(DIFFERENT_CODES.map((c) => sample("~" + c)));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.profile.prefix, "~");
  assert.equal(r.metrics.prefixConfidence, "high");
  // 14 個字元含前綴，剝完應該係 13
  assert.equal(r.profile.minLength, 13);
  assert.equal(r.metrics.minLength, 13);
  assert.equal(r.warnings.length, 0);
});

test("🔴 learnProfile：三次都掃同一個條碼 → 判斷唔到前綴，要出 warning 唔可以亂猜", () => {
  const r = learnProfile(["4891028001232", "4891028001232", "4891028001232"].map((c) => sample(c)));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.profile.prefix, undefined);
  assert.equal(r.metrics.distinctCodes, 1);
  assert.ok(r.warnings.some((w) => w.includes("同一個條碼")));
});

test("🔴 learnProfile：人手打字速度 → ok:false（唔可以硬套 profile，否則之後人手打字會被當掃碼）", () => {
  const r = learnProfile(DIFFERENT_CODES.map((c) => sample(c, HUMAN_INTERVAL_MS + 30)));
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("人手"));
  assert.equal(r.metrics.medianIntervalMs, HUMAN_INTERVAL_MS + 30);
});

test("learnProfile：樣本不足（少過 2 個）→ ok:false", () => {
  const r0 = learnProfile([]);
  assert.equal(r0.ok, false);
  const r1 = learnProfile([sample(DIFFERENT_CODES[0])]);
  assert.equal(r1.ok, false);
  assert.ok(r1.reason.includes("至少"));
});

test("learnProfile：時間戳唔夠長嘅樣本要剔走", () => {
  const bad: ScanSample = { keyTimestamps: [0], chars: "4" };
  const r = learnProfile([bad, sample(DIFFERENT_CODES[0]), sample(DIFFERENT_CODES[1])]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.metrics.sampleCount, 2); // bad 被剔走
});

test("learnProfile：結尾字元唔一致 → 用 none（靠超時收尾）+ warning", () => {
  const r = learnProfile([
    sample(DIFFERENT_CODES[0], 8, "enter"),
    sample(DIFFERENT_CODES[1], 8, "tab"),
    sample(DIFFERENT_CODES[2], 8, "enter"),
  ]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.profile.suffix, "none");
  assert.equal(r.metrics.suffix, "mixed");
  assert.ok(r.warnings.some((w) => w.includes("結尾字元")));
});

test("learnProfile：三個樣本一致嘅 Tab 結尾 → 採用", () => {
  const r = learnProfile(DIFFERENT_CODES.map((c) => sample(c, 8, "tab")));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.profile.suffix, "tab");
});

test("learnProfile：字母數字條碼 → charset alnum + warning", () => {
  const r = learnProfile(["AB123456", "CD987654"].map((c) => sample(c)));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.profile.charset, "alnum");
  assert.equal(r.metrics.allDigits, false);
  assert.ok(r.warnings.some((w) => w.includes("字母數字")));
});

test("learnProfile：字母前綴 → 採用但要 warning 提示確認", () => {
  const r = learnProfile(["PRD1001", "PRD1002"].map((c) => sample(c)));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.profile.prefix, "PRD");
  assert.equal(r.metrics.prefixConfidence, "low");
  assert.ok(r.warnings.some((w) => w.includes("含字母")));
});

test("learnProfile：慢速但未到人手（例如 60ms）→ 仍然當掃碼槍，超時跟住放大", () => {
  const r = learnProfile(DIFFERENT_CODES.map((c) => sample(c, 60)));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.profile.timeoutMs, MAX_TIMEOUT_MS); // 60×5=300 → 夾到 150
});

test("learnProfile：超快掃描 → 超時夾到下限（唔可以細到切斷自己）", () => {
  const r = learnProfile(DIFFERENT_CODES.map((c) => sample(c, 1)));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.profile.timeoutMs, MIN_TIMEOUT_MS);
});

test("learnProfile：可以自訂 id / name", () => {
  const r = learnProfile(DIFFERENT_CODES.map((c) => sample(c)), { id: "p1", name: "收銀台槍" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.profile.id, "p1");
  assert.equal(r.profile.name, "收銀台槍");
});

// ─────────────────────────────────────────────────────────────
// 型號庫
// ─────────────────────────────────────────────────────────────

test("toHexId：同 printer-models.ts 同一口徑", () => {
  assert.equal(toHexId(0x0416), "0x0416");
  assert.equal(toHexId("0x0416"), "0x0416");
  assert.equal(toHexId("1046"), "0x0416"); // 十進制 1046
  assert.equal(toHexId("0416"), "0x01A0"); // 當十進制 → 416
  // 契約：只認小寫 `0x`（VID 實際只會嚟自數值，或我哋自己序列化嘅小寫字串）
  assert.equal(toHexId("0X0416"), "");
  assert.equal(toHexId(null), "");
  assert.equal(toHexId(""), "");
  assert.equal(toHexId(0), "");
  assert.equal(toHexId(-1), "");
  assert.equal(toHexId("zz"), "");
});

test("🔴 SCANNER_VENDORS：唔可以兩個品牌共用同一個 VID（資料有錯唔應該靜默）", () => {
  const seen = new Map<string, string>();
  for (const v of SCANNER_VENDORS) {
    for (const raw of v.knownVids) {
      const vid = toHexId(raw);
      const prev = seen.get(vid);
      assert.equal(prev, undefined, `VID ${vid} 同時屬於「${prev}」同「${v.brand}」`);
      seen.set(vid, v.brand);
    }
  }
  assert.ok(SCANNER_VENDORS.length > 0);
});

test("buildVendorIndex：已確認嘅 VID 對得中品牌", () => {
  const idx = buildVendorIndex();
  assert.equal(idx.get("0x0416")?.brand, "佳博 Gprinter");
  assert.equal(idx.get("0x0483")?.brand, "芯燁 Xprinter");
  assert.equal(idx.get("0x2BDF")?.brand, "容大 Rongta");
});

test("resolveScannerMeta：認到 VID 但未有型號 → generic:true（用品牌預設）", () => {
  const r = resolveScannerMeta(0x0416, 0x5740);
  assert.ok(r);
  assert.equal(r.brand, "佳博 Gprinter");
  assert.equal(r.generic, true);
  assert.equal(r.profile.suffix, "enter");
});

test("resolveScannerMeta：VID 都認唔到 → null（要回落自動學習，唔可以亂套預設）", () => {
  assert.equal(resolveScannerMeta(0x9999, 0x0001), null);
  assert.equal(resolveScannerMeta(null, null), null);
  assert.equal(resolveScannerMeta("", ""), null);
  assert.equal(resolveScannerMeta("zz", "yy"), null);
});

test("getScannerModelOptions：每個選項都有品牌 / 型號 / profile", () => {
  const opts = getScannerModelOptions();
  assert.ok(opts.length >= SCANNER_VENDORS.length);
  for (const o of opts) {
    assert.ok(o.brand.length > 0);
    assert.ok(o.model.length > 0);
    assert.ok(o.profile.suffix);
    assert.ok(o.profile.timeoutMs > 0);
  }
});

test("profileFromBehavior：超時夾喺合法範圍", () => {
  const hi = profileFromBehavior({ suffix: "enter", timeoutMs: 9999 }, { id: "a", name: "A" });
  assert.equal(hi.timeoutMs, MAX_TIMEOUT_MS);
  const lo = profileFromBehavior({ suffix: "enter", timeoutMs: 1 }, { id: "b", name: "B" });
  assert.equal(lo.timeoutMs, MIN_TIMEOUT_MS);
  const mid = profileFromBehavior({ suffix: "tab", timeoutMs: 50 }, { id: "c", name: "C" });
  assert.equal(mid.timeoutMs, 50);
  assert.equal(mid.suffix, "tab");
  assert.equal(mid.source, "model-db");
});

test("defaultScannerProfile：安全預設（未做任何設定時用）", () => {
  const p = defaultScannerProfile();
  assert.equal(p.suffix, "enter");
  assert.equal(p.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(p.source, "manual");
});

test("describeSuffix：講人話，唔會露出枚舉值", () => {
  assert.equal(describeSuffix("enter"), "Enter");
  assert.equal(describeSuffix("tab"), "Tab");
  assert.ok(describeSuffix("none").includes("無"));
  assert.ok(describeSuffix("mixed").includes("唔一致"));
});

test("SCANNER_BEHAVIOR_PRESETS：id 唯一、都有名", () => {
  const ids = SCANNER_BEHAVIOR_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of SCANNER_BEHAVIOR_PRESETS) assert.ok(p.name.length > 0);
});
