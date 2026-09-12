import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SIDEBAR_MODULE_IDS,
  SIDEBAR_MODULES,
  WORKBENCHES,
  WORKBENCH_IDS,
  defaultMerchantGrants,
  findWorkbench,
  isSidebarModuleGranted,
  isWorkbenchGranted,
  normalizeMerchantGrants,
} from "./module-catalog.ts";

describe("module-catalog · 目錄完整性", () => {
  it("每個工作台都有齊必要欄位，而且 id 唔重複", () => {
    const seen = new Set<string>();
    for (const w of WORKBENCHES) {
      assert.ok(w.id, "id 唔可以空");
      assert.ok(!seen.has(w.id), `工作台 id 重複：${w.id}`);
      seen.add(w.id);
      assert.ok(w.label.length > 0, `${w.id} 冇 label`);
      assert.ok(w.short.length > 0, `${w.id} 冇 short`);
      assert.ok(w.desc.length > 0, `${w.id} 冇 desc`);
      assert.ok(w.homePath.startsWith("/"), `${w.id} 嘅 homePath 一定要以 / 開頭`);
    }
    assert.equal(seen.size, WORKBENCH_IDS.length);
  });

  it("每個側欄模組都有齊必要欄位，而且 id 唔重複", () => {
    const seen = new Set<string>();
    for (const m of SIDEBAR_MODULES) {
      assert.ok(!seen.has(m.id), `側欄模組 id 重複：${m.id}`);
      seen.add(m.id);
      assert.ok(m.label.length > 0, `${m.id} 冇 label`);
      assert.ok(m.href.startsWith("/"), `${m.id} 嘅 href 一定要以 / 開頭`);
    }
    assert.equal(seen.size, SIDEBAR_MODULE_IDS.length);
  });

  it("裝置角色（kiosk / kitchen / expo）一定要標 deviceRole", () => {
    // 呢個 flag 決定「會唔會寫店級掃碼模式」。標錯 = 自助點餐機綁店會覆蓋收銀台嘅設定。
    for (const id of ["kiosk", "kitchen", "expo"] as const) {
      assert.equal(findWorkbench(id)?.deviceRole, true, `${id} 一定要係 deviceRole`);
    }
    for (const id of ["dinein", "quick", "retail", "salon"] as const) {
      assert.equal(findWorkbench(id)?.deviceRole, false, `${id} 一定唔係 deviceRole`);
    }
  });
});

describe("module-catalog · defaultMerchantGrants", () => {
  it("預設 = 全部開通", () => {
    const grants = defaultMerchantGrants();
    assert.deepEqual(grants.workbenches, [...WORKBENCH_IDS]);
    assert.deepEqual(grants.sidebarModules, [...SIDEBAR_MODULE_IDS]);
    assert.equal(isWorkbenchGranted(grants, "dinein"), true);
    assert.equal(isSidebarModuleGranted(grants, "inventory"), true);
  });

  it("每次回傳新陣列（防止呼叫方改到共用常數）", () => {
    const a = defaultMerchantGrants();
    a.workbenches.push("expo");
    const b = defaultMerchantGrants();
    assert.equal(b.workbenches.length, WORKBENCH_IDS.length);
  });
});

describe("module-catalog · normalizeMerchantGrants", () => {
  it("丟棄未知 id，唔 throw", () => {
    const grants = normalizeMerchantGrants({
      workbenches: ["dinein", "已經下架嘅模組", "kiosk"],
      sidebarModules: ["orders", "ghost"],
    });
    assert.deepEqual(grants.workbenches, ["dinein", "kiosk"]);
    assert.deepEqual(grants.sidebarModules, ["orders"]);
  });

  it("去重 + 按目錄順序重排（UI 唔會跳位）", () => {
    const grants = normalizeMerchantGrants({
      workbenches: ["kiosk", "dinein", "kiosk"],
      sidebarModules: ["inventory", "order", "order"],
    });
    // 目錄順序：dinein 喺 kiosk 之前；order 喺 inventory 之前。
    assert.deepEqual(grants.workbenches, ["dinein", "kiosk"]);
    assert.deepEqual(grants.sidebarModules, ["order", "inventory"]);
  });

  it("接受 DB 嘅 snake_case 欄名 sidebar_modules", () => {
    const grants = normalizeMerchantGrants({
      workbenches: ["quick"],
      sidebar_modules: ["orders", "reports"],
    });
    assert.deepEqual(grants.workbenches, ["quick"]);
    assert.deepEqual(grants.sidebarModules, ["orders", "reports"]);
  });

  it("垃圾輸入 → 空陣列（唔會爆）", () => {
    for (const bad of [null, undefined, 0, "x", [], { workbenches: "dinein" }, { workbenches: [1, 2, null] }]) {
      const grants = normalizeMerchantGrants(bad);
      assert.deepEqual(grants.workbenches, []);
      assert.deepEqual(grants.sidebarModules, []);
    }
  });

  it("⚠️ 空陣列要保留做空陣列 —— 佢係「Admin 明確全部閂」，唔可以變返全開", () => {
    const grants = normalizeMerchantGrants({ workbenches: [], sidebarModules: [] });
    assert.deepEqual(grants.workbenches, []);
    assert.deepEqual(grants.sidebarModules, []);
  });
});
