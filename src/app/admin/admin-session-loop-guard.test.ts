import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 《admin 後台登入迴圈》守衛（2026-11-03 事故後加）。
 *
 * ## 事故
 *
 * Vercel 免費額度一夜之間被 **810K CDN Requests** 打爆（1,011,747 / 1,000,000，
 * 帳號 24 小時後被 pause）。Observability 見到 5 條路徑**每個 68K、完全 1:1:1:1:1**：
 *
 * ```
 * /admin  /admin/dashboard  /api/admin/me  /api/admin/merchants  /api/admin/orders
 * ```
 *
 * 即係同一個迴圈，每輪 5 個請求（2 個 RSC + 3 個 401 API），約 1.9 輪/秒。
 *
 * ## 成因（三個地方各自用唔同口徑判斷「登入咗未」）
 *
 * 1. `app/admin/page.tsx` —— 只睇 `adminSessionToken` **存在**就跳 dashboard（冇驗 exp）。
 * 2. `components/admin-shell.tsx` —— 見到過期就跳返 `/admin`，但**冇清走張票**。
 * 3. `app/admin/dashboard/page.tsx` —— 3 個 fetch 喺 shell 之外，mount 即打 401。
 *
 * ⇒ dashboard →（過期）→ `/admin` →（見到票當已登入）→ dashboard → … 永不停止。
 *
 * ## 為何要「手寫源碼掃描」守衛
 *
 * 呢個 bug 完全合法：tsc 過、eslint 過、build 過、人手點一次都正常
 * （因為要**等到 token 過期**、而個 tab 又留住先會觸發）。
 * 唯一防得住嘅方法，就係釘死「判斷登入狀態只准用一個函式」呢條契約。
 */
const HERE = new URL(".", import.meta.url);
const LOGIN_PAGE = readFileSync(new URL("./page.tsx", HERE), "utf8");
const SHELL = readFileSync(new URL("../../components/admin-shell.tsx", HERE), "utf8");
const DASHBOARD = readFileSync(new URL("./dashboard/page.tsx", HERE), "utf8");
const GUARD = readFileSync(new URL("../../lib/admin-session-guard-client.ts", HERE), "utf8");

/** 由某個 marker 向前搵一段窗口，斷言裡面有指定內容。 */
function windowBefore(source: string, marker: string, size = 900): string {
  const index = source.indexOf(marker);
  assert.ok(index >= 0, `搵唔到 marker：${marker}`);
  return source.slice(Math.max(0, index - size), index);
}

describe("admin 登入迴圈 ── 單一真源契約", () => {
  it("🔴 登入頁唔准「見到票就當登入」，一定要驗 expiry", () => {
    assert.ok(
      LOGIN_PAGE.includes("readAdminSessionState().valid"),
      "登入頁冇驗 expiry ⇒ 過期票會被當成已登入，同 AdminShell 互相跳",
    );
    assert.ok(
      !/session\?\.adminSessionToken\s*\)\s*\{\s*router\.replace\("\/admin\/dashboard"\)/.test(LOGIN_PAGE),
      "登入頁仍然用「token 存在」做跳轉條件 ⇒ 迴圈會復發（2026-11-03 事故）",
    );
  });

  it("🔴 登入頁發現票無效時一定要清走（判斷同清理唔可以分家）", () => {
    assert.ok(
      LOGIN_PAGE.includes("clearAdminSessionIfInvalid()"),
      "冇清票 ⇒ AdminShell 跳返嚟之後又會見到同一張過期票",
    );
  });

  it("🔴 AdminShell 過期分支：清票一定要喺跳轉之前", () => {
    assert.ok(
      /clearAdminSessionToken\(\);[\s\S]{0,200}router\.replace\("\/admin"\)/.test(SHELL),
      "過期分支冇先 `clearAdminSessionToken()` ⇒ 過期票留低 ⇒ `/admin` 又跳返 dashboard",
    );
  });

  it("🔴 AdminShell 收到 401 一定要強制清（唔可以靠 expiry 判斷）", () => {
    const branch = SHELL.slice(SHELL.indexOf("res.status === 401"));
    assert.ok(
      branch.includes("clearAdminSessionToken()"),
      "401 只行 `clearAdminSessionIfInvalid()` 唔夠：本地睇落未過期但 server 拒收時清唔到，又會迴圈",
    );
  });

  it("🔴 自動跳轉（過期／401）唔可以用 `clearAuthSession()`（會連 POS 收銀 session 一齊殺）", () => {
    // 只驗「自動踢走」兩條分支；`handleLogout()` 係用戶主動登出，清整個 session 係預期行為。
    const expiryBranch = SHELL.slice(
      SHELL.indexOf("if (!claims || isAdminSessionTokenExpired(claims))"),
      SHELL.indexOf("setAccount("),
    );
    const unauthorizedBranch = SHELL.slice(
      SHELL.indexOf("res.status === 401"),
      SHELL.indexOf("if (!res.ok || !json.ok)"),
    );
    for (const [label, branch] of [
      ["過期分支", expiryBranch],
      ["401 分支", unauthorizedBranch],
    ] as const) {
      assert.ok(branch.length > 0, `搵唔到${label}（測試本身要更新）`);
      // 用「有分號嘅呼叫」判斷，避免註釋入面提到 `clearAuthSession()` 就誤報。
      assert.ok(
        !/clearAuthSession\(\)\s*;/.test(branch),
        `${label}用 clearAuthSession() ⇒ 同一部機嘅收銀員被無辜踢走`,
      );
    }
  });

  it("🔴 dashboard 三個 fetch 之前一定要有 guard（憑證無效就一個請求都唔打）", () => {
    for (const marker of ['fetch("/api/admin/merchants"', 'fetch("/api/admin/me"', "fetch(`/api/admin/orders?"]) {
      const before = windowBefore(DASHBOARD, marker);
      assert.ok(
        before.includes("readAdminSessionState()"),
        `${marker} 之前冇 gate ⇒ token 過期時每輪照打 401（正是 810K 事故）`,
      );
      assert.ok(
        before.includes("!admin.valid"),
        `${marker} 之前冇 fail-closed 判斷（!admin.valid）`,
      );
    }
  });

  it("🔴 dashboard 唔准再自己讀 `loadAuthSession()?.adminSessionToken`（繞過 guard）", () => {
    assert.ok(
      !DASHBOARD.includes("adminSessionToken"),
      "頁面直接讀 token 就會再次出現「各處口徑唔同」嘅迴圈",
    );
  });

  it("guard 模組：無效 + 有票 ⇒ 一定要呼叫 `clearAdminSessionToken()`", () => {
    assert.ok(
      /if \(state\.valid\) return false;[\s\S]{0,200}clearAdminSessionToken\(\)/.test(GUARD),
      "guard 只判斷唔清理 ⇒ 對面頁面仍然見到過期票",
    );
  });
});
