/**
 * 匿名可達端點審計（唯讀，只發 GET）。
 *
 * 目的：`POS_REQUIRE_DEVICE_AUTH=1` 生效之後，逐一確認邊啲 `/api/**` GET 端點
 * **仍然可以無憑證讀到資料** —— 呢啲就係「漏網」或「刻意開放」嘅清單，
 * 需要人手逐條判定（刻意開放要寫明理由；漏網要補閘）。
 *
 * ⚠️ 只發 GET，唔會寫入任何資料。帶 `?storeId=`（可用 --store 覆寫）。
 *
 * 用法：
 *   node tools/audit-anon-endpoints.cjs [storeId]
 */
const fs = require("fs");
const path = require("path");

const STORE_ID = process.argv[2] || "8291f843-9def-4956-9d0b-1cfef2598306";
const BASE = "https://macau-pos-system.vercel.app";
const API_ROOT = path.join(process.cwd(), "src", "app", "api");

/** 這個 store 一定存在；用嚟滿足需要 storeId 嘅端點。 */
const TABLE_ID = "table-a01";

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "route.ts") out.push(p);
  }
  return out;
}

/** route.ts 路徑 → URL 路徑（去掉 [param] 段嘅值由 caller 決定）。 */
function urlPathOf(file) {
  const rel = path.relative(API_ROOT, file).split(path.sep).join("/");
  return "/api/" + rel.replace(/\/route\.ts$/, "");
}

/** 由源碼抽出 export 咗嘅 HTTP methods。 */
function methodsOf(file) {
  const src = fs.readFileSync(file, "utf8");
  const found = new Set();
  for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    if (new RegExp(`export\\s+async\\s+function\\s+${m}\\b`).test(src) ||
        new RegExp(`export\\s+function\\s+${m}\\b`).test(src) ||
        new RegExp(`export\\s+const\\s+${m}\\b`).test(src)) {
      found.add(m);
    }
  }
  return found;
}

/** 有冇用鑑權閘（源碼層面，靜態判斷）。 */
function guardInfo(file) {
  const src = fs.readFileSync(file, "utf8");
  const guarded = /posRouteAuthGuard|posDeviceAuthRequired|readPosDeviceTokenFromRequest|requireAdminSession/.test(src);
  return guarded;
}

(async () => {
  const files = walk(API_ROOT).sort();
  const rows = [];

  for (const file of files) {
    if (!methodsOf(file).has("GET")) continue;
    const urlPath = urlPathOf(file);
    // [param] 段：用已知值代入；冇對應已知值就 skip（避免無意義 404）。
    if (/\[/.test(urlPath)) continue;

    const url = `${BASE}${urlPath}?storeId=${encodeURIComponent(STORE_ID)}&tableId=${TABLE_ID}&limit=5`;
    let status = 0, len = 0, preview = "", err = null;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "abu-anon-audit/1.0 (+readonly probe)" },
        signal: AbortSignal.timeout(12000),
      });
      status = res.status;
      const text = await res.text();
      len = text.length;
      preview = text.slice(0, 90).replace(/\s+/g, " ");
    } catch (e) {
      err = e?.message ?? String(e);
    }

    rows.push({
      urlPath,
      status,
      len,
      preview,
      staticGuard: guardInfo(file),
      err,
    });
  }

  const open = rows.filter((r) => r.status === 200);
  console.log(`掃描 ${rows.length} 條 GET 端點（帶 storeId）\n`);
  console.log("=== 🟠 匿名仍然 200（要逐條判定：刻意開放 vs 漏網）===");
  for (const r of open) {
    console.log(`${String(r.len).padStart(6)}B  ${r.staticGuard ? "源碼有閘" : "源碼無閘"}  ${r.urlPath}`);
    console.log(`         ↳ ${r.preview}`);
  }
  console.log("\n=== ✅ 已擋（401）===");
  console.log(rows.filter((r) => r.status === 401).map((r) => r.urlPath).join("\n") || "(冇)");
  console.log("\n=== ℹ️ 其他狀態 ===");
  const other = rows.filter((r) => r.status !== 200 && r.status !== 401);
  console.log(
    other.map((r) => `${String(r.status).padStart(3)}  ${r.urlPath}${r.err ? "  err=" + r.err : ""}`).join("\n") || "(冇)",
  );
})();
