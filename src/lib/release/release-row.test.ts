import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  mapReleaseVersionRow,
  mapReleaseVersionRows,
  pickActiveReleases,
  sortReleaseVersions,
  type ReleaseVersionDto,
} from "./release-row.ts";

/**
 * 《版本 row → DTO》映射守衛（2026-09-23）。
 *
 * 呢層係「DB snake_case」同「UI camelCase」之間唯一嘅閘。出錯嘅話：
 *   · 映射到一條 `downloadUrl: null` 嘅 active 版本 ⇒ 登入頁按鈕**撳落去冇反應**
 *     （唔會報錯，商家只會覺得「下載壞咗」）；
 *   · 映射漏咗 `is_active` ⇒ 按鈕永遠唔出現。
 *
 * ⇒ 呢幾條要釘死。
 *
 * ⚠️ 呢個檔用 `node --test` 直接跑 ⇒ 只可以 import node 內建模組 + 受測模組。
 */

const BASE = "https://iyrywzormzisyppkokbi.supabase.co";

function dto(overrides: Partial<ReleaseVersionDto>): ReleaseVersionDto {
  return {
    id: "id-1",
    platform: "android",
    version: "1.0.0",
    filePath: "macau-pos.apk",
    downloadUrl: `${BASE}/storage/v1/object/public/macauposapk/macau-pos.apk`,
    explicitDownloadUrl: null,
    fileSize: null,
    notes: null,
    isActive: false,
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("mapReleaseVersionRow ── snake_case → camelCase", () => {
  it("完整 row：砌出 Storage 公開連結", () => {
    const mapped = mapReleaseVersionRow(
      {
        id: "abc",
        platform: "android",
        version: "1.4.2",
        file_path: "macau-pos.apk",
        download_url: null,
        file_size: 12345678,
        notes: "修復打印",
        is_active: true,
        created_at: "2026-09-23T01:00:00.000Z",
        updated_at: "2026-09-23T02:00:00.000Z",
      },
      { supabaseBaseUrl: BASE },
    );

    assert.ok(mapped);
    assert.equal(mapped.id, "abc");
    assert.equal(mapped.platform, "android");
    assert.equal(mapped.version, "1.4.2");
    assert.equal(mapped.filePath, "macau-pos.apk");
    assert.equal(mapped.downloadUrl, `${BASE}/storage/v1/object/public/macauposapk/macau-pos.apk`);
    assert.equal(mapped.fileSize, 12345678);
    assert.equal(mapped.notes, "修復打印");
    assert.equal(mapped.isActive, true);
  });

  it("download_url 有值時覆蓋砌出嚟嘅連結", () => {
    const mapped = mapReleaseVersionRow(
      {
        id: "abc",
        platform: "desktop",
        version: "1.0.0",
        file_path: "setup.exe",
        download_url: "https://cdn.example.com/setup.exe",
        is_active: true,
      },
      { supabaseBaseUrl: BASE },
    );
    assert.equal(mapped?.downloadUrl, "https://cdn.example.com/setup.exe");
  });

  it("🔴 explicitDownloadUrl 要留住 DB 原值，唔可以係解析後嘅結果", () => {
    // 有 download_url：原值 ＝ 嗰條 URL
    const withExplicit = mapReleaseVersionRow(
      {
        id: "a",
        platform: "desktop",
        version: "1",
        file_path: "setup.exe",
        download_url: "https://cdn.example.com/setup.exe",
      },
      { supabaseBaseUrl: BASE },
    );
    assert.equal(withExplicit?.explicitDownloadUrl, "https://cdn.example.com/setup.exe");

    // 冇 download_url：原值 ＝ null（而唔係砌出嚟嗰條 Storage URL）
    // ⇒ admin 編輯表單唔會誤把「由路徑砌」變成「寫死一條 URL」
    const derived = mapReleaseVersionRow(
      { id: "b", platform: "desktop", version: "1", file_path: "setup.exe", download_url: null },
      { supabaseBaseUrl: BASE },
    );
    assert.equal(derived?.explicitDownloadUrl, null);
    assert.ok(derived?.downloadUrl, "解析後嘅連結仍然要有");
  });

  it("🔴 冇 supabaseBaseUrl 又冇 download_url ⇒ downloadUrl = null（呼叫方要當「冇」）", () => {
    const mapped = mapReleaseVersionRow({
      id: "abc",
      platform: "android",
      version: "1",
      file_path: "macau-pos.apk",
      is_active: true,
    });
    assert.ok(mapped);
    assert.equal(mapped.downloadUrl, null);
  });

  it("🔴 非法 platform → null（唔好 render 一條撳唔到嘅版本）", () => {
    assert.equal(mapReleaseVersionRow({ id: "a", platform: "ios", version: "1", file_path: "x" }), null);
    assert.equal(mapReleaseVersionRow({ id: "a", platform: null, version: "1", file_path: "x" }), null);
  });

  it("🔴 冇 id / 冇版本號 → null", () => {
    assert.equal(mapReleaseVersionRow({ platform: "android", version: "1", file_path: "x" }), null);
    assert.equal(mapReleaseVersionRow({ id: "a", platform: "android", version: "   ", file_path: "x" }), null);
  });

  it("唔會 throw（null / undefined / 垃圾）", () => {
    assert.equal(mapReleaseVersionRow(null), null);
    assert.equal(mapReleaseVersionRow(undefined), null);
  });

  it("is_active 只認真 boolean true（DB 回 null 唔可以當 true）", () => {
    const base = { id: "a", platform: "android" as const, version: "1", file_path: "x" };
    assert.equal(mapReleaseVersionRow({ ...base, is_active: null })?.isActive, false);
    assert.equal(mapReleaseVersionRow({ ...base, is_active: undefined })?.isActive, false);
    assert.equal(mapReleaseVersionRow({ ...base, is_active: true })?.isActive, true);
  });

  it("file_size 接受字串數字（PostgREST 有時回字串）", () => {
    const mapped = mapReleaseVersionRow({
      id: "a",
      platform: "android",
      version: "1",
      file_path: "x",
      file_size: "4096",
    });
    assert.equal(mapped?.fileSize, 4096);
  });

  it("trim 字串；空字串 → null", () => {
    const mapped = mapReleaseVersionRow({
      id: " a ",
      platform: "android",
      version: "  1.0.0  ",
      file_path: "  macau-pos.apk  ",
      notes: "   ",
    });
    assert.equal(mapped?.id, "a");
    assert.equal(mapped?.version, "1.0.0");
    assert.equal(mapped?.filePath, "macau-pos.apk");
    assert.equal(mapped?.notes, null);
  });

  it("mapReleaseVersionRows 掉走非法 row，順序保持", () => {
    const rows = [
      { id: "1", platform: "android", version: "1", file_path: "a.apk" },
      { id: "2", platform: "ios", version: "1", file_path: "b.apk" },
      { id: "3", platform: "desktop", version: "1", file_path: "c.exe" },
    ];
    assert.deepEqual(mapReleaseVersionRows(rows, { supabaseBaseUrl: BASE }).map((d) => d.id), ["1", "3"]);
    assert.deepEqual(mapReleaseVersionRows(null), []);
    assert.deepEqual(mapReleaseVersionRows(undefined), []);
  });
});

describe("pickActiveReleases ── 每個平台取 active", () => {
  it("正常：兩個平台各自一條 active", () => {
    const picked = pickActiveReleases([
      dto({ id: "a1", platform: "android", isActive: true }),
      dto({ id: "a2", platform: "android", isActive: false }),
      dto({ id: "d1", platform: "desktop", isActive: true }),
    ]);
    assert.equal(picked.android?.id, "a1");
    assert.equal(picked.desktop?.id, "d1");
  });

  it("冇 active / 空陣列 ⇒ 兩個平台都 null（登入頁就唔顯示按鈕）", () => {
    const empty = pickActiveReleases([]);
    assert.equal(empty.android, null);
    assert.equal(empty.desktop, null);

    const inactive = pickActiveReleases([dto({ isActive: false }), dto({ platform: "desktop" })]);
    assert.equal(inactive.android, null);
    assert.equal(inactive.desktop, null);
  });

  it("🔴 萬一資料壞咗（同平台兩條 active）⇒ 取 updatedAt 最新，唔會亂派", () => {
    const picked = pickActiveReleases([
      dto({ id: "old", isActive: true, updatedAt: "2026-09-01T00:00:00.000Z" }),
      dto({ id: "new", isActive: true, updatedAt: "2026-09-23T00:00:00.000Z" }),
    ]);
    assert.equal(picked.android?.id, "new");
  });

  it("updatedAt 缺失時退用 createdAt 比較", () => {
    const picked = pickActiveReleases([
      dto({ id: "old", isActive: true, updatedAt: null, createdAt: "2026-09-01T00:00:00.000Z" }),
      dto({ id: "new", isActive: true, updatedAt: null, createdAt: "2026-09-23T00:00:00.000Z" }),
    ]);
    assert.equal(picked.android?.id, "new");
  });

  it("永遠回兩個 key（型別安全，呼叫方唔使再判 undefined）", () => {
    const picked = pickActiveReleases([]);
    assert.deepEqual(Object.keys(picked).sort(), ["android", "desktop"]);
  });
});

describe("sortReleaseVersions", () => {
  it("android 排先，同平台 created_at 新喺前", () => {
    const sorted = sortReleaseVersions([
      dto({ id: "d2", platform: "desktop", createdAt: "2026-09-23T00:00:00.000Z" }),
      dto({ id: "a-old", platform: "android", createdAt: "2026-09-10T00:00:00.000Z" }),
      dto({ id: "a-new", platform: "android", createdAt: "2026-09-23T00:00:00.000Z" }),
    ]);
    assert.deepEqual(sorted.map((d) => d.id), ["a-new", "a-old", "d2"]);
  });

  it("created_at 缺失唔會亂排（落 0，排最後）", () => {
    const sorted = sortReleaseVersions([
      dto({ id: "no-date", createdAt: null }),
      dto({ id: "dated", createdAt: "2026-09-10T00:00:00.000Z" }),
    ]);
    assert.deepEqual(sorted.map((d) => d.id), ["dated", "no-date"]);
  });

  it("唔會改動輸入陣列", () => {
    const input = [dto({ id: "b", createdAt: "2026-09-01T00:00:00.000Z" }), dto({ id: "a", createdAt: "2026-09-23T00:00:00.000Z" })];
    sortReleaseVersions(input);
    assert.deepEqual(input.map((d) => d.id), ["b", "a"]);
  });
});
