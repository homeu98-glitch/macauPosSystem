# 126 · 掃碼自助扣餘額（v3.5）— 對 Ledger 的確認單

> **文件版本**：v1.1（2026-09-13 補：Ledger 已回覆）
> **日期**：2026-09-12
> **提出方**：macauPosSystem（POS）
> **對象**：Ledger 團隊
> **回覆 Ledger 文檔**：[`pos-v3.5-partner-handover-scan-debit.md`](integration/pos-v3.5-partner-handover-scan-debit.md)
> （已存檔入 repo）＋ 權威契約 **§5.12**、決策 **ADR-039**
> **回覆方式**：直接喺 §3／§4 表格「Ledger 回覆」欄填；或照 §6 模板回。
> **一句話**：**v3.5 嘅方向我方接受、可以開工**；但有 **7 條會直接影響「會唔會扣錯錢」嘅問題**
> 需要先拍板（§3）。§4 嘅 8 條可以一齊回，唔阻塞。
> **前提**：本單只針對「錢」嘅語義；UI／POS 內部架構我哋自理（§2）。
>
> ---
> ## ✅ 2026-09-13：Ledger 已回覆（Q1–Q15 全部有答案）
>
> **我方解讀全文 → [`docs/129-scan-debit-v35-ledger-reply-analysis.md`](129-scan-debit-v35-ledger-reply-analysis.md)**
>
> **一句話結論**：方向接受、**可以開工**，但**唔係「照做」**——有 4 個攔截點要先處理：
>
> | # | 攔截點 | 來源 | 後果 |
> |---|--------|------|------|
> | **P1** | **冪等鍵對齊**：`merchant_apply_pos_txn` 要主動傳 `scan-debit:{merchantId}:{posOrderId}`，`apply_transaction` 才會擋 | Q2 | 🔴 照現狀實作 = **真·雙扣** |
> | **P2** | **伺服器端核價**（`/api/pos/sync` 現時直接信 client `total`） | Q3「單筆／單日上限：無」 | 🔴 Ledger 完全唔核價 → POS 係唯一防線 |
> | **P3** | **免 PIN 窗口**要 POS 自己實作（Ledger 端**唔會**再驗 PIN） | Q5 | 🔴 判錯 = 等於冇二次確認 |
> | **P4** | `/api/pos/sync` 白名單未收 `member_*` 欄 | Q14 + §7.2 | ⚠️ 漏一邊 = 靜靜唔同步 |
>
> **另外兩件要處理**：
> 1. ⚠️ **Q2 自相矛盾**（「POS 自己負責」vs「傳同一 key 就會擋」）→ 要追 Ledger 確認前綴語義。
> 2. ⚠️ **本地契約 §5.12 未入庫**（本地仍係 v3.4、零命中 `scan-debit`）→ Q8 錯誤碼清單**實際未答**，要追更新後嘅 `ledger-client-api.md`。
> 3. 🔴 **新發現硬衝突（Q15）**：沖正**只可以**走會員通 Web（人手），POS 禁 `p_type=add`
>    → 掃碼預付單**必須鎖單**（commit 後唔准返結／改金額／退單）。
>    呢個同我方既有「返結 = 反向回滾 `memberDeductionAvos`」直接衝突。
>
> **作廢嘅舊結論**：`docs/120` §3.3／§9「掃碼扣費不可行」、`docs/121` §3「S3 降級」、
> `docs/122`「唯一出路 = Ledger 開 S2 RPC」（Ledger 改用**兩支 HTTP endpoint** 實現，非 RPC）。

---

## 1. 我方對 v3.5 的理解（請確認冇理解錯）

**一句話**：掃碼堂食預付 —— **POS 自己的單係權威**；Ledger **只扣該顧客在該店的餘額**（記帳，非託管）。
流程：顧客 JWT 登入 → POS 核價寫待付 → **POS 伺服器** `quote` →（PIN 再確認，登入未滿 3 分鐘可免，**只在 POS 做**）→ `commit` → 單已付、出廚。

| 角色 | 負責 |
|------|------|
| **POS 伺服器** | 核價（算應付）、PIN 再確認、**HMAC 簽名**、帶顧客 `access_token` 打 Ledger、把 `txnId` 落 POS DB 對帳 |
| **Ledger** | 驗簽 + 驗顧客 token → 檢查店狀態／餘額 → 發 quote → 扣款（記帳）→ 回 `txnId`／`balanceAfter`／`pointsEarned` |
| **顧客瀏覽器** | 只同 POS 伺服器講嘢（**唔准**直打 Ledger、冇 secret） |

**我方理解嘅關鍵點**（如果有一項理解錯，請直接指出）：

1. `{APP}` = **Ledger 網域**（UAT `membership-uat.macau-tech.com` ／ 正式 `membership.macau-tech.com`）
   → 即 POS 伺服器係 caller，URL 係 `{LEDGER}/api/integration/pos/scan-debit/quote|commit`。
2. **Ledger 唔核價**：`amountAvos` 由 POS 算完傳過去，Ledger 只驗「店有冇開 / 餘額夠唔夠」。
3. 冪等鍵由 Ledger 固定為 `scan-debit:{merchantId}:{posOrderId}`。
4. **Kiosk 保留**走店員 `merchant_apply_pos_txn`（唔行呢條新路）。
5. `POST_SCAN_DEBIT_SECRET` 只喺 POS 伺服器 + Ledger；**唔可以用 `AUTH_PIN_PEPPER` 簽**；**唔要** `service_role`。

---

## 2. 我方自理（唔需要 Ledger 提供，僅供參考）

- POS 內部 UI、跨機 Realtime 廣播、離線降級。
- **伺服器端核價**（唔信 client 傳上嚟嘅金額）—— 我方會做。
- 一張單「只可以有一條付款路成功」嘅閘（防雙扣）—— 我方會做，但見 **Q2**（Ledger 端守衛與否）。

---

## 3. 🔴 7 條阻塞問題（請逐條回覆）

| # | 問題 | 為何要問（影響） | 我方建議 | Ledger 回覆 |
|---|------|------------------|----------|-------------|
| **Q1** | `{APP}` 實際係邊個 base URL？ | 搞反方向 = 白做一輪（我哋要靠 env 寫死） | 確認 = Ledger 網域（見 §1.1） | |
| **Q2** | **防雙扣**：同一張 POS 單，scan-debit `commit` 成功之後，如果收銀台／Kiosk 再走**店員** `merchant_apply_pos_txn`（同一 `posOrderId`／同一訂單），Ledger 有冇守衛？ | 兩條路嘅冪等鍵**唔同**（`scan-debit:{m}:{order}` vs 店員自帶 `p_idempotency_key`）→ **Ledger 唔會擋 = 雙扣真錢** | Ledger 加「同一 merchant + 同一 posOrderId 只可成功扣一次」＋ 回明確錯誤碼（例如 `already_debited`） | |
| **Q3** | **核價責任邊界**：(a) Ledger 完全唔會驗金額合理性？(b) 有冇**單筆／單日上限**或風控？ | Ledger 係最後一道閘。若 POS 端被繞過（客人改 client 金額），損失邊個承擔？ | 建議 Ledger 加**單筆上限**作最後防線（即使文檔寫「v1 不做金額上限」） | |
| **Q4** | **改單／改金額**：文檔寫「不要改金額重 quote 同一 `posOrderId`」。堂食掃碼客**好常加菜**，正確做法係？ | 冇明確做法 → 客人加菜會卡死或者扣錯 | (a) 改單 = 用**新** `posOrderId`（新 quote）(b) 請確認**未 commit 嘅 quote** 會唔會佔用咗冪等鍵、幾時自動失效 | |
| **Q5** | **免 PIN 窗口（安全）**：3 分鐘係**強制**定**建議**？由邊一刻起計（登入成功／上次 PIN 確認）？範圍係「每個訂單一次」定「時間內全部免」？ | 「只在 POS 做」= Ledger 端完全唔會再驗。POS 判錯（flag 唔 expire）= 等於**冇二次確認**，手機被盜就可以扣錢 | (a) 每次付款都要 PIN，**除咗**登入後 180 秒內；(b) 窗口**唔可以**用 refresh token 延長；(c) 每次付款獨立計 | |
| **Q6** | **對帳接口**：文檔叫「以 POS 單號對帳」，但契約冇一支「用 `posOrderId` 查交易」。可否提供 `.../scan-debit/lookup`（入 `merchantId` + `posOrderId` → 回 `txnId`／`balanceAfter`／狀態）？ | quote 過期但 commit 可能已成功 —— 冇查詢接口，POS 只可以靠重試猜 | 提供 lookup。若唔提供，請確認 **commit 重試冇 TTL**（過期 quote 都能重試回同一 `txnId`） | |
| **Q7** | **餘額不足之後**：`insufficient_balance` 唔發 quote。客人當下應可**即場轉「到店付款」**繼續落單，定係一定要取消？ | 影響掃碼頁 UX 同訂單狀態機 | POS 做法 = 訂單不扣款、維持「待收銀付款」（即 v3.4 現狀），客人唔使重新落單 | |

---

## 4. 次要（可一齊回，唔阻塞）

| # | 問題 | Ledger 回覆 |
|---|------|-------------|
| **Q8** | **錯誤碼完整清單**：請 quote／commit **分開**列出全部 code ＋ HTTP status ＋ 建議 retryable（文檔只列 `store_not_live`／`insufficient_balance`）。 | |
| **Q9** | `POS_SCAN_DEBIT_SECRET` 交付方式（UAT／正式兩支，走邊條安全通道？）。另：`X-Pos-Timestamp` 我方建議**只用 unix 秒**（同我方現有驗簽邏輯一致，見 POS `webhook-signature.ts`），Ledger 接受嗎？ | |
| **Q10** | 冪等鍵 `scan-debit:{merchantId}:{posOrderId}` **保留幾長**？（客人取消單之後，同一個 `posOrderId` 可否重用？） | |
| **Q11** | `pointsEarned` 確認：掃碼扣**餘額**一樣會賺分（同 v3.3 一致）？POS 只負責顯示、唔會自己加減？ | |
| **Q12** | 請提供 **v3.5 契約正本（含 §5.12）** —— 我方手上係 v3.4，要覆蓋本地副本（同 v3.4 一樣流程）。 | |
| **Q13** | 扣款成功後，掃碼單可否**直接**「已付 → 出廚」（唔需要店員喺收銀台再確認一次）？ | |
| **Q14** | `posOrderId` 純作對帳用？確認店內**桌號／單號唔會**傳去 Ledger、亦唔會出現喺會員通單據。 | |
| **Q15** | 退款：掃碼頁退款 v1 不做 → 正式路徑係「店員／Admin 走 Ledger Web 沖正」？POS 要寫指引文案，請確認措辭。 | |

---

## 5. 我方現況（僅供參考，唔係要求）

v3.5 嘅前置（v3.4 顧客側）**我方仍未實作**，所以呢張單要早問：

| 前置 | 現況 |
|------|------|
| 顧客登入 route（v3.4 §4.5） | ❌ 未做（現有 `/api/ledger/login` 係店員專用） |
| 顧客自讀（餘額／積分／卡包，§5.11） | ❌ 未做（`get_my_*` 零引用） |
| `pos_orders` 會員欄（只許 `customer_id`） | ❌ 未做（migration 待開） |
| **伺服器端核價** | ❌ 未做（`/api/pos/sync` 現時直接信 client `total`） |
| quote／commit | ❌ 未做（v3.5 新） |

識別到嘅**高危位**（我方會自行處理，Ledger 只需知）：雙扣（Q2）、金額可被改（Q3）、免 PIN 窗口（Q5）、
`posOrderId` 唔可以用中文單號（POS 單號係「堂食01」等，要用內部 `order.id`，格式 `kiosk-xxxxxxxx`）、
quote 限流（每店／每顧客 15 分鐘 30 次 → POS 只會喺按「確認付款」時打一次）。

---

## 6. 回覆模板（請 Ledger 填）

```
【Q1 {APP}】        □ Ledger 網域（UAT/正式如下）  □ 其他：
   UAT：                正式：

【Q2 防雙扣】        □ Ledger 會擋（錯誤碼：      ）  □ POS 自己負責
   守衛範圍：□ 同一 posOrderId 終身  □ 只計 scan-debit 內部  □ 跨路徑（含店員 apply_pos_txn）

【Q3 核價／上限】    金額由 POS 話事：□ 確認   單筆上限：           單日上限：
   風控規則：

【Q4 改單】          正確做法：□ 新 posOrderId  □ 其他：
   未 commit 嘅 quote：□ 唔佔冪等鍵  □ 會佔（釋放時間：      ）
   quote 自動失效：□ 180s  □ 其他：

【Q5 免 PIN】        3 分鐘：□ 強制  □ 建議   起計點：□ 登入成功  □ 上次 PIN 確認
   範圍：□ 每訂單一次  □ 時間內全部免   Ledger 端會否再驗 PIN：□ 不會  □ 會

【Q6 對帳】          lookup 接口：□ 提供（路徑／簽章：      ）  □ 不提供
   若不提供，commit 重試冇 TTL：□ 確認  □ 否

【Q7 餘額不足】      退路：□ 即場轉到店付款（同一張單）  □ 一定要取消重落

【Q8 錯誤碼清單】    □ 附件提供（quote）      □ 附件提供（commit）

【Q9 金鑰／時戳】    secret 交付方式：            X-Pos-Timestamp 用 unix 秒：□ 接受  □ 不接受

【Q10 冪等鍵保留】    保留期：              取消後可否重用同一 posOrderId：□ 可  □ 不可

【Q11 賺分】         掃碼扣餘額一樣賺分：□ 確認   POS 只顯示：□ 確認

【Q12 v3.5 正本】    □ 已提供（連結／附件：            ）

【Q13 單狀態】       扣款成功即可出廚（唔需店員再確認）：□ 可以  □ 不可以（原因：      ）

【Q14 桌號入 Ledger】 posOrderId 純對帳、桌號唔會入 Ledger：□ 確認  □ 否

【Q15 退款指引】     正式路徑（供 POS 寫文案）：
```

---

## 附：與現行契約（v3.4）嘅差異（請一併確認）

| v3.4 現行 | v3.5 之後 |
|-----------|-----------|
| §1.1：「掃碼（客人手機）**無店員 session → 不可自助扣費／核銷**」 | **放寬**：可經 POS 伺服器簽名代打（顧客 token 授權） |
| docs/121 §3 結論 = **S3**（顧客揀、店員代扣） | 改為 **S3.5**：掃碼自助、店員 session 只留 Kiosk |
| §5.7 `merchant_apply_pos_txn` 限 `is_merchant_staff` | **不變**（Kiosk 續用）；掃碼走新 HTTP 路 |
| §5.5.3「禁止呼叫非白名單」 | 新增兩支 HTTP endpoint（§5.12）＋ 一支 `POS_SCAN_DEBIT_SECRET` |
