/**
 * 端到端驗證 `/api/admin/traffic` 嘅鑑權鏈（2026-09-22）。
 *
 * 背景：`/admin/traffic` 首次上線時漏咗 `Authorization: Bearer <adminSessionToken>`
 * ⇒ 頁面見到「未授權」而 KPI 全部 0。呢個腳本用**真 token** 打通整條鏈：
 *   ① 冇 token → 401
 *   ② POST /api/admin/session（mock 帳號）→ token
 *   ③ 帶 token → 200（本機冇 Supabase ⇒ available:false，屬預期嘅 graceful 降級）
 *
 * 用法：node tools/_smoke-admin-api-20260922.cjs [port]
 */
const { spawn, execSync } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.argv[2]) || 3112;
const CWD = process.cwd();
const NODE = "C:/Users/surface/.workbuddy/binaries/node/versions/22.22.2-3/node.exe";
const MOCK_ACCOUNT = "60000000";
const MOCK_PIN = "0000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, p, body, headers) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: "localhost",
        port: PORT,
        path: p,
        method,
        timeout: 120_000,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(headers ?? {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ code: res.statusCode, text }));
      },
    );
    req.on("error", (e) => resolve({ code: 0, err: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ code: 0, err: "timeout" });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const env = {
    ...process.env,
    PATH: `${path.dirname(NODE)}${path.delimiter}${process.env.PATH}`,
    POS_REQUIRE_DEVICE_AUTH: "0",
    POS_EGRESS_LOG: "1",
    // 本機冇 `SUPABASE_SERVICE_ROLE_KEY` ⇒ admin token 簽唔到（502 之前回 503）。
    // 呢個係**純本機測試用**嘅 secret，只為咗打通「簽 token → 帶 token 打 API」呢一段。
    ADMIN_SESSION_SECRET: process.env.ADMIN_SESSION_SECRET || "local-smoke-test-secret",
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

  try {
    let ready = false;
    for (let i = 0; i < 60; i += 1) {
      await sleep(2_500);
      const probe = await request("GET", "/login");
      if (probe.code > 0) {
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

    const noToken = await request("GET", "/api/admin/traffic?days=14");
    console.log(`① 冇 token           => HTTP ${noToken.code} ${noToken.code === 401 ? "✓" : "❌"} ${(noToken.text || "").slice(0, 120)}`);

    const login = await request("POST", "/api/admin/session", { account: MOCK_ACCOUNT, pin: MOCK_PIN });
    let token = null;
    try {
      token = JSON.parse(login.text)?.token ?? null;
    } catch {
      /* ignore */
    }
    console.log(`② POST /api/admin/session => HTTP ${login.code} token=${token ? "有" : "冇"} ${(login.text || "").slice(0, 160)}`);

    if (token) {
      const withToken = await request("GET", "/api/admin/traffic?days=14", null, {
        Authorization: `Bearer ${token}`,
      });
      let parsed = null;
      try {
        parsed = JSON.parse(withToken.text);
      } catch {
        /* ignore */
      }
      const okShape = Boolean(parsed && parsed.ok === true && Array.isArray(parsed.rows));
      console.log(
        `③ 帶 token            => HTTP ${withToken.code} ${okShape ? "✓" : "❌"} ` +
          `ok=${parsed?.ok} available=${parsed?.available} rows=${parsed?.rows?.length} reason=${parsed?.reason ?? "-"}`,
      );
      console.log(`   口徑欄位：quotaBytes=${parsed?.quotaBytes} today=${parsed?.today} windowDays=${parsed?.windowDays?.length}`);
    }

    const badToken = await request("GET", "/api/admin/traffic?days=14", null, {
      Authorization: "Bearer not-a-real-token",
    });
    console.log(`④ 假 token            => HTTP ${badToken.code} ${badToken.code === 401 ? "✓" : "❌"}`);

    const compileErr = /Failed to compile|Module not found|SyntaxError/i.test(log);
    console.log("dev log 編譯錯誤:", compileErr ? "❌ 有" : "✓ 冇");
    if (compileErr) console.log(log.slice(-1500));
  } finally {
    cleanup();
    console.log("已關閉 dev server");
  }
})();
