import { MenuItem, MenuSpecGroup, PosBootstrap } from "@/lib/types";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" ? (value as UnknownRecord) : null;
}

function normalizeSpecGroups(raw: unknown): MenuSpecGroup[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const groups = raw
    .map((group, groupIndex) => {
      const record = asRecord(group);
      if (!record) return null;

      const optionsRaw = Array.isArray(record.options) ? record.options : Array.isArray(record.spec_options) ? record.spec_options : [];
      const options = optionsRaw
        .map((option, optionIndex) => {
          const optionRecord = asRecord(option);
          if (!optionRecord) return null;
          return {
            id: String(optionRecord.id ?? optionRecord.option_id ?? `opt-${groupIndex}-${optionIndex}`),
            label: String(optionRecord.label ?? optionRecord.name ?? optionRecord.option_name ?? "未命名選項"),
            priceDelta: Number(optionRecord.priceDelta ?? optionRecord.price_delta ?? 0),
          };
        })
        .filter((option): option is NonNullable<typeof option> => Boolean(option));

      return {
        id: String(record.id ?? record.group_id ?? `grp-${groupIndex}`),
        name: String(record.name ?? record.group_name ?? "未命名規格"),
        selectionMode: String(record.selectionMode ?? record.selection_mode ?? "single") === "multi" ? "multi" : "single",
        required: Boolean(record.required ?? record.is_required ?? record.must_select ?? false),
        options,
      };
    })
    .filter(
      (group): group is MenuSpecGroup =>
        group !== null && Array.isArray(group.options) && group.options.length > 0,
    );

  return groups.length > 0 ? groups : undefined;
}

function normalizeMenuItem(item: MenuItem | UnknownRecord): MenuItem {
  const record = item as UnknownRecord;
  return {
    id: String(record.id),
    categoryId: String(record.categoryId ?? record.category_id ?? ""),
    name: String(record.name ?? ""),
    price: Number(record.price ?? 0),
    printerGroup: String(record.printerGroup ?? record.printer_group ?? "kitchen") as MenuItem["printerGroup"],
    specGroups: normalizeSpecGroups(record.specGroups ?? record.spec_groups),
  };
}

export function normalizeBootstrapPayload(raw: PosBootstrap | UnknownRecord): PosBootstrap {
  const record = raw as UnknownRecord;
  const rulesRecord = asRecord(record.rules) ?? {};
  const rawMenuItems = Array.isArray(record.menuItems)
    ? record.menuItems
    : Array.isArray(record.menu_items)
      ? record.menu_items
      : [];
  return {
    sourceVersion: Number(record.sourceVersion ?? record.source_version ?? 1),
    storeId: String(record.storeId ?? record.store_id ?? ""),
    storeName: String(record.storeName ?? record.store_name ?? ""),
    currency: String(record.currency ?? "MOP"),
    categories: Array.isArray(record.categories)
      ? record.categories.map((category, index) => {
          const categoryRecord = asRecord(category) ?? {};
          return {
            id: String(categoryRecord.id ?? categoryRecord.category_id ?? `cat-${index}`),
            name: String(categoryRecord.name ?? categoryRecord.category_name ?? "未命名分類"),
          };
        })
      : [],
    menuItems: rawMenuItems.map((item) => normalizeMenuItem(item as UnknownRecord)),
    tables: Array.isArray(record.tables)
      ? record.tables.map((table, index) => {
          const tableRecord = asRecord(table) ?? {};
          return {
            id: String(tableRecord.id ?? `table-${index}`),
            name: String(tableRecord.name ?? tableRecord.table_no ?? "未命名桌台"),
            area: String(tableRecord.area ?? tableRecord.floor_name ?? "未分區"),
            floorId: tableRecord.floorId ? String(tableRecord.floorId) : tableRecord.floor_id ? String(tableRecord.floor_id) : undefined,
          };
        })
      : [],
    rules: {
      orderFlow: "send_then_pay",
      allowSplitBill: Boolean(rulesRecord.allowSplitBill ?? rulesRecord.allow_split_bill ?? false),
      allowMemberLookup: Boolean(rulesRecord.allowMemberLookup ?? rulesRecord.allow_member_lookup ?? false),
      taxRate: Number(rulesRecord.taxRate ?? rulesRecord.tax_rate ?? 0),
      serviceChargeRate: Number(rulesRecord.serviceChargeRate ?? rulesRecord.service_charge_rate ?? 0),
      paymentMethods: Array.isArray(rulesRecord.paymentMethods ?? rulesRecord.payment_methods)
        ? ((rulesRecord.paymentMethods ?? rulesRecord.payment_methods) as string[])
        : [],
    },
    printerGroups: Array.isArray(record.printerGroups ?? record.printer_groups)
      ? ((record.printerGroups ?? record.printer_groups) as PosBootstrap["printerGroups"])
      : ["kitchen", "drinks", "receipt"],
    lastUpdatedAt: String(record.lastUpdatedAt ?? record.last_updated_at ?? new Date().toISOString()),
  };
}
