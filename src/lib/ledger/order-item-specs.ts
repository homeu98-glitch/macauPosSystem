/**
 * Ledger 訂單明細 → 「已選規格（selectedSpecs）」解析 —— **零依賴純函式**。
 *
 * ## 為咩要有呢個模組（2026-09-13 商家實案）
 *
 * 商家附實紙：Ledger 自己印嘅單有規格（`飲料:湯`／`加熱:熱 +5`／`加購:蒸蛋 +10`），
 * 但 **POS 廚房單一條規格都冇**。
 *
 * 根因：Ledger → POS 嘅投影路徑**從來冇建立 `OrderItem.selectedSpecs`**：
 *   - `getOrderDetail()`（`ledger/orders.ts`）解析 RPC 時只讀名／量／價／note／折扣；
 *   - `mapDetailToOrderItems()`（`ledger/ledger-pos-bridge.ts`）建 `OrderItem` 時冇 `selectedSpecs`。
 * 而下游（`toPrintItemLine` / `toPrintItemLines` / `print-jobs.ts` / `buildLabelContent`）
 * **全部已經支援**規格 → 只需補上游一格。
 *
 * ## 點解要「防禦式多欄名」
 *
 * 🔴🔴 **2026-09-13 實機已確認**：Ledger `get_order_detail` 回嘅 item 明細係
 *
 * ```jsonc
 * {
 *   "id": "...", "product_id": "...", "name": "快閃餐(沙姜炒豬頸肉饭)",
 *   "qty": 1, "line_note": null, "unit_price_avos": 5300,
 *   "promo_applied_qty": null, "promo_rate_permille": null,
 *   "discounted_unit_price_avos": null,
 *   "selected_specs": [                                   // ← 就係呢個
 *     { "group_name": "飲料", "option_name": "檸茶", "price_delta_avos": 200 },
 *     { "group_name": "熱定凍", "option_name": "凍",  "price_delta_avos": 200 },
 *     { "group_name": "加購",  "option_name": "蒸蛋", "price_delta_avos": 500 },
 *     { "group_name": "要唔要膠袋?", "option_name": "不要" }
 *   ]
 * }
 * ```
 *
 * 但**唔可以**因此寫死單一欄名 —— Ledger 改版就會靜默壞（同 2026-09-13 漏咗
 * `selected_specs` 造成「實機冇規格、單元測試全綠」係同一個死法）。
 * 所以照 `menu-spec.ts:collectSpecSources` 同一手法：**系統化窮舉 + 逐個試**。
 *
 * ⚠️ 呢個檔**唔可以 import 任何 runtime 依賴**（`node --test` 要直接載入）。
 *
 * @see src/lib/ledger/menu-spec.ts（餐牌側同一手法嘅先例）
 * @see src/lib/pos/online-dinein-labels.ts（同一「零依賴模組」做法）
 */

/** 一條「已選規格」。同 `OrderItem["selectedSpecs"][number]` 結構一致（刻意本地定義保持零依賴）。 */
export type ParsedOrderSpec = {
  groupId?: string;
  groupName?: string;
  optionId?: string;
  optionLabel?: string;
  /** 加價（**MOP**，唔係 avos）。0 / undefined = 冇加價。 */
  priceDelta?: number;
};

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function pickString(rec: Rec, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/**
 * 由 record 抽一個「加價」數值（回傳 **MOP**）。
 *
 * ⚠️ 單位陷阱：Ledger 好多欄位用 avos（分）。
 *    - 欄名**含 `avos`** → 除 100；
 *    - 其餘（`price_delta` / `delta` / `extra_price` …）→ 當佢已經係 MOP
 *      （實紙所見 `+10` / `+5` / `+1` 都係 MOP）。
 */
function pickPriceDeltaMop(rec: Rec): number | undefined {
  const avosKeys = [
    "price_delta_avos",
    "priceDeltaAvos",
    "delta_avos",
    "deltaAvos",
    "extra_price_avos",
    "extraPriceAvos",
    "surcharge_avos",
    "surchargeAvos",
    "amount_avos",
    "amountAvos",
    "price_avos",
  ];
  for (const key of avosKeys) {
    const value = rec[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.round(value) / 100;
    }
  }

  const mopKeys = [
    "price_delta",
    "priceDelta",
    "delta",
    "delta_mop",
    "extra_price",
    "extraPrice",
    "surcharge",
    "amount",
    "amount_mop",
    "price",
  ];
  for (const key of mopKeys) {
    const value = rec[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

const GROUP_ID_KEYS = ["group_id", "groupId", "spec_group_id", "modifier_group_id"] as const;
const GROUP_NAME_KEYS = [
  "group_name",
  "groupName",
  "spec_group_name",
  "modifier_group_name",
  "group_label",
  "groupLabel",
  "group_title",
  "group",
] as const;
const OPTION_ID_KEYS = [
  "option_id",
  "optionId",
  "spec_option_id",
  "modifier_option_id",
  "choice_id",
  "value_id",
] as const;
const OPTION_LABEL_KEYS = [
  "option_label",
  "optionLabel",
  "option_name",
  "optionName",
  "spec_option_name",
  "label",
  "choice_name",
  "value",
  "text",
  "title",
  "name",
] as const;

/**
 * 整條「規格文字」欄位 —— Ledger 自家印單就係 `群組:選項` 格式
 * （實紙：`*要唔要袋:唔要`／`*飲料:湯`／`*加購:蒸蛋 +10`）。
 * 若 RPC 直接回一段文字而唔係結構化陣列，就靠呢批欄名接住。
 */
const SPEC_TEXT_KEYS = [
  "spec_text",
  "specText",
  "specs_text",
  "specsText",
  "option_text",
  "optionText",
  "options_text",
  "optionsText",
  "modifier_text",
  "modifierText",
  "modifiers_text",
  "modifiersText",
  "customization_text",
  "customizationText",
  "customisation_text",
  "spec_summary",
  "specSummary",
  "specs_summary",
  "specsSummary",
  "options_summary",
  "optionsSummary",
  "extras_text",
  "addons_text",
] as const;

/**
 * 拆「`群組:選項`」文字做多條規格。
 *
 * - 分隔符：`\n` / `;` / `|`；若成段只有一個 `:` 以外嘅多個 `:`，再試 `,` / `、`。
 * - 剝走 Ledger 印單嘅項目符號前綴（`*` / `-` / `·` / `•`）。
 * - 尾綴 `+10` / `-$5` / ` $5` → `priceDelta`（MOP），並由 label 剝走。
 */
function parseSpecText(text: string): ParsedOrderSpec[] {
  const raw = text.trim();
  if (!raw) return [];

  let parts = raw
    .split(/[\n;|]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1 && (raw.match(/[:：]/g)?.length ?? 0) > 1) {
    parts = raw
      .split(/[,、]+/)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  const out: ParsedOrderSpec[] = [];
  for (const part of parts) {
    const cleaned = part.replace(/^[*\-–·•]\s*/, "").trim();
    const separatorIndex = cleaned.search(/[:：]/);
    if (separatorIndex < 0) continue;

    const groupName = cleaned.slice(0, separatorIndex).trim();
    let optionLabel = cleaned.slice(separatorIndex + 1).trim();
    if (!optionLabel) continue;

    let priceDelta: number | undefined;
    // Ledger 自家格式係 `+10` / `-$5`；亦容忍冇符號嘅 `$10`（當正數）。
    // 刻意**唔**認「蒸蛋 10」呢種冇符號又冇 `$` 嘅尾數（怕誤吞真實文字）。
    const signed = optionLabel.match(/\s*([+-])\s*\$?\s*(\d+(?:\.\d+)?)\s*$/);
    const dollarOnly = signed ? null : optionLabel.match(/\s*\$\s*(\d+(?:\.\d+)?)\s*$/);
    const priceMatch = signed ?? dollarOnly;
    if (priceMatch && priceMatch.index != null) {
      const magnitude = Number(signed ? priceMatch[2] : priceMatch[1]);
      if (Number.isFinite(magnitude) && magnitude > 0) {
        priceDelta = signed && priceMatch[1] === "-" ? -magnitude : magnitude;
        optionLabel = optionLabel.slice(0, priceMatch.index).trim();
      }
    }
    if (!optionLabel) continue;

    out.push({
      groupName: groupName || undefined,
      optionLabel,
      priceDelta,
    });
  }
  return out;
}

/** entry 內部可能再包一層陣列入面先係選項（group 形式）。 */
const NESTED_KEYS = [
  "options",
  "selected_options",
  "selectedOptions",
  "values",
  "choices",
  "selected",
  "selections",
  "spec_options",
] as const;

/**
 * item 上可能裝住規格嘅容器欄名。
 *
 * 🔴🔴 **2026-09-13 實機確認：真正嘅欄名係 `selected_specs`**，
 * 形狀 `[{ group_name, option_name, price_delta_avos }]`（扁平平鋪，冇 nested options）。
 *
 * ⚠️ **血淚教訓**：第一版呢個清單係手寫猜嘅，只有 `spec_selections` / `specSelections` /
 * `selected_options` / `specs` —— **偏偏冇 `selected_specs`**，結果實機一個規格都 parse 唔到
 * （單元測試用 `selected_options` 所以全綠，捉唔到）。
 * ⇒ 所以改為**系統化窮舉**（`selected_*` × 名詞 × 單複數、camel/snake），
 * 唔再靠「估中」；真實欄名一律排最前。
 */
const CONTAINER_KEYS = [
  // ① 已確認（實機）
  "selected_specs",
  // ② 系統化窮舉：selected_*（snake / camel）
  "selectedSpecs",
  "selected_options",
  "selectedOptions",
  "selected_modifiers",
  "selectedModifiers",
  "selected_values",
  "selectedValues",
  "selected_choices",
  "selectedChoices",
  "selected_addons",
  "selectedAddons",
  "selected_extras",
  "selected_items",
  "selectedItems",
  // ③ spec_* / option_* / modifier_*
  "specs",
  "spec_options",
  "specOptions",
  "spec_selections",
  "specSelections",
  "spec_items",
  "specItems",
  "option_selections",
  "optionSelections",
  "option_values",
  "optionValues",
  "modifier_options",
  "modifierOptions",
  "modifier_selections",
  // ④ 其他常見
  "options",
  "modifiers",
  "choices",
  "selections",
  "addons",
  "add_ons",
  "extras",
  "customizations",
  "customisations",
] as const;

/**
 * 欄位名本身寫明係「已選」→ 信任佢，連冇文字嘅 id-only 規格都收。
 * 其餘欄名（例如 `options` / `modifiers`）可能係「全部可選項」清單 → 只收有文字或有 `selected:true` 嘅。
 */
function isExplicitlySelectedContainer(key: string): boolean {
  return (
    /^selected/i.test(key) ||
    key === "spec_selections" ||
    key === "specSelections" ||
    key === "selections"
  );
}

/** 「有冇被揀」旗標嘅候選 key。 */
const SELECTION_FLAG_KEYS = [
  "selected",
  "is_selected",
  "isSelected",
  "checked",
  "isChecked",
  "chosen",
  "is_chosen",
  "picked",
] as const;

function selectionFlag(rec: Rec): unknown {
  for (const key of SELECTION_FLAG_KEYS) {
    if (key in rec) return rec[key];
  }
  return undefined;
}

/** 有冇明確講「我係唔係被揀」（有 → 一定要係 `true` 先當已選）。 */
function hasSelectionFlag(rec: Rec): boolean {
  return SELECTION_FLAG_KEYS.some((key) => key in rec);
}

/** 明明 `false` → 唔係客人揀嘅（group 列出全部可選項時要過濾走）。 */
function isExplicitlyUnselected(rec: Rec): boolean {
  return selectionFlag(rec) === false;
}

/** 明明 `true` → 一定係客人揀嘅。 */
function isExplicitlySelected(rec: Rec): boolean {
  return selectionFlag(rec) === true;
}

/**
 * 攤平一層「group → 選項」結構。
 * group 形式例子：`{ group_name: "飲料", options: [{ name: "湯", selected: true }] }`
 *
 * ⚠️ 選取語義（防止把「全部可選項」當成已選，令廚房單印出一堆垃圾）：
 *   - 任何一個 child 帶旗標 → **只認 `selected === true`**；
 *   - 完全冇旗標 → 當列出嘅就係已選（但排除明確 `false`）。
 */
function flattenEntry(entry: Rec, allowIdOnly: boolean): ParsedOrderSpec[] {
  for (const key of NESTED_KEYS) {
    const nested = entry[key];
    if (!Array.isArray(nested) || nested.length === 0) continue;

    const groupName = pickString(entry, GROUP_NAME_KEYS);
    const groupId = pickString(entry, GROUP_ID_KEYS);

    // 純字串子項：`{ group_name: "飲料", options: ["湯", "可樂"] }`。
    // 同「冇旗標 → 當列出嘅就係已選」同一口徑；但要排除「一串 id」誤當標籤。
    if (nested.every((child) => typeof child === "string")) {
      return nested
        .map((child) => String(child).trim())
        .filter((label) => looksLikeHumanLabel(label))
        .map((label) => ({ groupId, groupName, optionLabel: label }));
    }

    const children = nested
      .map((child) => asRecord(child))
      .filter((child): child is Rec => child !== null);
    const anyFlag = children.some(hasSelectionFlag);

    return children
      .filter((child) => (anyFlag ? isExplicitlySelected(child) : !isExplicitlyUnselected(child)))
      .map((child): ParsedOrderSpec | null => {
        const optionId = pickString(child, OPTION_ID_KEYS);
        const picked = pickString(child, OPTION_LABEL_KEYS);
        // 冇文字 → 只有「明確已選」或者欄位本身寫明 selected* 先收 id-only
        //（之後由本地餐牌補返文字）。否則寧願唔出，好過出一行亂碼。
        if (!picked && !(optionId && (allowIdOnly || isExplicitlySelected(child)))) return null;
        return {
          groupId: pickString(child, GROUP_ID_KEYS) ?? groupId,
          groupName: pickString(child, GROUP_NAME_KEYS) ?? groupName,
          optionId,
          optionLabel: picked,
          priceDelta: pickPriceDeltaMop(child),
        };
      })
      .filter((spec): spec is ParsedOrderSpec => spec !== null);
  }
  return [];
}

/**
 * 分辨「人睇得明嘅選項文字」同「一串 id」。
 *
 * 用於**純字串**規格容器（冇 group/option 物件包住，冇 meta 可判斷）：
 * `["湯","可樂"]` 應該收；`["opt-a1b2c3d4e5","9f8e..."]` 應該丟。
 */
function looksLikeHumanLabel(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (/[\u3400-\u9fff]/.test(v)) return true; // 有中文字 → 一定係人話
  if (/\s/.test(v)) return true; // 有空格 → 多數係 "Milk Tea" 之類
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v)) return false; // UUID
  if (/^[a-z0-9_-]{12,}$/i.test(v)) return false; // 長 id 樣
  return v.length > 1;
}

/**
 * object map 容器：`{ "飲料": "檸茶" }`（group → 已選選項）。
 *
 * 只會喺容器欄名寫明 `selected*`（`allowIdOnly`）時被叫 —— 因為「map 入面列出嘅」
 * 究竟係「已選」定「全部可選項」冇辦法從結構分辨，靠欄名嘅語義去判斷。
 */
function parseObjectContainer(container: Rec, allowIdOnly: boolean): ParsedOrderSpec[] {
  const out: ParsedOrderSpec[] = [];
  for (const [rawKey, value] of Object.entries(container)) {
    const groupName = rawKey.trim();
    if (!groupName) continue;

    if (typeof value === "string") {
      if (value.trim()) out.push({ groupName, optionLabel: value.trim() });
      continue;
    }
    if (value === true) {
      out.push({ optionLabel: groupName });
      continue;
    }
    if (!Array.isArray(value) || !allowIdOnly) continue;

    for (const child of value) {
      if (typeof child === "string") {
        if (looksLikeHumanLabel(child)) out.push({ groupName, optionLabel: child.trim() });
        continue;
      }
      const rec = asRecord(child);
      if (!rec || isExplicitlyUnselected(rec)) continue;
      const label = pickString(rec, OPTION_LABEL_KEYS);
      const optionId = pickString(rec, OPTION_ID_KEYS);
      if (!label && !optionId) continue;
      out.push({
        groupName,
        optionId,
        optionLabel: label,
        priceDelta: pickPriceDeltaMop(rec),
      });
    }
  }
  return out;
}

/** 單條 selection：`{ group_name: "飲料", option_name: "湯" }` */
function parseSelection(entry: Rec, allowIdOnly: boolean): ParsedOrderSpec | null {
  if (isExplicitlyUnselected(entry)) return null;
  const optionId = pickString(entry, OPTION_ID_KEYS);
  const picked = pickString(entry, OPTION_LABEL_KEYS);
  // 冇「人睇得明嘅選項文字」：只有明確標示已選、或欄位名本身就係 selected*，
  // 先收 id-only（之後由本地餐牌補返文字）。
  if (!picked && !(optionId && (allowIdOnly || isExplicitlySelected(entry)))) return null;
  return {
    groupId: pickString(entry, GROUP_ID_KEYS),
    groupName: pickString(entry, GROUP_NAME_KEYS),
    optionId,
    optionLabel: picked,
    priceDelta: pickPriceDeltaMop(entry),
  };
}

/**
 * 由一件 Ledger 明細 item 抽「已選規格」。
 *
 * 會逐個候選欄名試（Ledger 欄名未確認），亦會處理兩種常見形狀：
 *   1. **扁平平鋪**：`options: [{ group_name, option_name }]`
 *   2. **group 包選項**：`options: [{ group_name, options: [{ name, selected }] }]`
 *
 * `extraSources` 容許 caller 併入其他可能位置（例如整個 item 本身）。
 * 攞唔到任何可讀規格 → 回 `[]`（行為同未修前一致，零回歸風險）。
 */
export function parseOrderItemSpecs(
  item: unknown,
  extraSources: readonly unknown[] = [],
): ParsedOrderSpec[] {
  const record = asRecord(item);
  if (!record) return [];

  const containers: Array<{ key: string; value: unknown }> = [
    ...CONTAINER_KEYS.map((key) => ({ key: key as string, value: record[key] })),
    ...extraSources.map((value, index) => ({ key: `extra-${index}`, value })),
  ];

  const out: ParsedOrderSpec[] = [];

  // ① 先試「整條規格文字」欄位（Ledger 自家單據格式：`飲料:湯`）。
  for (const key of SPEC_TEXT_KEYS) {
    const value = record[key];
    if (typeof value === "string") out.push(...parseSpecText(value));
  }

  // ② 再試結構化容器（陣列 / 文字）。
  for (const { key, value } of containers) {
    // 欄位名本身就寫明「已選」→ 連冇文字嘅 id-only 規格都收（之後由本地餐牌補文字）。
    const allowIdOnly = isExplicitlySelectedContainer(key);
    if (typeof value === "string") {
      out.push(...parseSpecText(value));
      continue;
    }
    if (!Array.isArray(value)) {
      // object map 形式：`{ "飲料": "檸茶" }`（只喺欄位名寫明 `selected*` 時信任）。
      const obj = allowIdOnly ? asRecord(value) : null;
      if (obj) out.push(...parseObjectContainer(obj, allowIdOnly));
      continue;
    }
    for (const entry of value) {
      if (typeof entry === "string") {
        out.push(...parseSpecText(entry));
        continue;
      }
      const entryRecord = asRecord(entry);
      if (!entryRecord) continue;
      const flattened = flattenEntry(entryRecord, allowIdOnly);
      if (flattened.length > 0) {
        out.push(...flattened);
        continue;
      }
      const single = parseSelection(entryRecord, allowIdOnly);
      if (single) out.push(single);
    }
  }
  return dedupeSpecs(out);
}

/** 同一個 group:option 只出一次（Ledger 可能同時回 `options` 同 `modifiers`）。 */
function dedupeSpecs(specs: ParsedOrderSpec[]): ParsedOrderSpec[] {
  const seen = new Set<string>();
  const out: ParsedOrderSpec[] = [];
  for (const spec of specs) {
    const key = `${spec.groupId ?? spec.groupName ?? ""}|${spec.optionId ?? spec.optionLabel ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(spec);
  }
  return out;
}

/** `OrderItem["selectedSpecs"][number]` 嘅結構（**全部必填**）——刻意本地定義保持零依賴。 */
export type ResolvedOrderSpec = {
  groupId: string;
  groupName: string;
  optionId: string;
  optionLabel: string;
  priceDelta: number;
};

/**
 * 收窄成 `OrderItem.selectedSpecs` 用嘅形狀（結構相容，可直接賦值）。
 *
 * - **冇 `optionLabel` 一律唔要**：寧願唔出，都好過出亂碼。
 * - `groupName` 缺失時填 `"規格"`：渲染層（`escpos-render.ts:formatSpecLine` 同
 *   `print-jobs.ts` / bridge 嘅 `${groupName}:${optionLabel}`）會印成 `:湯` ——
 *   一條開頭係冒號嘅行睇落似 bug。填個中性標籤好過留空。
 */
export function toResolvedSpecs(specs: readonly ParsedOrderSpec[]): ResolvedOrderSpec[] {
  return specs
    .filter((spec) => Boolean(spec.optionLabel?.trim()))
    .map((spec) => {
      const priceDelta = Number(spec.priceDelta ?? 0);
      return {
        groupId: spec.groupId ?? "",
        groupName: spec.groupName?.trim() || "規格",
        optionId: spec.optionId ?? "",
        optionLabel: spec.optionLabel ?? "",
        priceDelta: Number.isFinite(priceDelta) ? priceDelta : 0,
      };
    });
}

/** 本地餐牌嘅規格組（最小形狀，唔想 import `types.ts` 保持零依賴）。 */
export type LocalSpecGroup = {
  id: string;
  name: string;
  options: Array<{ id: string; label: string; priceDelta: number }>;
};

/**
 * 用**本地同步餐牌**補齊缺失嘅 group / option 文字。
 *
 * 商家口徑（2026-09-13）：「菜單跟我們是 in sync 的，他們線上的單我們應該都要有。」
 * ⇒ 本機 `MenuItem.specGroups` 帶齊 Ledger 嘅 group id / option id / label / priceDelta，
 *    所以就算 Ledger 只回 **id**（冇文字），都對得返出人話。
 *
 * 配對優先：optionId → optionLabel 撞名 → groupName+optionLabel。
 * 已經有齊 `groupName` + `optionLabel` 嘅一律原封不動。
 */
export function enrichSpecsFromMenu(
  specs: readonly ParsedOrderSpec[],
  groups: readonly LocalSpecGroup[] | undefined,
): ParsedOrderSpec[] {
  if (!specs.length || !groups?.length) return [...specs];
  const allGroups = groups;

  const groupById = new Map(allGroups.map((group) => [group.id, group]));
  const groupByName = new Map(allGroups.map((group) => [group.name, group]));

  type LocalOption = LocalSpecGroup["options"][number];

  function fill(spec: ParsedOrderSpec, group: LocalSpecGroup, option: LocalOption): ParsedOrderSpec {
    return {
      ...spec,
      groupId: spec.groupId ?? group.id,
      groupName: spec.groupName ?? group.name,
      optionId: spec.optionId ?? option.id,
      optionLabel: spec.optionLabel ?? option.label,
      priceDelta: spec.priceDelta ?? option.priceDelta,
    };
  }

  /** 最後手段：group 對唔到，就用 optionId 全餐牌掃一次（option id 實務上唯一）。 */
  function scanAllGroups(spec: ParsedOrderSpec): ParsedOrderSpec | null {
    if (!spec.optionId) return null;
    for (const candidate of allGroups) {
      const hit = candidate.options.find((option) => option.id === spec.optionId);
      if (hit) return fill(spec, candidate, hit);
    }
    return null;
  }

  return specs.map((spec) => {
    // 三樣都齊 → 冇嘢要補。
    if (spec.groupName && spec.optionLabel && spec.priceDelta != null) return spec;

    const group =
      (spec.groupId ? groupById.get(spec.groupId) : undefined) ??
      (spec.groupName ? groupByName.get(spec.groupName) : undefined);

    if (group) {
      const option =
        (spec.optionId ? group.options.find((candidate) => candidate.id === spec.optionId) : undefined) ??
        (spec.optionLabel
          ? group.options.find((candidate) => candidate.label === spec.optionLabel)
          : undefined);
      if (option) return fill(spec, group, option);

      // group 對到、但選項對唔到：至少補返 group 名，再試全餐牌掃 optionId。
      const withGroup: ParsedOrderSpec = {
        ...spec,
        groupId: spec.groupId ?? group.id,
        groupName: spec.groupName ?? group.name,
      };
      return scanAllGroups(withGroup) ?? withGroup;
    }

    return scanAllGroups(spec) ?? { ...spec };
  });
}
