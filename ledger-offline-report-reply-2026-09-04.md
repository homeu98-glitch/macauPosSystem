# POS 線下報表對接 — 回覆（macauPosSystem 團隊）

> **對象**：澳門會員通（Macau-Ledger）
> **日期**：2026-09-04
> **回覆**：`pos-offline-report-proposal(1).md` 之 §6 九條清單 + Q1–Q4
> **狀態**：POS 團隊初步立場，**尚未**寫進契約。Q2 / Q3 有兩點待 POS 內部拍板（已標註）。

---

## 0. 總體立場

**接受 §0 方向**：否決 83／94「Ledger 直連 POS DB」，改為「POS 喺 `/api/pos/sync` 成功後自動把僅線下日快照 HMAC upsert 進會員通」。

接受理由（同你哋 §1.3 一致）：

1. 83／94 本身係 POS 內部文件，`ledger_report_ro` 角色同 `report_ro` schema **由頭到尾都未喺 production 建立／交付**，所以「否決」成本係零，冇嘢要拆。
2. 「資料方向 POS → Ledger」符合現行契約（`get_merchant_report_summary`、`merchant_apply_pos_txn`、`ensure-customer` 全部係 POS → Ledger）。
3. 安全邊界放啱位：唔外發 POS DB 密碼、唔外發 `service_role`。

**一個澄清**：83／94 唔係我哋「要收返」嘅嘢，而係我哋內部做「POS 自己 `/reports` 上雲」嘅研究稿。你哋點出嘅 A–J 弊端，尤其 B（全店可讀）、D（Vercel serverless 連線上限）、H（MOP vs avos 單位），**全部成立**，我哋唔再為 83／94 辯護。

---

## 1. §6 九條逐條回覆

| # | 條款 | 回覆 |
|---|---|---|
| 1 | 否決 83／94 對 Ledger 交付；83／94 僅供 POS 自己報表 | **同意**。唔會交付 `ledger_report_ro` 連線字串／密碼。 |
| 2 | POS 喺 sync 成功後自動 upsert「僅線下」日快照；店員唔按匯入 | **同意**。附實作說明（見 §3）。 |
| 3 | POS 可做夜間 cron；會員通不連 POS DB、不開反向 cron | **同意方向**，但「POS 夜間 cron」要補基礎設施（見 §4 開放問題）。會員通不連 POS DB 冇異議。 |
| 4 | 「看當下」＝POS 有網時覆蓋今日；會員通只讀＋「資料截至」 | **同意**。POS 機離線時不保證即時，會員通顯示上次成功時間。 |
| 5 | 斷線補傳：恢復上網後一次送缺日（每批 ≤14、總上限 90、同日覆蓋） | **同意**。 |
| 6 | 線上單不進快照；兩邊並排、不加總 | **同意**。線上單只信 Ledger `get_merchant_report_summary`。 |
| 7 | 開通時綁每店 HMAC（POS 伺服器持有）；不給 POS DB 密碼或 `service_role` | **同意**。注意方向：見 Q3。 |
| 8 | 書面確認 `store_id` ↔ Ledger `merchant_id`（附 UAT 實值） | **同意，且已可證實**：`store_id` = Ledger `merchants.id`（UUID）。詳見 Q1。 |
| 9 | 第一版範圍：KPI 即可；菜品榜／時段／庫存要唔要註明 | **建議只要 KPI**。詳見 Q2。 |

---

## 2. Q1–Q4

### Q1：正式／UAT 嘅 `store_id` 實際值？是否已等於 Ledger UUID？

**係。`store_id` 就係 Ledger `merchants.id`（UUID），呢個係代碼層面已實現嘅事實，唔係新對照。**

證據（`src/app/api/ledger/login/route.ts`）：

```ts
// 店員登入 POS 時，由 merchant_staff.merchant_id 攞到店舖識別
session: {
  merchantId: staffRow.merchant_id,   // ← 呢個就係 store_id 嘅真源
  storeIds: [staffRow.merchant_id],
  ...
}
```

`/api/pos/sync` 收到嘅 `storeId` 就係呢個 `merchantId`，直接寫落 `pos_orders.store_id` 等表。

⚠️ **83 文檔 §4.2 寫「`store_id` = Ledger merchantId」方向正確，但全篇示例 `macau-store-a` 係錯嘅 mock 值**。`macau-store-a` 係 `docs/sql/admin-account-schema.sql` 嘅示範店代碼，我哋已經喺 `src/lib/pos/store-id-guard.ts` 將佢列入黑名單、寫入入口一律擋（防止「配對成功但印唔出」嘅 silent failure）。

**要你做**：請提供 1–2 個正式／UAT 商戶嘅真實 `merchants.id`（UUID），等我哋跑一遍對照（`pos_orders.store_id` 同你哋 `merchants.id` 相等），並以此為 UAT 基準。

### Q2：第一版要唔要菜品排行、尖峰時段、低庫存？定淨係當日 KPI？

**POS 建議：第一版只要「當日 KPI」**，即：

- 營業額（avos）、訂單數、客單價、折扣金額、退菜份數／退菜率
- （可選）覆蓋人數／人流、堂食／快餐拆分 —— 見下方「正面更新」

**建議押後**（第二版再傾）：菜品排行、尖峰時段、低庫存。

理由：

1. 日快照場景下，菜品榜／尖峰時段係「睇當下」先有價值；落成「日 × 店」快照後，呢類資訊嘅邊際價值好低，仲要每次多幾百行 payload。
2. 低庫存係「即時快照」，同「日快照」語義唔同（日終庫存冇意義，要睇就係睇當下）。若會員通要低庫存，另開一條「即時低庫存推送」更合理，唔應該混入日快照。
3. 縮小第一版 = 更快上線、更少口徑爭議。

> ⚠️ **此為 POS 建議，未經 POS 內部最終拍板**。若你哋會員通嘅商戶報表 UI 原本就預留咗菜品榜／時段位，可以回一句，我哋再評估係咪第一版就帶。

### Q3：HMAC 誰簽發、怎麼輪替？能否與現有 webhook secret 分開？

**分開，一定要分開。** 原因：

現有 `LEDGER_WEBHOOK_SECRET`（`src/lib/ledger/webhook-signature.ts`）係 **Ledger → POS 入站** webhook 用（docs/92 自動接單）。簽名規格：

```
signing_string = X-Pos-Timestamp + "." + raw_body
signature      = HMAC_SHA256(LEDGER_WEBHOOK_SECRET, signing_string)
```

新方案要嘅係 **POS → Ledger 出站**，方向相反。若共用同一個 secret，任何一邊被 compromise 就同時打穿兩邊。所以：

- **POS 出站**用一套新憑證（建議由 **Ledger 簽發**，每店一把，key 綁 `merchant_id`）。
- 只放 POS 伺服器（Vercel env），唔落收銀瀏覽器／APK。
- 簽名規格建議對稱沿用上面嗰套（`timestamp.body` + HMAC-SHA256 + 5 分鐘時間窗），我哋可以照你哋契約 v3.x 最終版實作。
- 輪替：同 webhook secret 一樣，靠環境變數換 key + 短暫雙 key 過渡（舊 key 讀 5 分鐘、新 key 寫）。具體輪替頻率由你哋定，我哋跟。

**要你做**：契約 v3.x 裡定義「POS 出站快照上傳」嘅 HMAC key 簽發／綁定／輪替／撤銷流程。

### Q4：退款單 POS 前端仍算滿額——快照沿用該口徑，還是標「未扣退款」？

**沿用現狀口徑：退款單照加滿額 `total`，不扣退款。** 並建議喺快照／UI 標「未扣退款」。

原因（代碼事實）：

- 前端 `aggregate()` 對 `status in ('settled','partially_refunded','refunded')` 嘅單**一律加 `total` 入營業額**，冇扣減退款。
- `pos_orders` 表**冇** `refunded_amount` 欄（83 §6.7 已列明），想扣都冇數可扣。

所以快照只能沿用「滿額」口徑。若你哋會員通希望「營業額」係「扣咗退款」嘅淨值，就要先傾兩件事：

1. POS 加 `refunded_amount`／退款明細欄（`refundRecords` 上雲）。
2. 定義「部分退款」單點樣計（扣退菜？扣退款？）。

> **POS 建議第一版唔好為咗呢個阻塞上線**：先沿用滿額 + 標「未扣退款」，退款淨值當第二版加欄再算。

---

## 3. 對「方案」嘅實作說明（條款 2 嘅細節）

POS 側技術上點樣落地，先講清楚，避免雙方預期落差：

**「看當下」觸發點**：`/api/pos/sync` 係收銀機逐單事件流（`ORDER_SETTLED` 等）。POS 會喺 sync 成功、且偵測到「今日有結帳」之後，**節流 ≥ 5 分鐘**組一次「今日線下日快照」，有 diff 先推 Ledger。唔會每單都推。

**「夜間對帳」觸發點**：POS 目前**冇 cron 基礎設施**（部署喺 Vercel，冇開 scheduled function；Supabase 亦未開 `pg_cron`）。要補三選一：

1. **Vercel Cron**（推薦，POS 已有 Vercel 部署）。
2. Supabase Edge Function scheduled。
3. 獨立小 worker。

呢個係 POS 內部要新增嘅嘢，唔影響你哋（你哋唔開反向 cron 冇異議）。

**watermark 比對**：需要你哋提供「GET 店 × 日嘅最後成功快照」（或直接「GET 缺日清單」）端點，POS 先有得做「有 diff 先推／只補缺日」。呢個係你哋側要新增嘅契約端點。

---

## 4. 兩項「正面更新」（令第一版 KPI 更完整）

你哋 83 文檔（我哋內部稿）§6.1／§6.3 寫「覆蓋人數 partySize 未上雲」「人流係手動輸入」——**呢兩點已經過時**：

1. **`party_size` 已上雲**：`/api/pos/sync` 已寫 `party_size`（docs/89 §3），新單有值。
2. **人流已改為訂單自動計算**：POS 報表「當日人流」已由手動輸入改成依訂單自動算（堂食 = `party_size` 加總、快餐/外賣 = 一單算一人）。

所以如果第一版 KPI 想帶「覆蓋人數／人流」，**技術上已經具備**，唔使再等 migration。呢個係「參考數字」性質，同你哋 §3.1 嘅定位一致。

---

## 5. 待你哋確認嘅清單（我哋先俾晒立場，等你回）

1. **Q1**：提供 1–2 個真實 `merchants.id`（UUID）做 UAT 對照。
2. **Q2**：確認第一版範圍（我哋建議只要 KPI，你哋 UI 若預留咗菜品榜／時段請回一句）。
3. **Q3**：契約 v3.x 定義 POS 出站快照嘅 HMAC key 簽發／綁定／輪替／撤銷。
4. **watermark 端點**：定義「GET 店 × 日最後成功快照／缺日清單」嘅契約。
5. **快照表**：你哋側開「線下日快照表」，鍵 `(merchant_id, biz_date)`，同日覆蓋。

雙方確認後，先落契約 v3.x（additive），再動工。呢份回覆唔係已上線規格。
