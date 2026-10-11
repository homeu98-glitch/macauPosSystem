import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 🔴 2026-10-11 實案守衛：iOS PWA 下單機枱卡顯示「空閒」但單其實喺雲端（第二部機正常）。
 *
 * 背景：枱卡綁單靠 `tableOrderMap.get(table.id)`，key = `order.tableId`。
 * iOS PWA 有**獨立 localStorage 分區**且唔會自動清，本機可以留住「同一枱名、舊 id」
 * 嘅枱（雲端已改版換 id）⇒ 舊卡永遠搵唔到單 → 客人枱「冇單但有單喺度」。
 *
 * ⚠️ 呢度守嘅係**行為不變量**（規則有實作 + 有自癒 + 有防重入），唔係守代碼字串，
 *    亦唔斷言「剛好 N 個」。`buildDisplayFloors` 本身 import 咗 `@/lib/**` alias，
 *    `node --test` 解析唔到，所以純邏輯由 `display-floors-guard.test.ts` 逐條驗；
 *    呢個檔負責守住「唔好將自癒邏輯刪走」同「唔好重新引入自動隔離」呢兩個方向。
 */
// ⚠️ repo 檔案係 CRLF ⇒ regex 前必須 `replace(/\r\n/g, "\n")`，否則跨行 pattern 全部中唔到。
const SRC = readFileSync(fileURLToPath(new URL("./display-floors.ts", import.meta.url)), "utf8").replace(
  /\r\n/g,
  "\n",
);
const POS_APP = readFileSync(
  fileURLToPath(new URL("../../components/pos-app.tsx", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");
const SW = readFileSync(fileURLToPath(new URL("../../../public/sw.js", import.meta.url)), "utf8").replace(
  /\r\n/g,
  "\n",
);
const PWA = readFileSync(
  fileURLToPath(new URL("../../components/pwa-register.tsx", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

test("display-floors：有實作「過期本機枱」判定（同名 + 同 area + id 不同）", () => {
  assert.ok(SRC.includes("staleLocalIds"), "buildDisplayFloors 必須計 staleLocalIds");
  assert.ok(
    /bootstrapIds\.has\(t\.id\)\)\s*continue/.test(SRC),
    "必須先跳過 bootstrap 已有嘅枱（id 存在性由 bootstrap 話事）",
  );
  // 同名 + 同 area + id 不同 = 過期殘留；缺咗 area 對照就會誤殺「一樓 A01／二樓 A01」
  assert.ok(
    /\(bt\.name \?\? ""\)\.trim\(\) === \(t\.name \?\? ""\)\.trim\(\)/.test(SRC),
    "過期判定必須比對枱名",
  );
  assert.ok(
    /\(bt\.area \?\? ""\)\.trim\(\) === area/.test(SRC),
    "過期判定必須同時比對 area（否則會誤殺跨區同名枱）",
  );
  // 舊本機枱一定要被 filter 走，唔可以再 push 入結果
  assert.ok(
    /if \(staleLocalIds\.has\(t\.id\)\) continue;/.test(SRC),
    "overlay loop 必須 skip 過期本機枱",
  );
});

test("pos-app：有「有單但本機搵唔到枱 → 自動重拉雲端枱配置」自癒", () => {
  assert.ok(POS_APP.includes("orphanTableSigRef"), "必須有 orphanTableSigRef 防重入");
  assert.ok(
    /knownTableIds\.has\(o\.tableId\)/.test(POS_APP),
    "自癒觸發條件 = 有未結帳單嘅 tableId 唔喺本機枱清單",
  );
  assert.ok(
    /void refreshBootstrapFromServer\(\{ quiet: true \}\)/.test(POS_APP),
    "自癒動作必須係重拉雲端 bootstrap",
  );
  assert.ok(
    /const tableOrderMap = useMemo/.test(POS_APP) && POS_APP.includes("[order.tableId, order]"),
    "枱卡依然靠 tableId 綁單（自癒係補枱配置，唔係改綁定規則）",
  );
});

test("pos-app：唔可以重新引入自動隔離（本機訂單一律保留到上雲）", () => {
  // 2026-09-22 已停用；2026-10-11 呢個 bug 唔係隔離（單仍喺 orders 列表）
  assert.ok(
    !/quarantineOrders\(|restoreAllQuarantinedOrders\(/.test(
      POS_APP.slice(POS_APP.indexOf("const tableOrderMap = useMemo")),
    ),
    "枱卡渲染路徑唔可以再自動隔離本機訂單",
  );
});

test("sw.js：cache 名帶 build id，唔可以再寫死版本號", () => {
  assert.ok(/searchParams\.get\("v"\)/.test(SW), "SW 必須由 query string 讀 build id");
  assert.ok(/const CACHE_NAME = `macau-pos-v20-\$\{BUILD_ID\}`/.test(SW), "cache 名要帶 build id");
  assert.ok(
    !/const CACHE_NAME = "macau-pos-v20-7-31"/.test(SW),
    "🔴 唔可以再寫死 cache 名（7-31 寫死版本係呢次 PWA 唔更新嘅病根）",
  );
});

test("sw.js：bundle／static 資源唔可以 cache-first（會令 PWA 長期跑舊程式碼）", () => {
  const fetchHandler = SW.slice(SW.indexOf('addEventListener("fetch"'));
  const cacheFirst = /caches\.match\(request\)\.then\(\(cached\) => \{\s*if \(cached\) return cached;/.test(
    fetchHandler,
  );
  assert.ok(!cacheFirst, "🔴 唔可以 cache-first（舊版會令部署咗新版本都仲跑舊 bundle）");
  assert.ok(
    /fetch\(request\)\s*\.then\(\(response\)/.test(fetchHandler),
    "要先 network-first，失敗先落 cache（bundle 檔名有 content hash，唔會蝕本）",
  );
});

test("pwa-register：註冊時帶 build id，並且會主動檢查更新", () => {
  assert.ok(/\/sw\.js\?v=/.test(PWA), "註冊 SW 必須帶 cache-busting query");
  assert.ok(/reg\?\.update\(\)/.test(PWA), "必須主動 reg.update()（PWA 唔會自動更新）");
  assert.ok(/visibilitychange/.test(PWA), "由背景返嚟要即刻查更新");
});
