/**
 * 一次性渲染煙霧測試：啟動 `next dev` → 等就緒 → 打幾個關鍵路徑 → 殺掉。
 *
 * 為何用 Node 驅動而唔用 shell：本機 bash 冇 coreutils（`sleep` / `dirname` 都 command not found），
 * 所有等待／重試都要自己寫。
 *
 * 用法：node tools/_smoke-pages-20260922.cjs [port]
 */
const { spawn, execSync } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.argv[2]) || 3111;
const CWD = process.cwd();
const NODE = "C:/Users/surface/.workbuddy/binaries/node/versions/22.22.2-3/node.exe";
const PATHS = ["/admin/traffic", "/", "/orders", "/prints"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: "localhost", port: PORT, path: p, timeout: 120_000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ code: res.statusCode, body }));
    });
    req.on("error", (e) => resolve({ code: 0, err: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ code: 0, err: "timeout" });
    });
  });
}

(async () => {
  const env = { ...process.env, PATH: `${path.dirname(NODE)}${path.delimiter}${process.env.PATH}`, POS_REQUIRE_DEVICE_AUTH: "0" };
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

  try {
    // 等就緒（最多 150 秒）
    let ready = false;
    for (let i = 0; i < 60; i += 1) {
      await sleep(2_500);
      const probe = await get("/login");
      if (probe.code > 0) {
        ready = true;
        break;
      }
    }
    console.log("dev server ready:", ready);
    if (!ready) {
      console.log("--- dev log ---");
      console.log(log.slice(-2500));
      cleanup();
      process.exit(1);
    }

    for (const p of PATHS) {
      const r = await get(p);
      const body = r.body ?? "";
      const bad = /Application error|Internal Server Error|Module not found|ReferenceError|Unhandled Runtime Error/i.test(body);
      const hasErrorDigest = /__next_error__|error-digest/i.test(body);
      console.log(
        `${p.padEnd(16)} => HTTP ${r.code} ${body.length} bytes ${bad || hasErrorDigest ? "❌ 有錯誤標記" : "✓"} ${r.err ?? ""}`,
      );
      if (bad || hasErrorDigest) {
        const at = body.search(/Application error|Internal Server Error|Unhandled Runtime Error/i);
        console.log("   ..." + body.slice(Math.max(0, at - 200), at + 600).replace(/\s+/g, " "));
      }
    }

    // 檢查 dev log 有冇編譯錯誤
    const compileErr = /Failed to compile|Module not found|SyntaxError/i.test(log);
    console.log("dev log 編譯錯誤:", compileErr ? "❌ 有" : "✓ 冇");
    if (compileErr) {
      const at = log.search(/Failed to compile|Module not found|SyntaxError/i);
      console.log(log.slice(Math.max(0, at - 300), at + 1200));
    }
  } finally {
    cleanup();
    console.log("已關閉 dev server");
  }
})();
