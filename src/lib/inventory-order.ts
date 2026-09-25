/**
 * 庫存「主檔」顯示次序嘅**純函式**（零 import）。
 *
 * 🔴 為何要另開一個檔而唔係塞入 `inventory-stats.ts`：
 * 本專案嘅 `npm test` 係 `node --test`，**唔識解析 `@/` alias**。所以只有
 * 「零 import」嘅模組先可以被測試檔直接 import（見 docs/113 同 CLAUDE.md）。
 * `inventory-stats.ts` 有 `@/lib/ledger/...` import ⇒ 一 import 就爆。
 *
 * 呢個檔嘅職責只有一個：**由「儲存咗嘅次序」＋「當前清單」算出顯示次序**，
 * 以及提供拖拽排序用嘅「由 A 移到 B」。刻意唔碰 localStorage／React／fetch。
 */

/**
 * 依 `order` 重排 `list`。
 *
 * 規則（三條，缺一不可）：
 *   1. 喺 `order` 入面嘅項目**依 order 排**；
 *   2. **唔喺 `order` 入面嘅（新建立嘅）項目排最後**，並保持原本嘅相對次序
 *      —— 新供應商一定要「撳完新增就見到」，唔可以因為排序設定而失蹤；
 *   3. `order` 入面已經唔存在嘅名（已被刪除）自動被忽略，唔會產生空洞。
 *
 * `keyOf` 而唔係直接比字串：清單可能係物件（`{id,name}`）亦可能係字串（品類）。
 *
 * ⚠️ 用**名**做 key 而唔係 id：供應商係「刪咗再建就換 id」，用品類名／供應商名
 * 做 key 先可以跨重建保住排序。（撞名唔怕：供應商同品類都各自唯一。）
 */
export function reorderByStored<T>(list: T[], order: string[], keyOf: (item: T) => string): T[] {
  if (!Array.isArray(order) || order.length === 0) return list.slice();
  const index = new Map<string, number>();
  order.forEach((key, i) => {
    if (typeof key === "string" && key && !index.has(key)) index.set(key, i);
  });
  if (index.size === 0) return list.slice();

  const known: Array<{ item: T; pos: number }> = [];
  const rest: T[] = [];
  list.forEach((item) => {
    const pos = index.get(keyOf(item));
    if (pos === undefined) rest.push(item);
    else known.push({ item, pos });
  });
  known.sort((a, b) => a.pos - b.pos);
  return [...known.map((k) => k.item), ...rest];
}

/**
 * 由 `from` 移到 `to`（回傳新陣列，唔改原陣列）。
 *
 * `to` 係**目標索引**（己經按「插入後」嘅語意）：由 0 拖到 3 就會變成
 * `[b, c, d, a, ...]`。索引越界／同一個位 → 回傳原內容嘅淺 copy（呼叫端可以
 * 用 `from === to` 短路，唔會產生多餘寫入）。
 */
export function moveWithin<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  if (!Number.isInteger(from) || !Number.isInteger(to)) return next;
  if (from < 0 || from >= next.length) return next;
  if (to < 0) to = 0;
  if (to > next.length - 1) to = next.length - 1;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * 由「未信任嘅來源」（localStorage / 雲端 jsonb）讀返唻嘅次序陣列清洗。
 *
 * 回傳 `null` ＝**根本唔係陣列**（從未設定過），叫呼叫端用預設值；
 * 回傳 `[]` ＝設定過但清空（要尊重，唔可以補預設，否則商家清唔走）。
 * 呢個「`null` vs `[]`」嘅區分同 `normalizePaymentMethods()` 一模一樣。
 *
 * 清洗內容：剔走非字串、trim、剔空、去重、保留次序。
 */
export function sanitizeKeyList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const strings: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") strings.push(item);
  }
  return orderKeys(strings, (x) => x);
}

/**
 * 把「當前次序」壓成要儲存嘅 key 陣列（＝去重、剔空、保持次序）。
 *
 * 儲存側同讀取側用同一支轉換，係咗避免「存咗一份有重複／有空字串嘅 order，
 * 讀返出嚟排序同儲存時唔一致」呢類好難查嘅漂移。
 */
export function orderKeys<T>(list: T[], keyOf: (item: T) => string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const key = keyOf(item);
    if (typeof key !== "string") continue;
    const trimmed = key.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * 由 `usage`（key → 次數）取一個可以顯示嘅次數。
 *
 * 🔴 點解要經一支函式而唔係 `usage[key] ?? 0`：
 * 呢個 map 係由**另一個專案嘅 DB** 聚合返嚟（`raw_ocr_data` 之類），
 * key 可能係 uuid 而前端手上係 string；而且次數可能係 `"14"` 字串。
 * 唔統一，`0` 同 `"0"` 會令 JSX 出現 `用過 0 次` vs 完全唔顯示兩種結果。
 */
export function usageCount(usage: Record<string, number> | null | undefined, key: string): number {
  if (!usage || typeof key !== "string" || !key) return 0;
  const raw = usage[key];
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
