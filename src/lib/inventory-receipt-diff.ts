// 收據品項嘅 content-diff（取代 PATCH 嘅 delete-then-insert）。
//
// 🔴 零 import —— 可以被 `node --test` 直接跑（runner 唔認 `@/` alias、唔認 .tsx）。
//    node --test src/lib/inventory-receipt-diff.test.ts
//
// 為何要 diff 而唔係「先刪再插」：
//   舊做法（PATCH /api/inventory/receipts/[id]）先 `delete().eq("receipt_id", id)`
//   再 `insert(itemRows)`。若 insert 失敗（例如 receipt_items.quantity_unit 欄未加
//   ⇒ 42703），原本嘅品項已經被 delete 清走 ⇒ 商家見到「原有品項無故消失」。
//   diff 嘅順序係 **insert → update → delete**，任何一步失敗都唔會丟掉
//   已經存在嘅品項（delete 排最後，而且只刪「多咗出嚟」嗰幾行）。

/** 品項嘅可比內容（唔含 receipt_id / user_id / id）。 */
export type ReceiptItemContent = {
  name: string;
  unit_price: number;
  quantity: number;
  quantity_unit: string;
};

/** 數據庫既有品項（帶主鍵 id）。 */
export type ExistingReceiptItem = ReceiptItemContent & { id: string };

export type ReceiptItemDiff = {
  toInsert: ReceiptItemContent[];
  toUpdate: Array<{ id: string } & ReceiptItemContent>;
  toDelete: string[];
};

function sameContent(a: ReceiptItemContent, b: ReceiptItemContent): boolean {
  return (
    a.name === b.name &&
    a.unit_price === b.unit_price &&
    a.quantity === b.quantity &&
    (a.quantity_unit ?? "") === (b.quantity_unit ?? "")
  );
}

/**
 * 收據品項嘅 content-diff。
 *
 * 配對策略＝**按位置（positional）**：
 *   existing[0] 對 desired[0]、existing[1] 對 desired[1] ……
 *   - 兩者內容相同 → 唔使動；
 *   - 唔同 → update existing[i] 成 desired[i]；
 *   - desired 比較長 → 多出來嘅 desired 做 insert；
 *   - existing 比較長 → 多咗出嚟嘅 existing 做 delete。
 *
 * ⚠️ 呢個 modal 冇「品項重排」功能，品項順序即係用戶輸入順序，
 *    所以 positional 配對喺「新增／修改／刪除（含中間刪除）」三種場景下
 *    最終狀態都正確（中間刪除會被近視為「後面嘅行往上移位」，
 *    最後多咗出嚟嗰行先至 delete，唔會誤刪中間仲要用嘅品項）。
 */
export function diffReceiptItems(existing: ExistingReceiptItem[], desired: ReceiptItemContent[]): ReceiptItemDiff {
  const toInsert: ReceiptItemContent[] = [];
  const toUpdate: Array<{ id: string } & ReceiptItemContent> = [];
  const toDelete: string[] = [];

  const n = Math.max(existing.length, desired.length);
  for (let i = 0; i < n; i++) {
    const ex = existing[i];
    const de = desired[i];
    if (ex && de) {
      if (!sameContent(ex, de)) {
        toUpdate.push({
          id: ex.id,
          name: de.name,
          unit_price: de.unit_price,
          quantity: de.quantity,
          quantity_unit: de.quantity_unit,
        });
      }
    } else if (!ex && de) {
      toInsert.push({ name: de.name, unit_price: de.unit_price, quantity: de.quantity, quantity_unit: de.quantity_unit });
    } else if (ex && !de) {
      toDelete.push(ex.id);
    }
  }
  return { toInsert, toUpdate, toDelete };
}
