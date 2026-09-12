# 給 macauPosSystem 的 v3.5 掃碼自助扣餘額交接（可直接轉貼）

> **對象**：[homeu98-glitch/macauPosSystem](https://github.com/homeu98-glitch/macauPosSystem)  
> **日期**：2026-09-12  
> **權威契約**：[pos-ledger-client-api.md](pos-ledger-client-api.md) **§5.12**（以該檔為準；本文是實作清單）  
> **決策**：[ADR-039](../adr/ADR-039-pos-scan-debit.md)  
> **前置**：顧客登入仍看 [v3.4 交接](pos-v3.4-partner-handover-customer-login.md)（§4.5／§5.11）。  
> **不是**：顧客 JWT 打 `merchant_apply_pos_txn`。**不是**：Ledger `create_order`。**不是**：券核銷／積分折現／掃碼頁退款。

請把本檔 + 契約 §5.12 交給 POS Agent。

---

## 一句話

掃碼堂食預付：**POS 自己的單是權威**；Ledger **只扣該顧客在該店的餘額**（記帳，非託管）。流程：顧客 JWT 登入 → POS 核價寫待付 → **伺服器** `quote` →（PIN 再確認，登入未滿 3 分鐘可免，**只在 POS 做**）→ `commit` → 單已付、出廚。

---

## 環境（私下提供，勿進前端）

| 變數 | 誰持有 |
|------|--------|
| `NEXT_PUBLIC_SUPABASE_URL` / `ANON_KEY` | 與 v3.4 相同 |
| `AUTH_PIN_PEPPER` | 僅 POS 伺服器（登入用；**不要**拿來簽 scan-debit HMAC） |
| `POS_SCAN_DEBIT_SECRET` | 僅 POS 伺服器與 Ledger；UAT／正式各一 |

**不要**再要 `SUPABASE_SERVICE_ROLE_KEY`。

UAT 網域：`https://membership-uat.macau-tech.com`  
正式：`https://membership.macau-tech.com`

---

## HTTP（POS 伺服器 only）

HMAC（quote **與** commit 都要）：

```text
X-Pos-Timestamp: <unix 秒或毫秒，或 ISO>
X-Pos-Signature: HMAC-SHA256(POS_SCAN_DEBIT_SECRET, timestamp + "." + rawBody).hex
Authorization: Bearer <顧客 access_token>
```

時戳容差 5 分鐘。簽 **原始 body 字串**，不要先 parse 再 stringify。

### Quote

`POST {APP}/api/integration/pos/scan-debit/quote`

```json
{
  "merchantId": "<merchants.id>",
  "posOrderId": "your-pos-order-id",
  "amountAvos": 12800
}
```

`posOrderId`：8–128 字，`[A-Za-z0-9._:-]+`。冪等鍵由 Ledger 固定為 `scan-debit:{merchantId}:{posOrderId}`。

成功：`quoteId`、`expiresAt`（約 180s）、`quoteSig`、`idempotencyKey`。

關店／休息中 → `code: store_not_live`。餘額不足 → `insufficient_balance`（不發有效 quote）。

### Commit

`POST {APP}/api/integration/pos/scan-debit/commit`

```json
{
  "quoteId": "<from quote>",
  "quoteSig": "<from quote>"
}
```

成功：`txnId`、`balanceAfter`、`pointsEarned`（該筆 paid avos，v3.3 trigger）。同 `posOrderId` 重試應回**同一** `txnId`。改金額或過期或拿別人 quote → 拒絕。

**逾時／重試**：`quoteSig` TTL 約 180 秒。請在有效期內 commit；網路重試須重用同一 `quoteId`／`quoteSig`／`posOrderId`。若 quote 已過期但先前 commit 可能已成功，請以 POS 單號對帳（同一冪等鍵不會雙扣），**不要**改金額重 quote 同一 `posOrderId`。

operator 在 Ledger 內部為店主 `owner_id`（`apply_transaction` 不接受顧客當 operator）。POS **不必**傳 operator。

---

## POS 義務（Ledger 不實作）

1. 核價；`amountAvos` 必須是 POS 算完的應付。
2. 確認扣款再要 PIN；**登入後 3 分鐘內可免再 PIN**。
3. 關店時不要打 quote（打了也會被拒）。
4. 禁瀏覽器直打 Ledger、禁 polling。
5. Ledger 限流：每店／每顧客 15 分鐘最多 30 次 **quote**（commit 不另計）。

---

## 刻意不做（v1）

券核銷、積分折抵、`create_order`、桌上桌號進 Ledger、金額上限、掃碼頁退款。Kiosk 可續用店員 `merchant_apply_pos_txn`。

---

## 聯測帳號（UAT）

店主 `60000001`／PIN `1111`；會員 `60000003`／PIN `3333`。禁止用 `service_role` 假裝顧客。
