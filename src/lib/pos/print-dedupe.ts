/**
 * 出紙「內容唯一鍵」去重 —— **同一張單、同一件事、同一部打印機，只可以出一張紙**。
 *
 * ## 為咩要有呢個模組（2026-09-21 商家實案）
 *
 * 訂單 001（線上單，Ledger 鏡像）在 **6.3 秒內出了 4 張收據**，雲端 `pos_print_jobs`
 * 查到 4 行、同一個 `order_id`、同一部收據機，但 `table_name` 一半係「堂食」、
 * 一半係「A01」（＝兩個唔同版本嘅訂單快照）。真因唔係「邊個 bug 印多咗」，
 * 而係**去重鍵根本唔存在**：
 *
 *   - `PrintJob.id` = `uid("print")` = 每次建 job 都係新 `crypto.randomUUID().slice(0,8)`
 *     → `mergePrintJobs()` 只按 `id` 去重 ⇒ **永遠攔唔到內容相同嘅重複**；
 *   - DB `pos_print_jobs` 亦冇任何內容唯一約束 ⇒ 一行一個 id，全部照出紙；
 *   - 唯一嘅守衛係 `print-jobs.ts` 嘅 60 秒 in-memory `Set`（`printReceiptForLedgerOrderOnce`），
 *     而佢係**每個瀏覽器 realm 一份**：開兩個視窗／分頁，兩個 realm 各自放行一次
 *     （商家 2026-09-21 親口確認「有在打開兩個視窗」）—— 呢個就係 4 張嘅直接機制。
 *     而且主介面嘅結帳路徑（`pos-app.tsx printReceipt()`）連呢個守衛都冇。
 *
 * ## 口徑：onceKey 由**呼叫端**宣告（自願參與）
 *
 * 唔可以一刀切「同一張單只出一次紙」—— 以下全部係**合法嘅重複**：
 *   - 加菜（`ticketType: "addon"`）：每一輪加單都應該出紙；
 *   - 退菜／返結（`ticketType: "void"`）：兩者 ticketType 一樣但係兩件事；
 *   - 手動「補打帳單 / 重打整單 / 補打廚房單」：用家撳幾次就要印幾次。
 *
 * ⇒ 所以鍵係 `orderId + onceKey + printerId`，而 **`onceKey` 只有必須「一件事一張紙」
 * 嘅自動路徑才會寫**（undefined = 唔參與去重，行為同以前一模一樣）。
 * 手動路徑同加菜／退菜／返結**一律唔寫** ⇒ 零迴歸風險。
 *
 * ⚠️ `onceKey` 一定要帶**世代計數**（例如收據用 `receipt:${reopenCount}`）：
 * 返結後重結係**第二次合法結帳**，同一張單要再出一張收據 —— 唔帶世代就會靜默唔出紙。
 *
 * ## 為咩唔用「內容 hash」
 *
 * 內容 hash 攔唔到呢個實案：4 張之中 2 張印「堂食」、2 張印「A01」，
 * hash 唔同 ⇒ 只會由 4 張變 2 張。唯一鍵要表達嘅係**訂單身分**，唔係快照文字。
 *
 * 零 import（`node --test` 唔行 bundler、唔認 `@/` 別名）—— 見 `print-dedupe.test.ts`。
 */

/** 去重只需要呢幾個欄位（結構式，避免同 `@/lib/types` 循環依賴）。 */
export interface PrintOnceSubject {
  orderId?: string;
  /** 打印機 id（缺省時退回 printerName，令同一部機嘅別名唔會當成兩部）。 */
  printerId?: string;
  printerName?: string;
  /**
   * **自動路徑專用**嘅一次性標籤，例如：
   *   - `receipt:0` → 第 0 代結帳收據（`reopenCount` 做世代）
   *   - `kitchen:normal:1` → 第 1 代落單／接單廚房單
   *   - `kitchen:void:ledger_cancel` → 線上單被取消嘅作廢單
   *
   * `undefined` / 空字串 = 呢張 job **唔參與**去重（手動補打、加菜、退菜、返結…）。
   */
  onceKey?: string;
}

/** 帳本上限：600 條 ≈ 覆蓋一日以上嘅自動出紙，足夠「同一件事唔重複」嘅實際窗口。 */
export const PRINT_ONCE_KEYS_MAX = 600;

function seg(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 砌內容唯一鍵。
 *
 * 格式：`${orderId}|${onceKey}|${printerId || printerName}`
 *
 * @returns 冇 `orderId` 或冇 `onceKey` → `null`（＝唔參與去重）。
 */
export function printOnceKey(job: PrintOnceSubject | null | undefined): string | null {
  if (!job) return null;
  const orderId = seg(job.orderId);
  const onceKey = seg(job.onceKey);
  if (!orderId || !onceKey) return null;
  const printer = seg(job.printerId) || seg(job.printerName);
  return `${orderId}|${onceKey}|${printer}`;
}

/**
 * 過濾掉「已經出過紙」嘅一次性 job。
 *
 * @param jobs 今次想入隊嘅 job（保持原順序）
 * @param seen 已知出過紙嘅鍵（本機帳本＋現存 job；`Set` 或陣列）
 * @returns `kept` = 可以入隊嘅；`skipped` = 被去重嘅鍵（呼叫端可 log／出提示）
 *
 * ⚠️ 同一批入面出現兩張同鍵（例如兩個 realm 嘅 job 被塞入同一批）亦會**只留第一張**。
 */
export function dedupeOnceJobs<T extends PrintOnceSubject>(
  jobs: readonly T[],
  seen: Iterable<string> | null | undefined,
): { kept: T[]; skipped: string[] } {
  const known = new Set<string>(seen ?? []);
  const kept: T[] = [];
  const skipped: string[] = [];
  for (const job of jobs ?? []) {
    const key = printOnceKey(job);
    if (!key) {
      kept.push(job); // 唔參與去重 → 永遠保留（手動／加菜／退菜／返結）
      continue;
    }
    if (known.has(key)) {
      skipped.push(key);
      continue;
    }
    known.add(key);
    kept.push(job);
  }
  return { kept, skipped };
}

/** 由一堆 job 抽出一次性鍵（記入帳本用；唔參與去重嘅 job 回唔到嘢）。 */
export function collectOnceKeys(jobs: readonly PrintOnceSubject[]): string[] {
  const keys: string[] = [];
  for (const job of jobs ?? []) {
    const key = printOnceKey(job);
    if (key) keys.push(key);
  }
  return keys;
}

/**
 * 由**已經存在嘅 job**（例如雲端 backfill 返落本機嘅別台機 job）推導出鍵。
 *
 * 用途：跨終端／換機時，本機帳本可能空，但 `loadPrintJobs()` 已經有嗰張 job
 * （`/api/pos/state` backfill 會落本機）⇒ 一併當「已出過紙」。
 */
export function seenKeysFromJobs(jobs: readonly PrintOnceSubject[]): string[] {
  return collectOnceKeys(jobs);
}

/** 帳本合併（去重 + 保留插入順序 + 由最舊開始掉，防 localStorage 無限累積）。 */
export function mergeOnceKeys(
  existing: readonly string[],
  added: readonly string[],
  max: number = PRINT_ONCE_KEYS_MAX,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of [...(existing ?? []), ...(added ?? [])]) {
    const value = seg(key);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : PRINT_ONCE_KEYS_MAX;
  return out.length > cap ? out.slice(-cap) : out;
}

/** FNV-1a 32-bit（純同步、無依賴；只做去重鍵嘅短簽名，唔係安全用途）。 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * 菜品內容簽名 —— **工作單**（廚房單／標籤單）嘅一次性鍵要包含佢。
 *
 * 為咩只有工作單需要：客人改單之後，廚房要收到**新內容**嘅一張紙。若果鍵只有
 * `orderId + scope`，改單補印就會被當成重複而**靜默唔出紙**（廚房永遠做舊單）。
 * 帶住內容簽名之後：
 *   - 同一次事件被兩個視窗各建一張 → 內容一樣 → 簽名一樣 → 收成一張 ✓
 *   - 客人改單後補印 → 內容唔同 → 新鍵 → 照出 ✓
 *
 * ⚠️ **收據刻意唔用**呢個簽名：收據係「每代結帳一張文件」，同一代結帳之間就算
 * 快照文字有出入（例如兩個視窗手上嘅訂單版本唔同：一個「堂食」一個「A01」），
 * 都係同一張文件 —— 呢個正係 2026-09-21 實案（4 張之中 2 張堂食、2 張 A01）。
 */
export function printOnceContentSignature(items: unknown): string {
  if (!Array.isArray(items) || items.length === 0) return "0";
  let raw = "";
  for (const item of items) {
    const row = (item ?? {}) as Record<string, unknown>;
    const specs = Array.isArray(row.specs) ? row.specs.map((v) => String(v ?? "")).join(",") : "";
    raw += `${String(row.name ?? "")}\u0001${String(row.quantity ?? "")}\u0001${String(
      row.price ?? "",
    )}\u0001${specs}\u0001${String(row.note ?? "")}\u0002`;
  }
  return fnv1a(raw);
}
