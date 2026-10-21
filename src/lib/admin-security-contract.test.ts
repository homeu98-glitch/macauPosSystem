import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * Admin 安全底座「源碼契約」守衛（2026-10-21 · P0-1 / P0-3 / P0-4）。
 *
 * 為何要手寫掃描而唔係單元測試：
 *   呢幾條約束係「**唔可以**出現某段 code」或「**一定**要出現某段 code」，
 *   tsc／eslint 都唔會出聲。歷史上呢類「靜靜回退」最易被人手改返轉頭：
 *     · 有人為咗令 dev 好跑，把 `ADMIN_SESSION_SECRET` 嘅 fallback 加返去 service key；
 *     · 有人見 401 麻煩，把 backoffice store route 嘅閘拆走。
 *   一旦拆走，表面功能完全正常 —— 所以只可以靠 source scan 守住。
 */
const TOKEN_SRC = readFileSync(new URL("../lib/admin-session-token.ts", import.meta.url), "utf8");
const SESSION_ROUTE = readFileSync(new URL("../app/api/admin/session/route.ts", import.meta.url), "utf8");
const STORE_ROUTE = readFileSync(
  new URL("../app/api/backoffice/stores/[storeId]/route.ts", import.meta.url),
  "utf8",
);

describe("admin 簽名密鑰 ── P0-1：唔可以 fallback 到 service role key", () => {
  it("🔴 admin-session-token.ts 唔可以讀 process.env.SUPABASE_SERVICE_*（註解提及唔算）", () => {
    assert.ok(
      !/process\.env\.SUPABASE_SERVICE_(ROLE_)?KEY/.test(TOKEN_SRC),
      "service key 一洩漏就等於可以偽造 admin token；rotate service key 亦會令 admin 全員靜默被登出。",
    );
  });

  it("resolveSecret 只可以由 ADMIN_SESSION_SECRET 取，冇就回 null（fail closed）", () => {
    assert.ok(/process\.env\.ADMIN_SESSION_SECRET\?\.trim\(\)/.test(TOKEN_SRC));
    assert.ok(/return dedicated \|\| null;/.test(TOKEN_SRC));
  });
});

describe("admin 登入 route ── P0-2 / P0-4 / P0-5", () => {
  it("必須有 IP 限流（429）", () => {
    assert.ok(/checkIpRateLimit/.test(SESSION_ROUTE), "冇 IP 限流 ⇒ 可以快速枚舉多個帳號");
    assert.ok(/status:\s*429/.test(SESSION_ROUTE));
  });

  it("必須處理 per-account 鎖定（DB 狀態），並回 Retry-After", () => {
    assert.ok(/code === "locked"/.test(SESSION_ROUTE), "唔處理 locked ⇒ 被鎖帳號只會見到『PIN 錯』");
    assert.ok(/Retry-After/.test(SESSION_ROUTE));
  });

  it("必須寫審計（成功／失敗／鎖定）", () => {
    assert.ok(/writeAdminAudit/.test(SESSION_ROUTE));
    assert.ok(/login_success/.test(SESSION_ROUTE));
    assert.ok(/login_failed/.test(SESSION_ROUTE));
    assert.ok(/login_locked/.test(SESSION_ROUTE));
  });

  it("回傳要帶 scope 摘要（P0-5，前端只作顯示，真授權在 server）", () => {
    assert.ok(/scope:\s*\{/.test(SESSION_ROUTE));
    assert.ok(/storeIds/.test(SESSION_ROUTE));
  });

  it("🔴 店舖級帳號要有明確 `adminPanelAccess` 才入得（唔可以「有綁定就放行」）", () => {
    assert.ok(
      /adminPanelAccess/.test(SESSION_ROUTE),
      "改壞咗就會令所有有店舖綁定嘅前線帳號突然入到 /admin（未經批准嘅權限擴張）",
    );
  });
});

describe("/api/backoffice/stores/[storeId] ── P0-3：唔可以再係無閘", () => {
  it("🔴 GET 必須驗 admin session 或 POS 終端憑證", () => {
    assert.ok(
      /readAdminSessionFromRequest\(request\)/.test(STORE_ROUTE),
      "冇 admin session 檢查 ⇒ 任何人都可以讀走店舖詳情（含帳號清單）",
    );
    assert.ok(/readPosDeviceTokenFromRequest\(request\)/.test(STORE_ROUTE));
    assert.ok(/status:\s*401/.test(STORE_ROUTE));
  });

  it("🔴 終端憑證唔可以越店讀（device.storeId 必須等於 storeId）", () => {
    assert.ok(
      /device\.storeId !== storeId/.test(STORE_ROUTE),
      "冇越店檢查 ⇒ 任何一台 POS 機都可以列舉其他店",
    );
    assert.ok(/status:\s*403/.test(STORE_ROUTE));
  });

  it("🔴 PATCH（停用／啟用店舖）只准 admin session，POS 終端憑證一律拒絕", () => {
    const patch = STORE_ROUTE.slice(STORE_ROUTE.indexOf("export async function PATCH"));
    assert.ok(/readAdminSessionFromRequest\(request\)/.test(patch));
    assert.ok(!/readPosDeviceTokenFromRequest/.test(patch), "PATCH 唔應該接受終端憑證");
    assert.ok(/writeAdminAudit/.test(patch), "平台級寫操作一定要落審計");
  });
});

/* ───────────────────────── P1：全部 admin route 要經統一守衛 ───────────────────────── */

function listAdminRoutes(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) listAdminRoutes(full, out);
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

const ADMIN_API_DIR = fileURLToPath(new URL("../app/api/admin", import.meta.url));
const ADMIN_ROUTE_FILES = listAdminRoutes(ADMIN_API_DIR).map((f) => f.replace(/\\/g, "/"));

function relOf(file: string): string {
  return file.slice(ADMIN_API_DIR.replace(/\\/g, "/").length + 1);
}

/**
 * 登入端點本身唔可能用 `requireAdmin()` —— 佢就係簽 token 嘅地方。
 * 除佢之外，任何 `route.ts` 自己驗 token = 一定漏 scope（P1 之前就係咁）。
 */
const LOGIN_ROUTE_REL = "session/route.ts";

describe("/api/admin/** ── P1：每條 route 都要經 requireAdmin（唔可以自己驗 token）", () => {
  it("掃描到嘅 route 數量合理（防止路徑錯咗而靜靜通過）", () => {
    assert.ok(
      ADMIN_ROUTE_FILES.length >= 9,
      `只搵到 ${ADMIN_ROUTE_FILES.length} 條：${ADMIN_ROUTE_FILES.map(relOf).join(", ")}`,
    );
  });

  for (const file of ADMIN_ROUTE_FILES) {
    const rel = relOf(file);
    if (rel === LOGIN_ROUTE_REL) continue;

    it(`${rel} → requireAdmin()`, () => {
      const src = readFileSync(file, "utf8");
      assert.ok(
        /requireAdmin\(/.test(src),
        "冇經統一守衛 ⇒ 任何一張 admin token 都等於全平台權限（P1 之前嘅 bug）",
      );
      assert.ok(
        !/readAdminSessionFromRequest\(request\)/.test(src),
        "唔應該自己驗 token：咁樣就唔會有 scope 檢查（新 route 最容易複製到呢個寫法）",
      );
    });
  }
});

describe("/api/admin/** ── P1：平台專屬 route", () => {
  // D4（模組開關只有平台）+ 營運情報（工作階段／用量／版本）
  const PLATFORM_ONLY = [
    "merchants/status/route.ts",
    "merchants/modules/route.ts",
    "sessions/route.ts",
    "traffic/route.ts",
    "release-versions/route.ts",
  ];

  for (const rel of PLATFORM_ONLY) {
    it(`${rel} → need.platform`, () => {
      const file = ADMIN_ROUTE_FILES.find((f) => relOf(f) === rel);
      assert.ok(file, `搵唔到 ${rel}（檔案改咗名？請同步更新本清單）`);
      const src = readFileSync(file, "utf8");
      assert.ok(
        /platform:\s*true/.test(src),
        "平台專屬功能冇落 platform: true ⇒ 店主帳號可以做平台操作",
      );
    });
  }
});
