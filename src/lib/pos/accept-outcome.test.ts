import assert from "node:assert/strict";
import { test } from "node:test";

// ⚠️ 一定要用**相對路徑 + .ts 副檔名**：`node --test` 用 Node 內建 type-stripping，
// 唔識 tsconfig 嘅 `@/` path alias（會 ERR_MODULE_NOT_FOUND）。
// 呢個模組刻意零 runtime 依賴（單號由 caller 傳字串），所以可以直接載入。
import {
  acceptFailed,
  acceptOk,
  autoAcceptToast,
  kitchenHintText,
  type AcceptOutcome,
} from "./accept-outcome.ts";

/**
 * 接單結果 → 提示文案嘅唯一口徑（2026-09-14 J 實案：取餐碼 005）。
 *
 * 鎖死嘅鐵律：
 *   1. **自動接單唔准靜默** —— 0 張廚房 job 一定要出 warning（唯一例外：餘額不足，
 *      嗰個路徑本身會開 fallback 彈窗）；
 *   2. 出紙失敗要 error；「已出過紙」同「設定冇出」唔可以混為一談；
 *   3. 人手接單嘅後綴文字三分支（送咗廚／已出過／未出）。
 */

const CODE = "取餐碼 005";

/**
 * 把 `{ph}` 佔位符用 `vars` 填返（同 `interpolate()` 同一語義，但零 import）。
 * 用嚟證明「key + vars」真係砌得返原本嗰句 —— 即係翻譯唔會漏咗個單號。
 */
function fill(template: string, vars?: Record<string, string | number>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name: string) =>
    vars && name in vars ? String(vars[name]) : whole,
  );
}

/** 🔴 鐵律：`message` 一定要係**字典 key**，動態值只可以行 `vars`。 */
function assertKeyIsTranslatable(payload: { message: string; vars?: Record<string, string | number> }) {
  const names = [...payload.message.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]);
  for (const name of names) {
    assert.ok(
      payload.vars && name in payload.vars,
      `message 有 {${name}} 但 vars 冇提供 → 顯示位會出字面 "{${name}}"`,
    );
  }
  // 動態值唔可以砌入 key（砌入去字典永遠命中唔到 → 英文版彈中文）。
  assert.doesNotMatch(payload.message, /取餐碼 005/, "單號唔可以砌入 key，要放 vars");
}

test("🔴 核心：自動接單 0 張廚房 job 唔准靜默（要 warning，唔可以 null）", () => {
  const payload = autoAcceptToast(CODE, acceptOk(0));
  assert.ok(payload, "0 job 一定要有提示");
  assert.equal(payload!.tone, "warning");
  assert.match(payload!.message, /未出廚房單/);
  assertKeyIsTranslatable(payload!);
  assert.match(fill(payload!.message, payload!.vars), /取餐碼 005/);
});

test("自動接單成功送廚 → success", () => {
  const payload = autoAcceptToast(CODE, acceptOk(2));
  assert.equal(payload?.tone, "success");
  assert.match(payload!.message, /已送廚/);
  assertKeyIsTranslatable(payload!);
  assert.match(fill(payload!.message, payload!.vars), /取餐碼 005/);
});

test("自動接單「已出過紙」→ info（唔可以講成「未出廚房單」）", () => {
  const payload = autoAcceptToast(CODE, acceptOk(0, true));
  assert.equal(payload?.tone, "info");
  assert.match(payload!.message, /已出過廚房單/);
  assert.doesNotMatch(payload!.message, /請檢查打印開關/);
  assertKeyIsTranslatable(payload!);
});

test("自動接單：出紙步驟失敗 → error，並帶出底層原因", () => {
  const payload = autoAcceptToast(CODE, acceptFailed("kitchen", "未配任何已啟用嘅廚房打印機"));
  assert.equal(payload?.tone, "error");
  assert.match(payload!.message, /廚房單建立失敗/);
  assertKeyIsTranslatable(payload!);
  // 底層原因係動態字串 → 只可以經 `vars.suffix` 出現。
  assert.match(fill(payload!.message, payload!.vars), /未配任何已啟用嘅廚房打印機/);
});

test("自動接單：接單本身失敗 → error", () => {
  const payload = autoAcceptToast(CODE, acceptFailed("accept", "network error"));
  assert.equal(payload?.tone, "error");
  assert.match(payload!.message, /自動接單失敗/);
  assertKeyIsTranslatable(payload!);
});

test("唯一唔彈提示嘅情況：餘額不足（fallback 彈窗會處理）", () => {
  assert.equal(autoAcceptToast(CODE, acceptFailed("insufficient_balance", "餘額不足")), null);
  // 就算同時 0 job 都唔應該彈（避免搶 fallback 彈窗嘅注意力）。
  const outcome: AcceptOutcome = { ...acceptFailed("insufficient_balance"), kitchenJobCount: 0 };
  assert.equal(autoAcceptToast(CODE, outcome), null);
});

test("人手接單後綴：三種情況必須分得清（唔可以一律講未出廚房單）", () => {
  assert.equal(kitchenHintText(acceptOk(1)), "並已送廚");
  assert.equal(kitchenHintText(acceptOk(0, true)), "（此單已出過廚房單，唔會重複印）");
  assert.equal(kitchenHintText(acceptOk(0)), "（按打印設定未出廚房單）");
  // 已經出過紙但今次冇再出（採納重複跑）→ 唔可以當「設定熄咗」。
  assert.equal(kitchenHintText(acceptOk(0, true)), "（此單已出過廚房單，唔會重複印）");
});
