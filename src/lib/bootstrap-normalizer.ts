import { MenuItem, MenuSpecGroup, PosBootstrap } from "@/lib/types";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" ? (value as UnknownRecord) : null;
}

function resolveOptionPriceDeltaMop(optionRecord: UnknownRecord): number {
  // Ledger 匯入以 avos 為準；先讀 avos，避免舊資料 priceDelta: 0 蓋掉 price_delta_avos
  const avos =
    optionRecord.price_delta_avos ??
    optionRecord.extra_price_avos ??
    optionRecord.addon_price_avos ??
    optionRecord.delta_avos;
  if (avos != null && avos !== "") {
    const parsed = Math.round(Number(avos));
    if (Number.isFinite(parsed) && parsed !== 0) {
      return parsed / 100;
    }
  }

  if (optionRecord.priceDelta != null && optionRecord.priceDelta !== "") {
    return Number(optionRecord.priceDelta) || 0;
  }
  if (optionRecord.price_delta != null && optionRecord.price_delta !== "") {
    return Number(optionRecord.price_delta) || 0;
  }
  if (optionRecord.extra_price != null && optionRecord.extra_price !== "") {
    return Number(optionRecord.extra_price) || 0;
  }

  // 選項本體 price_avos（非菜品 base price）僅在無其他加價欄位時視為加價
  const optionPriceAvos = optionRecord.price_avos ?? optionRecord.priceAvos;
  if (optionPriceAvos != null && optionPriceAvos !== "") {
    const parsed = Math.round(Number(optionPriceAvos));
    if (Number.isFinite(parsed) && parsed !== 0) {
      return parsed / 100;
    }
  }

  return 0;
}

function normalizeSpecOptions(raw: unknown, groupIndex: number): MenuSpecGroup["options"] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((option, optionIndex) => {
      const optionRecord = asRecord(option);
      if (!optionRecord) return null;
      return {
        id: String(
          optionRecord.id ??
            optionRecord.option_id ??
            optionRecord.choice_id ??
            optionRecord.value_id ??
            `opt-${groupIndex}-${optionIndex}`,
        ),
        label: String(
          optionRecord.label ??
            optionRecord.name ??
            optionRecord.option_name ??
            optionRecord.choice_name ??
            optionRecord.value ??
            "未命名選項",
        ),
        priceDelta: resolveOptionPriceDeltaMop(optionRecord),
      };
    })
    .filter((option): option is NonNullable<typeof option> => Boolean(option));
}

export function normalizeSpecGroups(raw: unknown): MenuSpecGroup[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const groups = raw
    .map((group, groupIndex) => {
      const record = asRecord(group);
      if (!record) return null;

      const optionsRaw = Array.isArray(record.options)
        ? record.options
        : Array.isArray(record.spec_options)
          ? record.spec_options
          : Array.isArray(record.choices)
            ? record.choices
            : Array.isArray(record.values)
              ? record.values
              : Array.isArray(record.items)
                ? record.items
                : [];

      const options = normalizeSpecOptions(optionsRaw, groupIndex);

      const selectionRaw = record.selectionMode ?? record.selection_mode ?? record.type;
      const isMulti =
        record.multi_select === true ||
        record.multiSelect === true ||
        String(selectionRaw).toLowerCase() === "multi";

      return {
        id: String(record.id ?? record.group_id ?? record.modifier_group_id ?? `grp-${groupIndex}`),
        name: String(record.name ?? record.group_name ?? record.title ?? "未命名規格"),
        selectionMode: isMulti ? "multi" : "single",
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
