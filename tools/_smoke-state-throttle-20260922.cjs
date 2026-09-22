/**
 * 驗證 P0b「舊分頁節流」＋ P1/P3 增量（2026-09-22 覆核）。
 *
 * 呢條路**唔需要 Supabase**：節流判斷同空骨架回覆喺 `!supabase` 之前發生，
 * 所以本機 dev（mock 模式）就測得到。
 *
 * 用法：node tools/_smoke-state-throttle-20260922.cjs [port]
 */
const { spawn, execSync } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.argv[2]) || 3114;
const CWD = process.cwd();
const NODE = "C:/Users/surface/.workbuddy/binaries/node/versions/22.22.2-3/node.exe";
const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(p, headers) {
  return new Promise((resolve) => {
    const req = http.get({ host: "localhost", port: PORT, path: p, timeout: 120_000, headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ code: res.statusCode, text, headers: res.headers }));
    });
    req.on("error", (e) => resolve({ code: 0, err: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ code: 0, err: "timeout" });
    });
  });
}

(async () => {
  const env = {
    ...process.env,
    PATH: `${path.dirname(NODE)}${path.delimiter}${process.env.PATH}`,
    POS_REQUIRE_DEVICE_AUTH: "0",
    POS_EGRESS_LOG: "1",
  };
  const child = spawn(NODE, ["node_modules/next/dist/bin/next", "dev", "--port", String(PORT)], {
    cwd: CWD,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  const cleanup = () => {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  };

  const parse = (r) => {
    try {
      return JSON.parse(r.text);
    } catch {
      return null;
    }
  };
  const check = (label, ok, detail) => console.log(`${ok ? "✓" : "❌"} ${label}${detail ? "  " + detail : ""}`);

  try {
    let ready = false;
    for (let i = 0; i < 60; i += 1) {
      await sleep(2_500);
      if ((await get("/login")).code > 0) {
        ready = true;
        break;
      }
    }
    console.log("dev server ready:", ready);
    if (!ready) {
      console.log(log.slice(-2000));
      cleanup();
      process.exit(1);
    }

    // ① 舊版全量（冇 skipQueue）第一次 → 正常回覆（mock：orders []，但唔係 throttled）
    const a = await get(`/api/pos/state?storeId=${STORE}`);
    const pa = parse(a);
    check("① 舊版第 1 次：正常（唔係 throttled）", a.code === 200 && pa?.legacyThrottled !== true, `code=${a.code} legacyThrottled=${pa?.legacyThrottled}`);

    // ② 90 秒內第二次 → 空骨架 + incremental:true
    const b = await get(`/api/pos/state?storeId=${STORE}`);
    const pb = parse(b);
    check(
      "② 舊版第 2 次（90 秒內）：被節流 → 空骨架",
      pb?.legacyThrottled === true && Array.isArray(pb?.orders) && pb.orders.length === 0,
      `legacyThrottled=${pb?.legacyThrottled} orders=${pb?.orders?.length}`,
    );
    check(
      "🔴 空骨架一定要帶 incremental:true（否則客戶端會隔離全店未結單）",
      pb?.incremental === true,
      `incremental=${pb?.incremental}`,
    );
    check("   空骨架要有多個 guard 欄位", pb?.localSettings === null && pb?.deviceConfig === null && pb?.printTemplatesServer === null);

    // ③ 新 bundle（skipQueue=1）連打兩次 → 兩次都唔應該被節流
    const c1 = await get(`/api/pos/state?storeId=${STORE}&skipQueue=1`);
    const c2 = await get(`/api/pos/state?storeId=${STORE}&skipQueue=1`);
    const p2 = parse(c2);
    check(
      "③ 新 bundle（skipQueue=1）唔受節流影響",
      c1.code === 200 && c2.code === 200 && p2?.legacyThrottled !== true,
      `c1=${c1.code} c2=${c2.code} legacyThrottled=${p2?.legacyThrottled}`,
    );

    // ④ ordersOnly + since → 唔會爆（mock 路徑照回 ok）
    const d = await get(`/api/pos/state?storeId=${STORE}&ordersOnly=1&since=2026-09-22T00:00:00.000Z`);
    const pd = parse(d);
    check("④ ordersOnly + since 唔會爆", d.code === 200 && pd?.ok === true, `code=${d.code} ok=${pd?.ok}`);

    // ⑤ 報表式 ordersOnly（冇 since）照舊
    const e = await get(`/api/pos/state?storeId=${STORE}&ordersOnly=1&limit=2000`);
    const pe = parse(e);
    check("⑤ 報表式 ordersOnly（冇 since）照舊可用", e.code === 200 && pe?.ok === true, `code=${e.code}`);

    const compileErr = /Failed to compile|Module not found|SyntaxError/i.test(log);
    console.log("dev log 編譯錯誤:", compileErr ? "❌ 有" : "✓ 冇");
    if (compileErr) console.log(log.slice(-1500));
  } finally {
    cleanup();
    console.log("已關閉 dev server");
  }
})();
