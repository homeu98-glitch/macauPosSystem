import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  isDeliveryDispatchEnabled,
  isDeliveryLiveEnabled,
  isDeliveryOnlineEnabled,
} from "./flag.ts";

/**
 * 旗標讀取嘅**原始碼**守衛（2026-10-31 實案）。
 *
 * 病：`flag.ts` 原本寫成 `process.env[DELIVERY_DISPATCH_FLAG]`。
 * Next 用 DefinePlugin 做**字面文字替換**，動態 key 唔會被替換 ⇒ 瀏覽器永遠
 * `undefined` ⇒ 商家已經喺 Vercel 設好三個 env = 1，側欄「外送」仍然唔出。
 * 而且**冇任何錯誤**：API route（server）讀得到，只有前端靜靜當 false ——
 * 呢種「一半work」最難查。
 *
 * 所以用靜態掃描釘死：一定要有 `process.env.NEXT_PUBLIC_<NAME>` 字面量，
 * 而且唔准出現 `process.env[`。
 */

function stripComments(code: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return code
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1 + " ".repeat(200));
}

const SOURCE = stripComments(readFileSync(new URL("./flag.ts", import.meta.url), "utf8"));

describe("flag.ts · 一定要字面讀 env（DefinePlugin 只替換字面量）", () => {
  for (const name of [
    "NEXT_PUBLIC_DELIVERY_DISPATCH",
    "NEXT_PUBLIC_DELIVERY_LIVE",
    "NEXT_PUBLIC_DELIVERY_ONLINE",
  ]) {
    it(`有 process.env.${name} 字面量`, () => {
      assert.ok(
        SOURCE.includes(`process.env.${name}`),
        `flag.ts 缺少 process.env.${name} 字面量 —— 用動態 key 讀會令 client 永遠 false`,
      );
    });
  }

  it("🔴 唔准出現 process.env[（動態 key 唔會被替換）", () => {
    assert.equal(
      /process\.env\s*\[/.test(SOURCE),
      false,
      "flag.ts 出現 process.env[...] —— Next DefinePlugin 唔會替換動態 key，瀏覽器會拿到 undefined",
    );
  });
});

describe("旗標行為（注入 env，唔靠 build-time）", () => {
  it("只有 '1' 才算開；其他一律關", () => {
    assert.equal(isDeliveryDispatchEnabled({ NEXT_PUBLIC_DELIVERY_DISPATCH: "1" }), true);
    assert.equal(isDeliveryDispatchEnabled({ NEXT_PUBLIC_DELIVERY_DISPATCH: " 1 " }), true);
    assert.equal(isDeliveryDispatchEnabled({ NEXT_PUBLIC_DELIVERY_DISPATCH: "0" }), false);
    assert.equal(isDeliveryDispatchEnabled({ NEXT_PUBLIC_DELIVERY_DISPATCH: "true" }), false);
    assert.equal(isDeliveryDispatchEnabled({}), false);
  });

  it("LIVE / ONLINE 各自獨立，唔會互相影響", () => {
    assert.equal(isDeliveryLiveEnabled({ NEXT_PUBLIC_DELIVERY_DISPATCH: "1" }), false);
    assert.equal(isDeliveryOnlineEnabled({ NEXT_PUBLIC_DELIVERY_LIVE: "1" }), false);
    assert.equal(isDeliveryLiveEnabled({ NEXT_PUBLIC_DELIVERY_LIVE: "1" }), true);
    assert.equal(isDeliveryOnlineEnabled({ NEXT_PUBLIC_DELIVERY_ONLINE: "1" }), true);
  });
});
