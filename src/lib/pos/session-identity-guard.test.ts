import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 《POS 工作階段身分》不可回退約束守衛（2026-09-23）。
 *
 * ## 為咩要呢個檔
 *
 * `pos_sessions.account`（admin 頁「員工 / 裝置」欄）係**由 token claims 覆寫**嘅：
 *
 * ```
 * /api/pos/device-token 簽 account
 *   → deviceClaims.account
 *   → /api/pos/sync（60s 節流）／ /api/pos/state（5 分鐘節流）
 *   → touchPosSession()
 *   → session-registry-server.ts  `patch.account = input.account`   ← 無條件覆寫
 *   → pos_sessions.account
 * ```
 *
 * 🔴 2026-09-23 實案：`/api/pos/device-token` 硬編碼 `account: "ledger-session"`。
 * 症狀有**誤導性**：分頁登入時 `/api/ledger/login` 會用真電話 upsert，所以
 * 睇落一切正常；但憑證 TTL 12 小時 ⇒ 任何開超過一個班次嘅分頁，第一次續期之後
 * 「員工 / 裝置」就靜默變成 `ledger-session`、按電話搜尋亦搵唔返嗰行。
 * 三行生產數據剛好劃出 12 小時界線：存活 17h39m 嘅中招，存活 <30 分鐘嘅仍正常。
 *
 * ⚠️ 呢個係**審計欄位**（唔參與授權：授權靠 `storeId` ＋ HMAC 簽名 ＋ `exp` ＋ `role`），
 * 所以改壞唔會有人即刻發現 —— 正是需要用守衛釘住嘅原因。
 *
 * ## 🔴 呢個檔用 `node --test` 直接跑
 * 只可以 import node 內建模組（唔認 `@/` 別名、唔支援 `.tsx`）⇒ 一律讀原始碼做字串斷言。
 */

const SRC = new URL("../../", import.meta.url);

function readSrc(rel: string): string {
  return readFileSync(new URL(rel, SRC), "utf8");
}

/**
 * 剝走 TypeScript 註釋。
 *
 * 🔴 **必須**：本檔要斷言「原始碼冇 `ledger-session` 字面值」，但
 * `device-token/route.ts` 嘅解釋性註解**正正會提及**呢個字串。唔剝註釋就會自己撞自己，
 * 出現假失敗（`print-and-order-realtime-guard.test.ts` 已因此中過一次）。
 */
function stripTsComments(src: string): string {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

const DEVICE_TOKEN_ROUTE = "app/api/pos/device-token/route.ts";
const POS_DEVICE_TOKEN = "lib/pos/pos-device-token.ts";
const SESSION_REGISTRY = "lib/pos/session-registry-server.ts";

describe("POS 工作階段身分（account）不可回退約束", () => {
  describe("A. /api/pos/device-token 簽發嘅身分必須真實", () => {
    it("原始碼唔可以再出現佔位值 ledger-session", () => {
      const code = stripTsComments(readSrc(DEVICE_TOKEN_ROUTE));
      assert.ok(
        !code.includes("ledger-session"),
        "device-token route 唔可以用佔位身分：佢會經 touchPosSession() 覆寫 pos_sessions.account，" +
          "令 admin 頁「員工 / 裝置」由真電話變成寫死值（12 小時後靜默發生）。",
      );
    });

    it("必須由 Ledger Auth email 還原電話（Auth 驗證過嘅身分，唔係 client 自報）", () => {
      const code = stripTsComments(readSrc(DEVICE_TOKEN_ROUTE));
      assert.ok(
        code.includes("parsePhoneFromLedgerAuthEmail"),
        "device-token route 應該用 parsePhoneFromLedgerAuthEmail(user.email) 還原 8 位電話：" +
          "Ledger 登入用 ledgerAuthEmail(phone) 做 Auth email，所以 email 係權威來源。",
      );
    });

    it("issuePosDeviceToken() 唔可以直接寫死 account 字面值", () => {
      const code = stripTsComments(readSrc(DEVICE_TOKEN_ROUTE));
      assert.ok(
        !/issuePosDeviceToken\(\{[^}]*account:\s*"/.test(code),
        "account 唔可以傳字面值 —— 一定要由驗證過嘅身分推導（否則會覆寫 pos_sessions.account）。",
      );
    });
  });

  describe("B. 空 account 會令續期整體失效（所以要有兜底）", () => {
    it("verifyPosDeviceToken() 仍然拒收空 account（route 必須簽非空值）", () => {
      const code = stripTsComments(readSrc(POS_DEVICE_TOKEN));
      assert.ok(
        code.includes("!decoded.account"),
        "verifyPosDeviceToken() 拒收 account 為空嘅 token ⇒ 空值會令全店續期 401（比顯示錯更嚴重）。" +
          "若日後放寬呢個檢查，要同時覆核 device-token route 嘅兜底是否仍成立。",
      );
    });

    it("device-token route 有非空兜底（email 原文 → user id 前綴）", () => {
      const code = stripTsComments(readSrc(DEVICE_TOKEN_ROUTE));
      assert.ok(
        /parsePhoneFromLedgerAuthEmail\([^)]*\)\s*\|\|/.test(code),
        "單靠 parsePhoneFromLedgerAuthEmail() 唔夠：非電話格式嘅 email 會回空字串，" +
          "而空 account 會令續期失效。必須有 `|| email || uid:…` 之類嘅非空兜底。",
      );
    });
  });

  describe("C. touchPosSession 嘅覆寫語義（null 唔應該抹掉既有身分）", () => {
    it("只喺 input.account 有值時才覆寫 patch.account", () => {
      const code = stripTsComments(readSrc(SESSION_REGISTRY));
      assert.ok(
        code.includes("if (input.account) patch.account = input.account"),
        "覆寫 pos_sessions.account 必須有 `if (input.account)` 閘 —— 否則傳 null 會抹走登入時寫入嘅真身分。",
      );
    });
  });
});
