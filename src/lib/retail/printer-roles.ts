/**
 * 打印機角色集合 —— **純函式，零 runtime 依賴**。
 *
 * 【為何要呢個檔】`DevicePrinterConfig.role` 一路係**單值**（`"zone" | "receipt" | "label"`）。
 * 但零售要用「一機兩用」：部分國產機（佳博 GP-2270T / GP-3120TUC 等）一部機
 * 可以**同時**做「標籤 + 小票」，細店唔使買兩台。
 *
 * 🔴 為咗**唔使遷移存量設定**，新欄位 `roles?: PrinterRole[]` 係選填：
 * 缺省時由 `role` 推導（`printerRolesOf()`）→ 舊機讀落去完全一樣。
 *
 * ⚠️ 呢個檔唔可以 import `@/lib/types`（runtime）—— 咁樣 `node --test` 載入唔到。
 * 所以用結構化參數（structural typing）而唔係直接引用介面。
 */

export type PrinterRoleLike = "zone" | "receipt" | "label";

export interface PrinterWithRoles {
  role?: PrinterRoleLike;
  roles?: PrinterRoleLike[];
}

export type PrinterRoleSet = PrinterRoleLike[];

/** 去重、保序、剔走非法值 */
export function sanitizeRoles(input: readonly unknown[] | undefined | null): PrinterRoleSet {
  const out: PrinterRoleSet = [];
  for (const raw of input ?? []) {
    if (raw === "zone" || raw === "receipt" || raw === "label") {
      if (!out.includes(raw)) out.push(raw);
    }
  }
  return out;
}

/**
 * 拎出打印機嘅實際角色集合。
 *
 * 規則：**`roles` 有值就為準**（即使係空陣列 —— 空 = 明確停用，唔應該退回 `role`）；
 * 否則由單值 `role` 推導。兩者都冇 → 空集合（= 未分配）。
 */
export function printerRolesOf(printer: PrinterWithRoles | null | undefined): PrinterRoleSet {
  if (!printer) return [];
  if (Array.isArray(printer.roles)) return sanitizeRoles(printer.roles);
  return sanitizeRoles([printer.role]);
}

/** 有冇某個角色 */
export function hasPrinterRole(
  printer: PrinterWithRoles | null | undefined,
  role: PrinterRoleLike,
): boolean {
  return printerRolesOf(printer).includes(role);
}

/** 印唔印得出收據（小票） */
export function canPrintReceipt(printer: PrinterWithRoles | null | undefined): boolean {
  return hasPrinterRole(printer, "receipt");
}

/** 印唔印得出標籤（價籤 / 商品標籤） */
export function canPrintLabel(printer: PrinterWithRoles | null | undefined): boolean {
  return hasPrinterRole(printer, "label");
}

/** 係唔係分區（廚房）機 —— 零售唔用，但餐飲共用同一份型別 */
export function isZonePrinter(printer: PrinterWithRoles | null | undefined): boolean {
  return hasPrinterRole(printer, "zone");
}

/** 一機兩用（同時做收據同標籤） */
export function isDualRolePrinter(printer: PrinterWithRoles | null | undefined): boolean {
  const r = printerRolesOf(printer);
  return r.includes("receipt") && r.includes("label");
}

/** 切換角色（設定頁用）：`roles` 一律寫入明確值，唔再靠 `role` 推導 */
export function withRoles(
  printer: PrinterWithRoles,
  roles: readonly PrinterRoleLike[],
): PrinterWithRoles & { roles: PrinterRoleSet } {
  const next = sanitizeRoles(roles);
  // `role` 同步成第一個角色（或者保留原值），令未讀 `roles` 嘅舊代碼行為合理
  return { ...printer, roles: next, role: next[0] ?? printer.role };
}

/** 顯示用：把角色集合講成人話 */
export function describePrinterRoles(printer: PrinterWithRoles | null | undefined): string {
  const r = printerRolesOf(printer);
  if (r.length === 0) return "未分配";
  const names: Record<PrinterRoleLike, string> = {
    receipt: "收據單",
    label: "標籤單",
    zone: "分區單",
  };
  // 「一機兩用」要一眼睇得出
  if (isDualRolePrinter(printer)) return "收據＋標籤（一機兩用）";
  return r.map((x) => names[x]).join("＋");
}
