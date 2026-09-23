import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  RELEASE_STORAGE_BUCKET,
  buildReleaseDownloadUrl,
  detectDevicePlatform,
  detectPlatformFromNavigator,
  formatReleaseFileSize,
  isReleasePlatform,
  resolveReleaseDownloadUrl,
  validateReleaseDraft,
} from "./release-core.ts";

/**
 * 《App 安裝包版本》核心邏輯守衛（2026-09-23）。
 *
 * ## 血淚背景
 *
 * 登入頁按鈕係**匿名路徑**（未登入就見到）⇒ 派錯 link 或者派一條 `null` link，
 * 商家撳落去冇反應，但頁面完全冇報錯。所以呢幾條口徑要釘死：
 *
 * 1. **裝置偵測只認 Android**：UA 唔含 `android` 一律 desktop。
 * 2. **Storage 路徑要逐段編碼**：整條 path 編碼會令 `/` 變 `%2F` → Storage 404。
 * 3. **`download_url` 只接受 http(s)**：呢個值直接落 `<a href>`，收 `javascript:`
 *    就係 XSS。
 * 4. **「路徑」同「連結」至少要有一個**：否則 active 版本撳落去係死 link。
 *
 * ## 🔴 呢個檔用 `node --test` 直接跑 ⇒ 只可以 import node 內建模組 + 受測模組
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE_PATH = path.join(HERE, "release-core.ts");

/** 真實 User-Agent 樣本（登入頁實際會遇到嘅）。 */
const UA = {
  androidPhone:
    "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 12; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
} as const;

describe("detectDevicePlatform ── 裝置偵測", () => {
  it("Android 手機 / 平板（UA 含 Android）→ android", () => {
    assert.equal(detectDevicePlatform(UA.androidPhone), "android");
    assert.equal(detectDevicePlatform(UA.androidTablet), "android");
  });

  it("桌面（Windows / macOS / Linux）→ desktop", () => {
    assert.equal(detectDevicePlatform(UA.windows), "desktop");
    assert.equal(detectDevicePlatform(UA.mac), "desktop");
    assert.equal(detectDevicePlatform(UA.linux), "desktop");
  });

  it("🔴 iPhone / iPad 歸入 desktop（我哋冇 iOS 安裝包，呢個係刻意口徑）", () => {
    assert.equal(detectDevicePlatform(UA.iphone), "desktop");
    assert.equal(detectDevicePlatform(UA.ipad), "desktop");
  });

  it("大小寫不敏感", () => {
    assert.equal(detectDevicePlatform("Mozilla/5.0 (linux; ANDROID 13)"), "android");
    assert.equal(detectDevicePlatform("mozilla/5.0 (android 9)"), "android");
  });

  it("空 / null / undefined → desktop（唔可以 throw —— 匿名頁面會直接白屏）", () => {
    assert.equal(detectDevicePlatform(""), "desktop");
    assert.equal(detectDevicePlatform("   "), "desktop");
    assert.equal(detectDevicePlatform(null), "desktop");
    assert.equal(detectDevicePlatform(undefined), "desktop");
  });

  it("🔴 UA 空白時退用 navigator.platform（自訂 WebView 會清 UA）", () => {
    assert.equal(detectPlatformFromNavigator({ userAgent: "", platform: "Linux armv8l" }), "android");
    assert.equal(detectPlatformFromNavigator({ userAgent: null, platform: "Linux aarch64" }), "android");
    assert.equal(detectPlatformFromNavigator({ userAgent: "", platform: "Android" }), "android");
    assert.equal(detectPlatformFromNavigator({ userAgent: "", platform: "Win32" }), "desktop");
  });

  it("有 UA 就一律信 UA，唔理 platform 講咩", () => {
    assert.equal(
      detectPlatformFromNavigator({ userAgent: UA.windows, platform: "Linux armv8l" }),
      "desktop",
    );
  });

  it("isReleasePlatform 收窄未知值", () => {
    assert.equal(isReleasePlatform("android"), true);
    assert.equal(isReleasePlatform("desktop"), true);
    assert.equal(isReleasePlatform("ios"), false);
    assert.equal(isReleasePlatform(null), false);
    assert.equal(isReleasePlatform(1), false);
  });
});

describe("buildReleaseDownloadUrl ── 砌 Storage 公開連結", () => {
  const url = "https://iyrywzormzisyppkokbi.supabase.co";

  it("基本形狀正確（public bucket）", () => {
    assert.equal(
      buildReleaseDownloadUrl({ supabaseUrl: url, filePath: "macau-pos.apk" }),
      `${url}/storage/v1/object/public/${RELEASE_STORAGE_BUCKET}/macau-pos.apk`,
    );
  });

  it("🔴 子目錄要逐段編碼 —— 整條 path 編碼會令 / 變 %2F 而 404", () => {
    const built = buildReleaseDownloadUrl({ supabaseUrl: url, filePath: "1.4.2/macau-pos.apk" });
    assert.equal(
      built,
      `${url}/storage/v1/object/public/${RELEASE_STORAGE_BUCKET}/1.4.2/macau-pos.apk`,
    );
    assert.ok(!built?.includes("%2F"), "唔可以出現 %2F");
  });

  it("檔名有空格 / 中文會正確編碼", () => {
    assert.equal(
      buildReleaseDownloadUrl({ supabaseUrl: url, filePath: "安裝 包.apk" }),
      `${url}/storage/v1/object/public/${RELEASE_STORAGE_BUCKET}/${encodeURIComponent("安裝 包.apk")}`,
    );
  });

  it("supabaseUrl 尾斜線 / 路徑頭斜線都食得", () => {
    assert.equal(
      buildReleaseDownloadUrl({ supabaseUrl: `${url}/`, filePath: "/macau-pos.apk" }),
      `${url}/storage/v1/object/public/${RELEASE_STORAGE_BUCKET}/macau-pos.apk`,
    );
  });

  it("可以指定其他 bucket", () => {
    assert.equal(
      buildReleaseDownloadUrl({ supabaseUrl: url, bucket: "other", filePath: "a.apk" }),
      `${url}/storage/v1/object/public/other/a.apk`,
    );
  });

  it("缺料一律返 null（唔要半條死 link）", () => {
    assert.equal(buildReleaseDownloadUrl({ supabaseUrl: null, filePath: "a.apk" }), null);
    assert.equal(buildReleaseDownloadUrl({ supabaseUrl: "", filePath: "a.apk" }), null);
    assert.equal(buildReleaseDownloadUrl({ supabaseUrl: url, filePath: null }), null);
    assert.equal(buildReleaseDownloadUrl({ supabaseUrl: url, filePath: "   " }), null);
    assert.equal(buildReleaseDownloadUrl({ supabaseUrl: url, filePath: "/" }), null);
  });
});

describe("resolveReleaseDownloadUrl ── 最終連結優先次序", () => {
  const url = "https://iyrywzormzisyppkokbi.supabase.co";

  it("有 download_url 就用佢（覆蓋 file_path）", () => {
    assert.equal(
      resolveReleaseDownloadUrl({
        downloadUrl: "https://cdn.example.com/macau-pos.apk",
        filePath: "macau-pos.apk",
        supabaseUrl: url,
      }),
      "https://cdn.example.com/macau-pos.apk",
    );
  });

  it("冇 download_url 就由 file_path 砌", () => {
    assert.equal(
      resolveReleaseDownloadUrl({ filePath: "macau-pos.apk", supabaseUrl: url }),
      `${url}/storage/v1/object/public/${RELEASE_STORAGE_BUCKET}/macau-pos.apk`,
    );
  });

  it("🔴 非 http(s) 嘅 download_url 一律拒絕（防止 javascript: 落 href）", () => {
    assert.equal(
      resolveReleaseDownloadUrl({ downloadUrl: "javascript:alert(1)", supabaseUrl: url }),
      null,
    );
    assert.equal(resolveReleaseDownloadUrl({ downloadUrl: "data:text/html;base64,PHN2Zz4=", supabaseUrl: url }), null);
    assert.equal(resolveReleaseDownloadUrl({ downloadUrl: "//evil.example.com/a.apk", supabaseUrl: url }), null);
  });

  it("什麼都冇 → null", () => {
    assert.equal(resolveReleaseDownloadUrl({ supabaseUrl: url }), null);
    assert.equal(resolveReleaseDownloadUrl({ downloadUrl: null, filePath: null, supabaseUrl: url }), null);
  });
});

describe("formatReleaseFileSize", () => {
  it("人類可讀", () => {
    assert.equal(formatReleaseFileSize(512), "512 B");
    assert.equal(formatReleaseFileSize(2048), "2.0 KB");
    assert.equal(formatReleaseFileSize(12 * 1024 * 1024), "12.0 MB");
    assert.equal(formatReleaseFileSize(1024 * 1024 * 1024), "1.0 GB");
  });

  it("未知唔扮 0 B", () => {
    assert.equal(formatReleaseFileSize(null), "—");
    assert.equal(formatReleaseFileSize(undefined), "—");
    assert.equal(formatReleaseFileSize(-1), "—");
    assert.equal(formatReleaseFileSize(Number.NaN), "—");
  });
});

describe("validateReleaseDraft ── admin 表單 / API 共用驗證", () => {
  it("正常個案：只要 filePath 就夠", () => {
    const r = validateReleaseDraft({
      platform: "android",
      version: "1.4.2",
      filePath: "macau-pos.apk",
    });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.value.platform, "android");
    assert.equal(r.ok && r.value.filePath, "macau-pos.apk");
    assert.equal(r.ok && r.value.downloadUrl, null);
    assert.equal(r.ok && r.value.fileSize, null);
  });

  it("只要 downloadUrl 都收（檔案放 Storage 以外）", () => {
    const r = validateReleaseDraft({
      platform: "desktop",
      version: "1.0.0",
      downloadUrl: "https://cdn.example.com/setup.exe",
    });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.value.filePath, null);
  });

  it("trim 空白；空字串變 null", () => {
    const r = validateReleaseDraft({
      platform: "android",
      version: "  1.4.2  ",
      filePath: "  macau-pos.apk  ",
      notes: "   ",
    });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.value.version, "1.4.2");
    assert.equal(r.ok && r.value.filePath, "macau-pos.apk");
    assert.equal(r.ok && r.value.notes, null);
  });

  it("🔴 平台唔可以亂填", () => {
    assert.equal(validateReleaseDraft({ platform: "ios", version: "1", filePath: "a" }).ok, false);
    assert.equal(validateReleaseDraft({ version: "1", filePath: "a" }).ok, false);
  });

  it("🔴 版本號唔可以空", () => {
    const r = validateReleaseDraft({ platform: "android", version: "   ", filePath: "a.apk" });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.error : "", /版本號/);
  });

  it("🔴 路徑同連結至少要有一個（否則 active 撳落去係死 link）", () => {
    const r = validateReleaseDraft({ platform: "android", version: "1.0.0" });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.error : "", /至少/);
  });

  it("🔴 拒絕目錄穿越", () => {
    assert.equal(
      validateReleaseDraft({ platform: "android", version: "1", filePath: "../../etc/passwd" }).ok,
      false,
    );
  });

  it("🔴 downloadUrl 必須 http(s)", () => {
    assert.equal(
      validateReleaseDraft({ platform: "android", version: "1", downloadUrl: "javascript:alert(1)" }).ok,
      false,
    );
  });

  it("fileSize 接受數字 / 數字字串，拒絕負數同垃圾", () => {
    assert.equal(validateReleaseDraft({ platform: "android", version: "1", filePath: "a", fileSize: "4096" }).ok, true);
    assert.equal(validateReleaseDraft({ platform: "android", version: "1", filePath: "a", fileSize: -5 }).ok, false);
    assert.equal(validateReleaseDraft({ platform: "android", version: "1", filePath: "a", fileSize: "abc" }).ok, false);
    // 留空 = 冇填，唔算錯
    assert.equal(validateReleaseDraft({ platform: "android", version: "1", filePath: "a", fileSize: "" }).ok, true);
  });

  it("非物件輸入唔會 throw", () => {
    assert.equal(validateReleaseDraft(null).ok, false);
    assert.equal(validateReleaseDraft(undefined).ok, false);
    assert.equal(validateReleaseDraft("abc").ok, false);
    assert.equal(validateReleaseDraft(42).ok, false);
  });

  it("超長版本號會被拒", () => {
    assert.equal(
      validateReleaseDraft({ platform: "android", version: "x".repeat(65), filePath: "a" }).ok,
      false,
    );
  });
});

describe("模組契約 ── release-core.ts 必須零 import", () => {
  it("🔴 唔可以有 import（`node --test` 唔認 @/ alias，一 import 就全檔跑唔到）", () => {
    const src = readFileSync(CORE_PATH, "utf8");
    const importLines = src
      .split(/\r?\n/)
      .filter((line) => /^\s*import\s/.test(line) || /require\(/.test(line));
    assert.deepEqual(
      importLines,
      [],
      `release-core.ts 出現 import／require —— 呢個模組要靠 node --test 直接載入：\n${importLines.join("\n")}`,
    );
  });

  it("🔴 平台值同 DB check constraint 一致（android / desktop）", () => {
    const sql = readFileSync(
      path.resolve(HERE, "..", "..", "..", "supabase", "migrations", "0050_pos_release_versions.sql"),
      "utf8",
    );
    assert.match(
      sql,
      /check\s*\(\s*platform\s+in\s*\(\s*'android'\s*,\s*'desktop'\s*\)\s*\)/,
      "migration 嘅 platform check constraint 要同 ReleasePlatform 完全一致",
    );
    assert.match(
      sql,
      /where\s+is_active/i,
      "每個平台最多一個 active 嘅 partial unique index 唔見咗",
    );
  });

  it("🔴 bucket 名要同 migration 註解一致（macauposapk）", () => {
    const sql = readFileSync(
      path.resolve(HERE, "..", "..", "..", "supabase", "migrations", "0050_pos_release_versions.sql"),
      "utf8",
    );
    assert.equal(RELEASE_STORAGE_BUCKET, "macauposapk");
    assert.ok(sql.includes(RELEASE_STORAGE_BUCKET), "migration 冇提及 bucket 名");
  });
});
