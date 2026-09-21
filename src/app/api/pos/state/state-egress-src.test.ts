import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 《`/api/pos/state` 呼叫來源標記》守衛（2026-09-21）。
 *
 * ## 為何要守住
 *
 * `/api/pos/state` 係本專案最大嘅 egress 來源（單次 **424 KB**）。2026-09-21 實測到
 * **每 4.49 秒一次、單段連續 435 秒**嘅全量拉取爆發，但四個呼叫點
 * （mount／`queue` 依賴效應／realtime 重連補拉／手動更新）喺 Supabase log 入面
 * **完全分唔出** —— 結果只能靠推論，冇辦法一刀切死。
 *
 * 加咗 `x-pos-state-src` 標頭之後，Vercel log 會直接印：
 *
 * ```
 * [egress] pos/state bytes=424181 mode=full src=queue-dep orders=200 queue=0 …
 * ```
 *
 * ## 呢個守衛防咩
 *
 * ① 有人「順手清理」以為冇用嘅 header 讀取 ⇒ 下次再爆又變返冇辦法定位。
 * ② `src` 冇落 `[egress]` log（讀咗但唔用 = 白做）。
 * ③ 冇做長度截斷 ⇒ 有人用呢個欄位塞大字串膨脹 log（同 header 注入同型）。
 *
 * ⚠️ 呢個標記**唔可以**參與任何查詢、授權或回應內容 —— 否則就唔再係零行為改動。
 */
const SRC = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

describe("/api/pos/state ── 呼叫來源標記", () => {
  it("有讀 `x-pos-state-src` 標頭", () => {
    assert.ok(
      /request\.headers\.get\("x-pos-state-src"\)/.test(SRC),
      "冇讀來源標頭 ⇒ client 報咩都冇用",
    );
  });

  it("🔴 `src` 一定要落 `[egress]` log（讀咗唔用＝白做）", () => {
    assert.ok(/src:\s*stateSrc/.test(SRC), "`src` 冇傳落 jsonWithEgressLog 嘅 extra");
  });

  it("有長度截斷（防止有人用標頭塞大字串膨脹 log）", () => {
    // ⚠️ 要用**程式碼**嗰個 anchor，唔可以用第一個 `x-pos-state-src` ——
    // 頂部解釋註釋都寫咗呢個字串（掃 source 嘅老問題）。
    const at = SRC.indexOf('request.headers.get("x-pos-state-src")');
    assert.ok(at > 0, "搵唔到讀標頭嗰句");
    const line = SRC.slice(at, SRC.indexOf(";", at) + 1);
    assert.ok(
      /\.slice\(0,\s*\d+\)/.test(line),
      `冇 slice ⇒ log 會被撐爆：${line.trim()}`,
    );
  });

  it("🔴 標記只可以入 log，唔可以影響回應（唔可以出現喺 payload）", () => {
    const extraAt = SRC.indexOf("src: stateSrc");
    assert.ok(extraAt > 0);
    // `src: stateSrc` 必須喺 jsonWithEgressLog 嘅 extra 物件內，而唔係 payload 內。
    const egressCallAt = SRC.indexOf('"pos/state",');
    assert.ok(
      egressCallAt > 0 && egressCallAt < extraAt,
      "`src` 出現喺 payload 之前/之外 ⇒ 有機會漏落回應，破壞 API 契約",
    );
    // 回應 payload 嘅第一層 key 清單要保持原樣。
    for (const key of ["ok:", "source:", "orders:", "queue:", "printJobs:", "deviceConfig:"]) {
      assert.ok(SRC.includes(key), `回應少了既有欄位 ${key}`);
    }
  });

  it("🔴 舊版 bundle 偵測：判準一定要「非 ordersOnly 且冇 skipQueue」", () => {
    assert.ok(
      /const isLegacyFullState = !ordersOnly && !skipQueue;/.test(SRC),
      "判準唔見咗或者改錯 ⇒ 一係偵測唔到舊分頁、一係每次開報表都出假警報",
    );
    assert.ok(
      /rateLimit\(`pos-state-legacy:\$\{ip\}`, 1, 60_000\)/.test(SRC),
      "冇做每分鐘 1 條嘅限流 ⇒ 舊 client 每分鐘 13 次會灌爆 log",
    );
  });

  it("`legacy` 一定有落 egress log（否則加咗偵測但睇唔到）", () => {
    assert.ok(/legacy:\s*isLegacyFullState \? 1 : 0/.test(SRC), "`legacy` 冇入 egress extra");
  });

  it("偵測段落只可以係 console.warn（唔可以 throw / 唔可以改回應）", () => {
    const i = SRC.indexOf("const isLegacyFullState =");
    assert.ok(i > 0);
    const block = SRC.slice(i, i + 420);
    assert.ok(/console\.warn\(/.test(block), "應該只 log warn");
    assert.ok(!/throw|return NextResponse/.test(block), "偵測段落唔可以 throw 或者提早 return");
  });
});
