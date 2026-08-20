# 39 · Ledger 反向調整 RPC 需求書（餐飲返結回滾用）

> 狀態：需求已定（2026-08-20），待同事喺 Ledger 後端實作。
> 對應：docs/38 §7（返結 / 反結賬）。
> 影響範圍：餐飲 `reopenPosOrder` 嘅會員餘額反向回滾（美容 v1 已用本地 mock，唔經此 RPC）。

## 1. 背景

餐飲 POS 結帳時會經 `merchant_apply_pos_txn`（`p_type:"deduct"`）扣會員餘額。
返結（reopen）要把該筆扣減退回客戶，現階段 **無對應 `add` / `credit` 分支**，所以 POS 端 `applyPosAdd` 目前只會 best-effort 嘗試、失敗就 local flip 狀態 + toast 提示，未真正沖 Ledger。

本文件係交同事嘅需求：喺 `merchant_apply_pos_txn` 加 `p_type:"add"` 分支（或用新 RPC），令返結可以真正退回會員餘額。

## 2. 需求

### 2.1 新增 `p_type: "add"` 分支（preferred，複用現有 RPC）

`merchant_apply_pos_txn(p_merchant_id, p_type, p_phone, p_amount_avos, p_idempotency_key)`

- `p_type = "add"`：向 `p_phone` 會員 **加回** `p_amount_avos` 餘額（即 deduct 嘅反向）。
- 回傳同 deduct 一致：`{ txn_id, amount_avos, balance_after }`。
- 冪等：`p_idempotency_key` 同 deduct 共用邏輯，重複 key 唔好重複加。
- 校驗：`p_amount_avos > 0`，`p_phone` 必須存在於該 merchant 下。

### 2.2 或者：新 RPC `merchant_reverse_pos_txn`（備選）

若唔想擴充 `merchant_apply_pos_txn`，可新開：

`merchant_reverse_pos_txn(p_merchant_id, p_phone, p_amount_avos, p_idempotency_key, p_reason?)`

語義同上（`add` 餘額）。

## 3. 現有 POS 端接線（無需同事改動）

`src/lib/ledger/members.ts` 已加 `applyPosAdd`，內部 call：

```ts
client.rpc("merchant_apply_pos_txn", {
  p_merchant_id: params.merchantId,
  p_type: "add",                       // ← 現後端若無此分支會報錯
  p_phone: params.phone,
  p_amount_avos: params.amountAvos,
  p_idempotency_key: params.idempotencyKey,
});
```

`src/lib/pos-orders.ts` 嘅 `reopenPosOrder` 會 catch 錯誤、local flip 狀態並繼續，所以 **RPC 到位前唔會阻塞工人返結操作**，只係未真正沖 Ledger。

## 4. 驗收

- [ ] `p_type:"add"` 可向會員加回餘額，回傳 `balance_after` 正確。
- [ ] 同 idempotency_key 重複呼叫只加一次。
- [ ] `p_amount_avos <= 0` / `p_phone` 不存在時回合理錯誤。
- [ ] POS 端 `reopenPosOrder` 喺 RPC 到位後，會員餘額確實退回（無需改 POS 代碼）。

## 5. 暫不涵蓋（後續）

- 餐飲會員 **積分** 嘅返結回滾：目前餐飲結帳未見積分扣減路徑（積分主要喺美容 loyalty）。若日後餐飲引入積分扣減，需同時加 `add` 分支嘅 points 維度（或獨立 `merchant_adjust_points`）。
- 美容真 Ledger 對接：`ledgerOrderId` 留 seam，待美容接真 Ledger 時再處理（見 docs/38 §7）。
