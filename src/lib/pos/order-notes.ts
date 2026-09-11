// 訂單「折扣備註」推導（2026-09-11 需求 #2）。
//
// 需求：凡訂單套用過任何**影響實收價格**嘅調整（折扣 / 免單 / 系統抹零），
// 其對應備註原因都要顯示喺報表、訂單紀錄、交班明細，令每筆價格變動來源可追溯。
//
// 呢個模組係**唯一**推導入口 —— 三個地方（報表明細 / 交班明細 / 訂單紀錄）
// 都叫呢度，避免各自寫一套而漂移。
//
// 資料來源分佈（唔好搞亂）：
//   - 全單折扣原因：`PosOrder.discountNote`（結帳頁彈窗硬閘，有 discountAmount 就必有）
//   - 免單原因：    `PosOrder.compNote`（免單有自己嘅審計欄；免單時 discountNote 會被清空）
//   - 單品折扣原因：`OrderItem.discountNote`（逐件存，同一原因多件 → 去重顯示一次）
//   - 系統抹零：    冇「原因」可揀（系統自動），固定顯示「系統抹零」
//   - Ledger 線上單折扣：只有金額冇原因文字 → 固定顯示「線上優惠」

import type { PosOrder } from "@/lib/types";

/** 折扣備註分類（決定 chip 顏色）：折扣 / 免單 / 系統抹零。 */
export type OrderDetailNoteKind = "discount" | "comp" | "round";

export interface OrderDetailNote {
  kind: OrderDetailNoteKind;
  /** 顯示文字，例如「員工優惠」「客人投訴補償」「系統抹零」「線上優惠」。 */
  text: string;
}

/**
 * 由一張本地訂單推導折扣備註清單。
 *
 * 排序：訂單級原因（免單 / 全單折扣）→ 單品折扣原因 → 系統抹零。
 * 去重：同一段文字只出一個 chip（例如全單同單品都揀咗「員工優惠」）。
 */
export function buildOrderDetailNotes(order: PosOrder): OrderDetailNote[] {
  const notes: OrderDetailNote[] = [];
  const seen = new Set<string>();
  const push = (kind: OrderDetailNoteKind, raw: string | undefined) => {
    const text = (raw ?? "").trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    notes.push({ kind, text });
  };

  // 訂單級：免單優先（免單時折扣備註已被清空，唔會兩個同時出現）
  if (order.compNote?.trim()) {
    push("comp", order.compNote);
  } else {
    push("discount", order.discountNote);
  }

  // 單品級：逐件讀原因，去重
  for (const item of order.items ?? []) {
    if (item.discountRate == null || item.discountRate >= 100) continue;
    push("discount", item.discountNote);
  }

  // 系統抹零：冇人揀過原因，固定文案（有抹零金額先顯示）
  if ((order.roundingAmount ?? 0) > 0) {
    push("round", "系統抹零");
  }

  return notes;
}

/**
 * Ledger 純線上單嘅折扣備註。
 *
 * Ledger 側只有 `discountAmount`（金額），冇折扣原因文字 → 只能顯示通用文案。
 * 若日後 Ledger 契約補上原因欄，改呢度一個地方即可。
 */
export function buildOnlineOrderDetailNotes(discountAmount?: number): OrderDetailNote[] {
  return (discountAmount ?? 0) > 0 ? [{ kind: "discount", text: "線上優惠" }] : [];
}
