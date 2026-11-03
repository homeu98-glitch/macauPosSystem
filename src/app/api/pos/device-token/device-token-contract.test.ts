import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 《POS 終端憑證續期》契約守衛（2026-11-03）。
 *
 * ## 事故
 *
 * 每個早上 Vercel log 都係滿屏 `[pos/device-token] 讀取 merchant_staff 失敗: JWT expired`，
 * 每部機每 30 秒一次。收銀員零提示，單全部留喺本機 outbox 上唔到雲。
 *
 * 三個缺陷同時存在（缺一都唔會咁「靜」）：
 *
 * 1. **client 唔會真正續期**：`decideLedgerSessionAction()` 對「開頁時 client 未有 session」
 *    一律落 `bootstrap`，拿**已過期**嘅 access token 去 `setSession()` ⇒ 必敗。
 * 2. **server 換完票但用返舊 client**：`createLedgerServerClient()` 把
 *    `Authorization: Bearer <舊票>` 釘死喺 `global.headers`，`setSession()` 只更新
 *    `client.auth`，唔會改呢個 header ⇒ `merchant_staff` 查詢永遠帶過期票。
 * 3. **錯誤碼分唔到終態**：route 一律回 503 ⇒ client 當「臨時故障」，無限重試。
 *
 * ## 為何要源碼掃描
 *
 * 全部係「邏輯契約」：tsc／eslint／build 全過，只有真實 token 過期才會爆。
 * 而且爆嘅時候症狀係「靜默」（唔當機、唔白屏），最難被發現。
 */
const HERE = new URL(".", import.meta.url);
const ROUTE = readFileSync(new URL("./route.ts", HERE), "utf8");
const SERVER_AUTH = readFileSync(
  new URL("../../../../lib/ledger/supabase-server-auth.ts", HERE),
  "utf8",
);
const CLIENT_AUTH = readFileSync(new URL("../../../../lib/pos/pos-sync-auth.ts", HERE), "utf8");
const DECISION = readFileSync(
  new URL("../../../../lib/ledger/ledger-session-decision.ts", HERE),
  "utf8",
);

describe("device-token ── 終態要講清楚（唔可以扮臨時故障）", () => {
  it("401 回應一定要帶 `code: \"session_expired\"`", () => {
    assert.ok(
      ROUTE.includes('code: "session_expired"'),
      "冇 code ⇒ client 分唔到「票死」同「server 一時故障」，只會無限重試",
    );
    assert.ok(
      /code: "session_expired"[\s\S]{0,120}status: 401/.test(ROUTE),
      "要有 401（唔係 503）—— 503 會被當成可重試",
    );
  });

  it("merchant_staff 讀取失敗要分辨 JWT 類錯誤（唔可以一律 503）", () => {
    assert.ok(
      /isJwtRejected\(/.test(ROUTE),
      "冇分辨 JWT 錯誤 ⇒ `JWT expired` 會繼續回 503 ⇒ 又是無限重試",
    );
  });
});

describe("supabase-server-auth ── 換票後一定要用新票建 client", () => {
  it("刷新成功後要重新 `createLedgerServerClient(fresh)`", () => {
    assert.ok(
      /createLedgerServerClient\(\s*fresh\s*\)/.test(SERVER_AUTH),
      "換完票仍然用舊 client ⇒ `global.headers.Authorization` 係過期票 ⇒ merchant_staff 永遠 JWT expired",
    );
  });

  it("唔准再出現「setSession 之後直接 return 原 client」", () => {
    assert.ok(
      !/if \(error\) return client;/.test(SERVER_AUTH),
      "舊寫法（error 就 return 原 client）代表成功路徑照用舊票",
    );
  });
});

describe("pos-sync-auth ── 失敗要煞停，唔可以每 30 秒重試", () => {
  it("POST 之前一定要先續 Ledger 會話", () => {
    const beforePost = CLIENT_AUTH.slice(
      CLIENT_AUTH.indexOf("export async function refreshPosDeviceTokenIfNeeded"),
    );
    assert.ok(
      beforePost.includes("ensureLedgerSession("),
      "冇續期就拿過期票去換 POS 憑證 ⇒ 每個早上必死（今次事故根因）",
    );
  });

  it("401／session_expired 一定要落閂 + 出提示（唔係靜靜 return false）", () => {
    assert.ok(
      /res\.status === 401 \|\| payload\?\.code === "session_expired"/.test(CLIENT_AUTH),
      "冇認 401/code ⇒ 會當成普通失敗繼續重試",
    );
    assert.ok(
      CLIENT_AUTH.includes("latchSessionExpired("),
      "冇落閂 ⇒ 每個 caller 每 30 秒再打一次（實測 2,880 次/部/日）",
    );
  });

  it("閂要有冷卻時間，而且要識得「重新登入後自動解閂」", () => {
    assert.ok(
      /SESSION_DEAD_COOLDOWN_MS\s*=/.test(CLIENT_AUTH),
      "冇冷卻期 ⇒ 等於冇落閂",
    );
    assert.ok(
      /latchedLedgerToken !== currentLedgerToken\(\)/.test(CLIENT_AUTH),
      "冇比對新票 ⇒ 重新登入後仍然被閂 10 分鐘，收銀員會覺得「登入咗都冇用」",
    );
  });

  it("續期成功要清除「會話已死」旗標（否則橫幅永遠唔消失）", () => {
    assert.ok(
      CLIENT_AUTH.includes("clearPosAuthExpired()"),
      "冇清旗標 ⇒ 收銀台橫幅一直掛住",
    );
  });
});

describe("ledger-session-decision ── 開頁遇到過期票要 refresh", () => {
  it("client 未有 session 時，唔可以無條件 bootstrap", () => {
    assert.ok(
      !/if \(!input\.clientAccessToken\) return \{ action: "bootstrap" \};/.test(DECISION),
      "無條件 bootstrap ⇒ 拿過期票去 setSession 必敗 ⇒ 全店當未登入（2026-11-03 根因）",
    );
    assert.ok(
      /if \(!input\.clientAccessToken\)[\s\S]{0,400}action: "refresh"/.test(DECISION),
      "client 未有 session 而 storage 已過期時要有 refresh 分支",
    );
  });
});
