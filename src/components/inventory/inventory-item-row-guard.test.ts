import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * 《收據 modal 品項 row 寬度》守衛（2026-09-25 實案：品名欄被壓到 0 寬）。
 *
 * ## 背景
 *
 * `inventory-view.tsx` 嘅 `fieldCls` 本身內含 `w-full`，而品項 row 以前寫
 * `` className={`${fieldCls} w-28`} `` —— 同一個元素同時有 `w-full` 同 `w-28`，
 * 邊個生效**取決於 Tailwind 產生 CSS 嘅先後，而唔係 attribute 順序**。
 * 本專案實測（Tailwind v4 / @tailwindcss/postcss）：
 *   idx w-20 = 4641 < idx w-28 = 4693 < **idx w-full = 4745** ⇒ `w-full` 勝出。
 *
 * 結果：單價／數量兩個 input 嘅 flex-basis 變 100%，`flex-1`（basis 0）嘅品名欄
 * shrink 分唔到、grow 又冇剩餘空間 ⇒ **實際寬度 0** ⇒ 睇唔到、撳唔到、打唔到字。
 *
 * ## 呢個檔守三件事
 * 1. 全 repo 唔准再出現「`${…Cls} w-<number>`」呢種寫法（cascade 地雷）。
 * 2. 品項 row 一定要用 grid 固定軌寬（每格入面 `w-full` = 軌寬，唔會互相搶位）。
 * 3. 供應商欄一定要係 select + `merchant_id`（唔可以再用 datalist 反推收據）。
 *
 * ⚠️ 掃原始碼前一定要剝註釋 —— 呢個檔自己嘅註解就提及 `${fieldCls} w-28`，
 *    唔剝會自己撞自己（本專案中過最少兩次，見 build-header-contract.test.ts）。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** repo 根（呢個檔喺 `src/components/inventory/`）。 */
const ROOT = path.resolve(HERE, "..", "..", "..");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function read(rel: string): string {
  return stripComments(readFileSync(path.join(ROOT, rel), "utf8"));
}

const VIEW = "src/components/inventory/inventory-view.tsx";

describe("品項 row：唔可以再出現 w-full 同 w-<number> 打架", () => {
  it("庫存頁原始碼唔可以有 `${…Cls} w-<number>` 寫法", () => {
    const src = read(VIEW);
    // 例如 `${fieldCls} w-28` / `${fieldCls} w-20`
    const bad = /\$\{[^}]*[Cc]ls\}\s+w-\d/.test(src);
    assert.equal(bad, false, "發現 `${…Cls} w-<number>`：w-full 會壓過 w-<number>（cascade 地雷）");
  });

  it("品項 row 一律用 grid 固定軌寬（flex + 百分比 basis 會搶位）", () => {
    const src = read(VIEW);
    assert.ok(
      /sm:grid-cols-\[minmax\(0,1fr\)_7rem_5rem_auto\]/.test(src),
      "品項 row 要係 sm:grid-cols-[minmax(0,1fr)_7rem_5rem_auto]",
    );
    assert.ok(/col-span-2 min-w-0 sm:col-span-1/.test(src), "品名欄窄螢幕要佔一整行");
  });

  it("品名／單價／數量三個 input 都要有 aria-label（冇 placeholder 當 label 用）", () => {
    const src = read(VIEW);
    assert.equal((src.match(/aria-label=\{`第 \$\{i \+ 1\} 項/g) ?? []).length, 3);
  });
});

describe("供應商欄：下拉選單 + merchant_id", () => {
  it("唔可以再用 datalist 反推收據入面嘅供應商", () => {
    const src = read(VIEW);
    assert.equal(/<datalist/.test(src), false, "datalist 應已由 select（讀 merchants 表）取代");
    assert.equal(/supplier-list/.test(src), false);
  });

  it("收據 payload 要帶 merchant_id（server 直接用 ⇒ 唔行 upsert ⇒ 唔會撞 unique）", () => {
    const src = read(VIEW);
    assert.ok(/merchant_id: form\.merchant_id \|\| undefined/.test(src));
    assert.ok(/merchant_name: form\.merchant_name\.trim\(\) \|\| undefined/.test(src));
  });

  it("供應商清單要由 GET /api/inventory/merchants 讀全量（唔受 range 篩選影響）", () => {
    const src = read(VIEW);
    assert.ok(/\/api\/inventory\/merchants\?account=/.test(src));
    assert.equal(
      /const suppliers = useMemo\(\(\) => \{[\s\S]*?receipts/.test(src),
      false,
      "供應商唔可以再由 receipts 反推（冇收據嘅供應商會消失）",
    );
  });
});

describe("merchants API：duplicate key 要轉做中文明確提示", () => {
  it("POST 要捕捉 23505 / 42P10，並區分 ALREADY_EXISTS 同 NAME_TAKEN", () => {
    const src = read("src/app/api/inventory/merchants/route.ts");
    assert.ok(/ALREADY_EXISTS/.test(src));
    assert.ok(/NAME_TAKEN/.test(src));
    assert.ok(/23505/.test(src) && /42P10/.test(src));
  });

  it("NAME_TAKEN（跨店同名）唔可以回傳嗰個 supplier id（唔畀掛起第二間店）", () => {
    const src = read("src/app/api/inventory/merchants/route.ts");
    const nameTakenBlock = /code: "NAME_TAKEN"[\s\S]{0,400}/.exec(src)?.[0] ?? "";
    assert.ok(nameTakenBlock.length > 0, "搵唔到 NAME_TAKEN 分支");
    assert.equal(/merchant:/.test(nameTakenBlock), false, "NAME_TAKEN 唔可以帶 merchant id");
  });

  it("要有 GET（全量供應商）先至有 dropdown 資料來源", () => {
    const src = read("src/app/api/inventory/merchants/route.ts");
    assert.ok(/export async function GET/.test(src));
    assert.ok(/eq\("user_id", resolved\.userId\)/.test(src), "GET 一定要以 user_id 做店別 scope");
  });
});
