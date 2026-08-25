import type { PrintJob } from "@/lib/types";

/**
 * 以本地（localStorage）print jobs 為底，合併後台 / 外部傳入嘅 print jobs。
 *
 * 狀態主權契約（見 docs/37-printjobs-backfill-rootcause-plan.md P2-5）：
 *  - server `pos_print_jobs` 係「存在性」真源（呢度只決定「有冇呢張單」）
 *  - 本機 localStorage 係「派發狀態（sent/failed）」真源 → 唔可以後台落後嘅 `pending`
 *    覆寫本地 `sent`（否則 flush worker 當佢未印 → 再印 → 無限重印）
 *
 * 合併規則：
 *  1. 同 id → 留本地版本（保留 sent/failed 派發狀態）
 *  2. 本地有、incoming 冇 → 原樣保留（絕不刪本地單，防離線新單被 backfill 清走）
 *  3. incoming 有、本地冇 → 補入（跨終端 / realtime 漏咗嘅單喺 backfill 見返）
 */
export function mergePrintJobs(
  local: PrintJob[],
  incoming: PrintJob[],
  clearedIds?: string[] | Set<string>,
): PrintJob[] {
  const cleared = clearedIds instanceof Set ? clearedIds : new Set(clearedIds ?? []);
  const localById = new Map(local.map((j) => [j.id, j]));
  const merged: PrintJob[] = [];
  const seen = new Set<string>();
  for (const j of incoming) {
    seen.add(j.id);
    // 本機已主動清除（tombstone）→ 唔補回，否則 backfill 會將伺服器未刪行復活（見 docs/52）
    if (cleared.has(j.id)) continue;
    merged.push(localById.get(j.id) ?? j); // 本地有就用本地（保留 sent/failed）
  }
  for (const j of local) {
    if (!seen.has(j.id)) merged.push(j); // 本地獨有 → 保留
  }
  return merged;
}
