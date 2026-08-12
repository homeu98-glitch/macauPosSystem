import { normalizeSpecGroups } from "@/lib/bootstrap-normalizer";
import { MenuSpecGroup } from "@/lib/types";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" ? (value as UnknownRecord) : null;
}

function collectSpecSources(record: UnknownRecord): unknown[] {
  const sources = [
    record.spec_groups,
    record.specGroups,
    record.modifier_groups,
    record.modifierGroups,
    record.product_modifiers,
    record.modifiers,
    record.options,
  ];

  const ids = record.modifier_group_ids ?? record.modifierGroupIds ?? record.spec_group_ids;
  return sources.filter((value) => value != null).concat(Array.isArray(ids) ? [ids] : []);
}

function resolveGroupsFromIds(
  ids: unknown,
  groupIndex: Map<string, UnknownRecord>,
): MenuSpecGroup[] | undefined {
  if (!Array.isArray(ids)) return undefined;
  const matched = ids
    .map((id) => groupIndex.get(String(id)))
    .filter((row): row is UnknownRecord => row != null);
  return normalizeSpecGroups(matched);
}

/** Parse Ledger `list_merchant_order_menu` product spec/modifier fields. */
export function parseLedgerProductSpecGroups(
  product: UnknownRecord,
  menuRoot?: UnknownRecord | null,
): MenuSpecGroup[] | undefined {
  const groupIndex = new Map<string, UnknownRecord>();
  const rootGroups = [
    ...(Array.isArray(menuRoot?.modifier_groups) ? (menuRoot!.modifier_groups as unknown[]) : []),
    ...(Array.isArray(menuRoot?.modifierGroups) ? (menuRoot!.modifierGroups as unknown[]) : []),
    ...(Array.isArray(menuRoot?.spec_groups) ? (menuRoot!.spec_groups as unknown[]) : []),
    ...(Array.isArray(menuRoot?.specGroups) ? (menuRoot!.specGroups as unknown[]) : []),
  ];

  for (const raw of rootGroups) {
    const record = asRecord(raw);
    if (!record) continue;
    const id = String(record.id ?? record.group_id ?? record.modifier_group_id ?? "").trim();
    if (id) groupIndex.set(id, record);
  }

  for (const source of collectSpecSources(product)) {
    if (Array.isArray(source) && source.length > 0 && typeof source[0] === "string") {
      const fromIds = resolveGroupsFromIds(source, groupIndex);
      if (fromIds?.length) return fromIds;
      continue;
    }

    const parsed = normalizeSpecGroups(source);
    if (parsed?.length) return parsed;
  }

  return undefined;
}

export function formatSpecGroupsSummary(specGroups?: MenuSpecGroup[]): string {
  if (!specGroups?.length) return "無規格";
  return specGroups
    .map((group) => {
      const options = group.options
        .slice(0, 3)
        .map((opt) => (opt.priceDelta > 0 ? `${opt.label}(+${opt.priceDelta})` : opt.label))
        .join("、");
      const suffix = group.options.length > 3 ? "…" : "";
      return `${group.name}: ${options}${suffix}`;
    })
    .join(" · ");
}
