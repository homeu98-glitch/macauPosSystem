import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 《收銀台版本過期橫幅》回歸守衛（2026-09-22）。
 *
 * 呢個橫幅有兩個相反方向嘅風險：
 *   · **冇掛上去** ⇒ 商家永遠唔知自己跑舊版（今次問題嘅根源）。
 *   · **自動 reload** ⇒ 收銀落單／結帳中途 reload ＝ 災難（本專案明確禁用）。
 *
 * ⚠️ 掃 `.tsx` 前一定要剝註釋行（自己嘅解釋性註釋會引用同樣嘅字串）。
 */
function stripCommentLines(src: string): string {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const POS_APP = stripCommentLines(
  readFileSync(new URL("./pos-app.tsx", import.meta.url), "utf8"),
);
const BANNER_RAW = readFileSync(new URL("./build-stale-banner.tsx", import.meta.url), "utf8");
const BANNER = stripCommentLines(BANNER_RAW);

describe("收銀台 ── 版本過期橫幅", () => {
  it("🔴 一定要掛喺 pos-app（唔掛＝商家永遠唔知跑舊版）", () => {
    assert.ok(
      /import \{ BuildStaleBanner \} from "@\/components\/build-stale-banner";/.test(POS_APP),
      "冇 import 橫幅",
    );
    assert.ok(/<BuildStaleBanner/.test(POS_APP), "冇 render 橫幅");
    for (const prop of ["cartItemCount={cartItems.length}", "settlementOpen={Boolean(payingOrderId)}"]) {
      assert.ok(POS_APP.includes(prop), `冇傳 ${prop} ⇒ 一鍵重載保護會失效`);
    }
  });

  it("🔴 橫幅一定唔可以自己自動 reload（只可以人手撳）", () => {
    // 只准出現喺 onClick 之內
    const autoPatterns = [/if \(mismatch\)[^;]{0,200}location\.reload/, /useEffect\([^)]{0,400}reload/];
    for (const re of autoPatterns) {
      assert.ok(!re.test(BANNER), `發現疑似自動 reload：${re}`);
    }
    assert.ok(
      /onClick=\{\(\) => window\.location\.reload\(\)\}/.test(BANNER),
      "冇人手撳嘅重載入口",
    );
    assert.ok(/onClick=\{requestReload\}/.test(BANNER), "主掣冇經 requestReload（確認流程會被繞過）");
  });

  it("🔴 `requestReload()` 一定要先問 `risk.needsConfirm`", () => {
    const i = BANNER.indexOf("function requestReload()");
    assert.ok(i > 0, "搵唔到 requestReload");
    const body = BANNER.slice(i, i + 260);
    assert.ok(/if \(!risk\.needsConfirm\) \{/.test(body), "冇按 risk 分流");
    assert.ok(/setConfirming\(true\)/.test(body), "有未完成工作但冇出確認");
  });

  it("🔴 橫幅唔顯示時要 return null（唔可以留空白條佔位）", () => {
    assert.ok(/if \(!mismatch\) return null;/.test(BANNER), "冇早退");
  });

  it("🔴 按鈕要守 40px 觸控準則", () => {
    const hits = BANNER.match(/min-h-\[40px\]/g) ?? [];
    assert.ok(hits.length >= 3, `三個掣（重載／確認／取消）都要 min-h-[40px]，實際 ${hits.length}`);
  });

  it("🔴 pos-app 嘅 flex 容器要跟住改（否則橫幅會令內容被裁切）", () => {
    assert.ok(
      /className="flex h-\[100dvh\] flex-col overflow-hidden md:pl-\[72px\]"/.test(POS_APP),
      "外層冇改成 flex-col ⇒ 橫幅會同內容並排",
    );
    // 兩個分支嘅根都要由 `h-[100dvh]` 改成 `min-h-0`（唔係就會超出父容器而被 overflow-hidden 裁切）
    assert.ok(
      !/grid h-\[100dvh\] flex-1 grid-cols-1 overflow-hidden/.test(POS_APP),
      "桌台分支仲係 h-[100dvh] ⇒ 底部會被裁切",
    );
    assert.ok(
      !/flex h-\[100dvh\] flex-1 flex-col overflow-hidden/.test(POS_APP),
      "快餐分支仲係 h-[100dvh] ⇒ 底部會被裁切",
    );
  });
});
