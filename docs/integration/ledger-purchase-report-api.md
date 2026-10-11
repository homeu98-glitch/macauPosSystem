# Ledger → expenseRecorder：買貨（庫存）報表 API 契約 v1

> **送交對象**：Macau Ledger（會員通）團隊
> **服務方**：expenseRecorder（買貨／庫存系統）
> **狀態**：v1 定稿，雙方已共識（2026-10-11）
> **本文件可直接轉貼給 Ledger 開發者**

---

## 1. 呢條 API 做咩

畀 Ledger 顯示商戶嘅**買貨數據**：

- **今日／本週／本月／本年**買咗幾多錢、買咗幾張單
- **逐張單據**（邊間供應商、幾多錢、用咗邊種付款方式、單入面逐件貨）
- **品項分析**（買過乜、幾多件、單價升跌）
- **供應商排行**、**付款方式分布**、**每日趨勢**

⚠️ **庫存現況**（現存幾多件、需唔需要補貨）**唔喺呢條 API 範圍**，
會另開一條（第二階段）。呢條只講「買」。

---

## 2. 請求

### 2.1 路徑

```
GET https://<expense-recorder 域名>/api/integration/ledger/purchase-report
    ?shopId=<shopId>&from=YYYY-MM-DD&to=YYYY-MM-DD
```

### 2.2 參數

| 參數 | 必填 | 說明 |
| --- | --- | --- |
| `shopId` | ✅ | **你哋 `merchants.id`**（雙方已確認統一用呢個值） |
| `from` | ✅ | 開始日期 `YYYY-MM-DD`（含當日） |
| `to` | ✅ | 結束日期 `YYYY-MM-DD`（含當日） |

**日期語意**（同你哋現有線下營業摘要 API 一致）：

| 用戶選擇 | from | to |
| --- | --- | --- |
| 今日 | 今日 | 今日 |
| 近 7 日 | 今日 − 6 | 今日 |
| 本月 | 本月 1 日 | 今日 |
| 本年 | 1 月 1 日 | 今日 |

🔴 **時間範圍冇上限** —— 可以查三年、查全歷史都可以。

### 2.3 請求標頭（HMAC 驗簽）

| 標頭 | 說明 |
| --- | --- |
| `X-Ledger-Timestamp` | Unix 秒（毫秒亦接受） |
| `X-Ledger-Signature` | 見下 |

**簽名算法**（同你哋現有線下營業摘要 API 一致）：

```
signature = HMAC-SHA256(secret, timestamp + "." + "GET" + "." + pathWithQuery)
```

- 輸出小寫 hex
- `pathWithQuery` = path + `?` + query，**原字串、參數順序原樣**
  （例：`/api/integration/ledger/purchase-report?shopId=X&from=2026-10-05&to=2026-10-11`）
- **簽名覆蓋 query** ⇒ 換 `shopId`／改日期必須重新簽名
- 時效：**5 分鐘**（超時會被拒）
- secret 只存在兩邊伺服器，**唔好**放喺前端或登入後可讀嘅地方

**Node.js 例子**

```js
const crypto = require("node:crypto");

function signPurchaseReport({ secret, shopId, from, to }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const pathWithQuery =
    `/api/integration/ledger/purchase-report?shopId=${encodeURIComponent(shopId)}` +
    `&from=${from}&to=${to}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.GET.${pathWithQuery}`)
    .digest("hex");
  return { timestamp, pathWithQuery, signature };
}
```

**curl 例子**

```bash
TS=$(date +%s)
PATH_Q='/api/integration/ledger/purchase-report?shopId=SHOP_000123&from=2026-10-05&to=2026-10-11'
SIG=$(printf '%s' "${TS}.GET.${PATH_Q}" \
      | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.*= //')

curl -i "https://<expense-recorder 域名>${PATH_Q}" \
  -H "X-Ledger-Timestamp: ${TS}" \
  -H "X-Ledger-Signature: ${SIG}"
```

---

## 3. 🔴 呼叫方式約定：On-demand pull，唔准 polling

呢條係**「一拉就即答」嘅查詢端點**，唔係推送、唔係訂閱。

| ✅ 應該 | ❌ 唔應該 |
| --- | --- |
| 使用者撳「查詢」或切換日期區間 → 撳一次 | 頁面開住就每 30 秒自動拉 |
| Ledger 伺服器喺收到使用者動作時觸發 | 背景 job 定時全店巡邏 |
| 同一組 `(shopId, from, to)` 喺 Ledger 端快取幾分鐘再重用 | 為咗「保持新鮮」重複拉同一組參數 |

每個請求都係一次真實資料庫查詢。定時輪詢會令資料庫負累隨門店數線性增長、回應變慢，
而且冇新資料時純粹白做功。

**限流（600 次/分 per shop）係防撞牆嘅保險上限，唔係建議你用幾多次。**
正常 on-demand 用法（一位店主一日撳幾十次）永遠唔會撞到。
撞到 429 代表**你嘅用法有 bug**（例如意外跌入一個每 3 秒拉一次嘅 loop），唔係「我哋限你用」。

---

## 4. 回應

### 4.1 成功（HTTP 200）

```jsonc
{
  "v": 1,
  "shopId": "SHOP_000123",
  "range": { "from": "2026-10-05", "to": "2026-10-11" },
  "generatedAt": "2026-10-11T09:20:31.000Z",

  "kpi": {
    "currencies": ["HKD", "MOP"],
    "byCurrency": [
      { "currency": "HKD", "receiptCount": 9, "totalAmount": 24850.00, "avgPerReceipt": 2761.11 },
      { "currency": "MOP", "receiptCount": 3, "totalAmount": 10000.00, "avgPerReceipt": 3333.33 }
    ],
    "receiptCount": 12,
    "totalAmount": null,
    "itemLineCount": 47,
    "supplierCount": 5,
    "avgPerReceiptDay": null
  },

  "daily": [
    { "date": "2026-10-05", "currency": "HKD", "receiptCount": 2, "totalAmount": 5120.00 },
    { "date": "2026-10-05", "currency": "MOP", "receiptCount": 1, "totalAmount":  880.50 },
    { "date": "2026-10-07", "currency": "HKD", "receiptCount": 1, "totalAmount": 1200.00 }
  ],

  "receipts": [
    {
      "receiptId": "b1f0…",
      "receiptNumber": "INV-2026-0042",
      "receiptDate": "2026-10-11",
      "recordedAt": "2026-10-11T08:03:11Z",
      "receiptType": "stock_in",
      "category": null,
      "supplierName": "澳門糧記",
      "supplierId": "c2a9…",
      "currency": "HKD",
      "totalAmount": 1280.00,
      "paymentMethod": "bank_transfer",
      "paymentStatus": "paid",
      "inputMethod": "photo",
      "items": [
        {
          "lineId": "d3f1…",
          "name": "泰國香米",
          "quantity": 25,
          "unit": "KG",
          "unitPrice": 32.00,
          "totalPrice": 800.00,
          "productKey": "thai-jasmine-rice",
          "isStockItem": true
        }
      ]
    }
  ],
  "receiptsTotal": 12,

  "items": [
    {
      "name": "泰國香米",
      "unit": "KG",
      "currency": "HKD",
      "totalQuantity": 25,
      "totalAmount": 800.00,
      "avgUnitPrice": 32.00,
      "lineCount": 1,
      "lastPurchaseDate": "2026-10-11",
      "changePercent": 4.2,
      "direction": "up"
    }
  ],
  "itemsTotal": 31,

  "suppliers": [
    { "name": "澳門糧記", "supplierId": "c2a9…", "currency": "HKD", "receiptCount": 4, "totalAmount": 9800.00 }
  ],

  "paymentBreakdown": [
    { "method": "bank_transfer", "label": "銀行轉賬", "currency": "HKD", "receiptCount": 7, "totalAmount": 20100.00 }
  ],

  "flags": {
    "stockInOnly": true,
    "multiCurrency": true,
    "receiptsTruncated": false,
    "itemsTruncated": false
  }
}
```

### 4.2 欄位說明

**`kpi`**

| 欄位 | 說明 |
| --- | --- |
| `currencies` | 區間內出現過嘅幣別清單 |
| `byCurrency` | **逐幣別**嘅單據數、總額、單均 |
| `receiptCount` | 單據總張數（跨幣，可以直接加） |
| `totalAmount` | ⚠️ **恆為 `null`** —— 見 §5.1 |
| `itemLineCount` | 品項行數（≠ 件數） |
| `avgPerReceiptDay` | ⚠️ **恆為 `null`** —— 跨幣無意義，逐幣計請用 `byCurrency` |

**`receipts[]`（逐張單據，新 → 舊）**

| 欄位 | 說明 |
| --- | --- |
| `receiptDate` | 單據日期 ⚠️ 冇時刻（只有日期） |
| `recordedAt` | 錄入時間 ⚠️ 唔一定等於單據時間（補登舊單可差幾日） |
| `receiptNumber` | 單號，可能 `null`（OCR 抽唔到） |
| `category` | 分類，通常 `null`（v1 只回入貨單） |
| `paymentMethod` | 已正規化嘅付款方式 key，見 §5.2 |
| `paymentStatus` | `paid` / `unpaid` |
| `inputMethod` | `photo` / `manual` / `ocr` |
| `items[]` | 單內逐件貨 |

**`items[]`（品項聚合）**

| 欄位 | 說明 |
| --- | --- |
| `totalQuantity` | 同品名＋單位＋幣別合併後嘅數量總和 |
| `avgUnitPrice` | `totalAmount / totalQuantity` |
| `changePercent` | 同上次買呢款相比嘅升跌百分比 |
| `direction` | `up`（貴咗）/ `down`（平咗）/ `same` / `new`（第一次買過） |

---

## 5. ⚠️ 三個必須知道的口徑

### 5.1 幣別會混用 —— 拆開睇，唔好加總

同一間店同一區間內**可能有 HKD 亦可能有 MOP**。

服務端**唔會做任何匯率換算**（冇可靠匯率、換算只會令總數失真）。

🔴 因此：

1. **`kpi.totalAmount` 恆 `null`、`kpi.avgPerReceiptDay` 恆 `null`** ——
   跨幣加總嘅數字冇意義，送一個出嚟只會誤導。
2. **所有聚合維度都帶 `currency`**：
   - `daily[]` = 一個 `(日期, 幣別)` 一條 ⇒ ⚠️ **同一日會有多條**
   - `items[]` 合併鍵係 `品名 + 單位 + 幣別`
   - `suppliers[]` = 一個 `(供應商, 幣別)` 一條
   - `paymentBreakdown[]` = 一個 `(付款方式, 幣別)` 一條
3. `receipts[]` 逐張單據本身已有 `currency`，**逐張顯示唔使理會分組**。

**顯示建議**：`kpi.currencies` 有幾個幣別就開幾張卡（例如「買貨總額 HKD」＋「買貨總額 MOP」），
卡與卡**唔加總**。`flags.multiCurrency` 恆 `true`，方便你直接判斷要開幾張。

⚠️ 畫趨勢圖時要先按 `date` 分組再畫，唔可以直接假設一日期一條。

### 5.2 付款方式係已正規化嘅 key

| key | 顯示 |
| --- | --- |
| `cash` | 現金 |
| `bank_transfer` | 銀行轉賬 |
| `fps` | 轉數快 |
| `cheque` | 支票 |
| `monthly` | 月結 |
| `pay_later` | 稍後付款 |
| `on_delivery` | 交貨付款 |
| `unknown` | 未知 |

`paymentBreakdown[].label` 一併提供，可以直接顯示，
但**唔好用 label 做邏輯判斷**（用 `method`）。

### 5.3 單據日期冇時刻，唔好用錄入時間

`receiptDate` 係單據上嘅日期（得日期）。
`recordedAt` 係**店員幾點輸入系統**嘅時間，補登舊單可以差幾日。

⇒ **日界分組、畫圖、一切「邊日」嘅判斷，一律用 `receiptDate`，唔好用 `recordedAt`。**

---

## 6. 範圍與截斷

### 6.1 時間範圍無上限

`from` / `to` 冇任何日數限制，可以查全歷史。

### 6.2 分層：聚合 vs 明細

| 層 | 內容 | 覆蓋範圍 | 會否截斷 |
| --- | --- | --- | --- |
| **聚合層** | `kpi` / `daily` / `suppliers` / `paymentBreakdown` / `items` | **完整 `from`→`to`，100% 準** | **永不** |
| **明細層** | `receipts[]`（含逐件貨） | 最近 500 張 | 可能 |

⇒ 「今年買咗幾多錢、邊間供應商最貴、邊款料最貴」**查幾耐都準確**，
唔會因為明細截斷而受影響。

### 6.3 上限

| 項目 | 上限 | 行為 |
| --- | --- | --- |
| `receipts[]` | 500 張 | 超出就唔回，`flags.receiptsTruncated = true` |
| `items[]` | 1000 款 | 超出就唔回，`flags.itemsTruncated = true` |

⚠️ **`receiptsTotal` / `itemsTotal` 永遠係真實總數**，唔受截斷影響。

### 6.4 見到 `truncated: true` 點處理

1. **唔可以**將 `receiptsTotal`（真實總數）當成 `receipts.length`（實際列出嘅張數）顯示
2. UI 顯示「只顯示最近 500 張，共 X 張」，並提議收窄日期範圍
3. 分析功能（KPI／圖表／排行）**照用聚合層**，唔受影響

（本版未提供分頁。若將來需要，會加 cursor 分頁，**唔會**用 offset。）

---

## 7. 失敗回應

```jsonc
{ "error": "unauthorized" }         // 401：簽名錯／過期
{ "error": "bad_shop_id" }          // 400：shopId 格式錯
{ "error": "bad_range" }            // 400：日期格式錯，或 from > to
{ "error": "shop_not_found" }       // 404：店舖未綁定（見 §8）
{ "error": "too_many_requests" }    // 429：你嘅用法有 bug（見 §3）
{ "error": "server_misconfigured" } // 500：我哋 secret 未配置（fail-closed）
{ "error": "upstream_unavailable" } // 503：服務未部署／資料庫故障
```

**共同原則：唔會回「假零」。** 查詢失敗就回 5xx，
唔會送一張 0 元／0 件嘅卡（假數比冇數危險）。

---

## 8. ⚠️ 「查得到但零張單」嘅準確語意

呢個最易搞錯，直接影響你哋 UI 點表達：

| 情況 | HTTP | 回應 | 你哋應該顯示 |
| --- | --- | --- | --- |
| 查得到，區間內**真係冇單** | **200** | `receipts: []`、零值 KPI、`receiptsTotal: 0` | 「該期間沒有買貨紀錄」—— **正常狀態** |
| 店舖從未用 Ledger 登入過 | 404 | `shop_not_found` | 「店舖未連接」 |
| 服務未部署／資料庫故障 | 503 | `upstream_unavailable` | 「暫時無法取得」 |
| 簽名錯／過期 | 401 | `unauthorized` | 「暫時無法取得」 |

🔴 **`receipts: []` 係有效答案，唔係錯誤。**
只可以當 200 正常處理，**唔可以**因為陣列係空就彈錯誤或紅字。

**對照：key 唔存在（＝未部署）vs 空陣列（＝真實嘅零），兩者唔可以混淆。**

---

## 9. 回應標頭

| 標頭 | 說明 |
| --- | --- |
| `cache-control` | `no-store` |
| `x-expense-purchase-report-v` | `1` |
| `x-expense-purchase-report-path` | `/api/integration/ledger/purchase-report` |
| `x-expense-purchase-report-caps` | 能力清單（見 §10） |

---

## 10. 能力探測（caps 標頭）

`v` 恆為 `1`。**日後加欄位唔會升 `v`** —— 咁樣會令你哋既有嘅版本檢查失效，
整包被丟棄。所以加咗咩功能一律用 `caps` 標頭宣告。

⚠️ **降級閥**：`kpi`+`daily`、**或** `receipts`+`receiptsTotal`、**或** `items`+`itemsTotal`、
**或** `suppliers`+`paymentBreakdown` —— **每組要麼全有、要麼全無**。

- 整組冇出現 ＝ 該功能未部署 ⇒ 你哋唔好讀，顯示舊版 UI
- ⚠️ **只出現一半 ＝ 我哋側有 bug**，會直接回 503（唔會俾半份資料）

---

## 11. 本版範圍

### v1 只回「入貨單」

資料庫入面單據分三類：`stock_in`（入貨）、`expense`（租金水電薪資等營運支出）、`other`。

**v1 只回 `stock_in`**（`flags.stockInOnly` 恆 `true`）⇒ Ledger 睇到嘅就係「買咗乜」，
唔會混入營運支出。

v1 **唔接受** `type` 查詢參數（傳咗會被忽略）。
**v2** 會加機讀 `type` 參數（`type=stock_in|expense`），並且**保持 v1 預設值不變**
（保證你哋已對數嘅卡零影響）。

### 庫存現況唔喺呢度

「現存幾多件、需唔需要補貨」屬於庫存主檔，會另開一條 API（第二階段）。

---

## 12. 安全事項

1. **secret 只喺 Ledger 伺服器**。唔好放喺前端、唔好寫入會下發到瀏覽器嘅設定。
2. **唔可以重用**其他 integration 嘅 secret（線下營業摘要、webhook、SSO 各有各把）。
   共用一把 = 一邊爆就兩邊爆。
3. 本 API **淨係讀**，冇任何寫入。
4. 回應**唔會**包含相片、職員姓名、記事等私人內容（單據 OCR 原文一律唔會外傳）。
5. 每次請求都會驗簽 + 限流；失敗嘗試會記錄喺服務端日誌。

---

## 13. 上線步驟

| # | 步驟 | 負責 |
| --- | --- | --- |
| 1 | 雙方各產生一把專用 HMAC secret（**唔好重用其他 secret**） | 雙方 |
| 2 | 我哋喺服務端配置環境變數並部署 | 我哋 |
| 3 | 雙方用 staging secret 跑一次 §2.3 嘅 curl 測試（核對 payload） | 雙方 |
| 4 | 交換正式 secret | 雙方 |
| 5 | Ledger 開通入口 | Ledger |

**降級行為**：我哋 secret 未配置 ⇒ 500（fail-closed，唔會誤放行）；資料庫未就緒 ⇒ 503。
兩種情況你哋都應該顯示「暫時無法取得」，**唔好顯示空白卡或 0**。

---

## 14. 常見問題

**Q：查全歷史會唔會爆？**
唔會。時間範圍冇上限，但回應分兩層：分析用嘅聚合層永遠完整，
只有「逐張單據明細」上限 500 張（`flags.receiptsTruncated` 會話你知）。

**Q：點解 `totalAmount` 係 `null`，唔係加埋？**
因為同一區間可能有 HKD 同 MOP，加埋個數字冇意義。
用 `kpi.byCurrency` 分幣別睇。

**Q：點解同一日喺 `daily[]` 會出現兩條？**
因為 HKD 同 MOP 分開計。畫圖時按 `date` 分組。

**Q：單據日期冇時刻點算「今日」？**
「今日」係按單據上嘅日期判定，唔係錄入時間。補登嘅舊單會喺佢原本嘅日期出現，
唔會跳到補登嗰日 —— 呢個先係財務上正確嘅。

**Q：付款方式啲值穩定嗎？**
穩定，只會係上表 8 個 key 其中之一。新增會透過 `caps` 標頭宣告。

**Q：點解唔會回相片？**
單據辨識嘅原文（含相片路徑、店員手寫備註）屬店內資料，唔會經呢條 API 外傳。

---

## 15. 聯絡

技術問題或 payload 唔符合預期，請直接聯絡，我哋會查資料庫實際值同你哋對數。
