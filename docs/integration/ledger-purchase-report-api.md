# Ledger → expenseRecorder：買貨（庫存）報表 API 契約 v2（修訂草案）

> **送交對象**：Macau Ledger（會員通）團隊
> **服務方**：expenseRecorder（買貨／庫存系統）
> **狀態**：v2 修訂草案（待雙方共識）；**取代** 2026-10-11 嘅 v1 定稿
> **本文件可直接轉貼給 Ledger 開發者**
> **參考實作**：`docs/integration/ledger-purchase-report-reference-impl.md`（SQL＋route＋lib，交 expenseRecorder 團隊落）

---

## 0. v2 改咗乜（相對 v1）

v1 定稿嗰陣**完全冇替 Supabase 做節流保護，全部靠 Ledger 自律**。v2 補返呢層，主要為咗「門店一多 DB 就撐唔住」同「全歷史查詢最重反而冇保護」兩個風險：

| # | 保護 | v1 | v2 |
| --- | --- | --- | --- |
| ① | 服務端快取 | 無（`no-store`） | `Cache-Control: private, max-age=60`（按 shopId＋from＋to） |
| ② | 版本號 / 304 | 無 | 每店 `dataVersion`＋`ETag`；`If-None-Match` 吻合回 304 唔重查 |
| ③ | 預先聚合 | 每次全区间重算 | `purchase_report_daily` 每日匯總表；KPI／趨勢直接讀 |
| ④ | 限流 | 600/min per shop，無上限 | **30/min per shop ＋ 全域 300/min ＋ 並發 10** |
| ⑤ | 回應拆分 / 分頁 | 一次過包晒（500 單） | **summary endpoint ＋ receipts endpoint（cursor 分頁每頁 50）** |
| ⑥ | 聚合位置 | 冇講 | **明寫：聚合全部行 SQL RPC，唔可以用 supabase-js 拉 1000 行再加總** |

🚩 **首 4 點（① ② ③ ④）係上線前提** —— 缺佢哋，全歷史查詢會隨門店數線性打爆 DB。⑤ ⑥ 係同一個保護嘅延伸（減 payload、杜絕靜默截斷）。

---

## 1. 呢條 API 做咩

畀 Ledger 顯示商戶嘅**買貨數據**：

- **今日／本週／本月／本年**買咗幾多錢、買咗幾張單
- **品項分析**（買過乜、幾多件、單價升跌）
- **供應商排行**、**付款方式分布**、**每日趨勢**
- **逐張單據明細**（鑽取用，cursor 分頁）

⚠️ **庫存現況**（現存幾多件、需唔需要補貨）**唔喺呢條 API 範圍**，會另開一條（第二階段）。

v2 將回應**拆成兩個 endpoint**：

- **`/purchase-report`**（summary）：聚合層 —— KPI／趨勢／品項／供應商／付款，一次過拎齊，快（讀匯總表）。
- **`/purchase-report/receipts`**（明細）：逐張單據，cursor 分頁每頁 50，鑽取先呼叫。

> 點解拆分：v1 一次過包晒（KPI＋500 單＋1000 品項），「睇一張卡」都要拉成噸嘢。v2 張卡（summary）幾 KB 搞掂；要睇明細先另外鑽。

---

## 2. 請求

### 2.1 路徑

```
GET https://<expense-recorder 域名>/api/integration/ledger/purchase-report
    ?shopId=<shopId>&from=YYYY-MM-DD&to=YYYY-MM-DD

GET https://<expense-recorder 域名>/api/integration/ledger/purchase-report/receipts
    ?shopId=<shopId>&from=YYYY-MM-DD&to=YYYY-MM-DD[&cursor=<opaque>]
```

### 2.2 參數（summary 同 receipts 共用）

| 參數 | 必填 | 說明 |
| --- | --- | --- |
| `shopId` | ✅ | **你哋 `merchants.id`**（雙方已確認統一用呢個值） |
| `from` | ✅ | 開始日期 `YYYY-MM-DD`（含當日） |
| `to` | ✅ | 結束日期 `YYYY-MM-DD`（含當日） |
| `cursor` | receipts 用 | 上一次回應嘅 `nextCursor`（opaque）；首頁唔帶 |

**日期語意**（同你哋現有線下營業摘要 API 一致）：

| 用戶選擇 | from | to |
| --- | --- | --- |
| 今日 | 今日 | 今日 |
| 近 7 日 | 今日 − 6 | 今日 |
| 本月 | 本月 1 日 | 今日 |
| 本年 | 1 月 1 日 | 今日 |

🔴 **時間範圍冇上限** —— 可以查三年、查全歷史都可以。v2 因為有每日匯總表（③）同限流（④），全歷史查詢已經有保護，唔會再係「最重嘅查詢反而冇保護」。

### 2.3 請求標頭（HMAC 驗簽）

| 標頭 | 說明 |
| --- | --- |
| `X-Ledger-Timestamp` | Unix 秒（毫秒亦接受） |
| `X-Ledger-Signature` | 見下 |
| `If-None-Match` | ② 可選：上次回應嘅 `ETag`；吻合回 304 |

**簽名算法**（同你哋現有線下營業摘要 API 一致）：

```
signature = HMAC-SHA256(secret, timestamp + "." + "GET" + "." + pathWithQuery)
```

- 輸出小寫 hex
- `pathWithQuery` = path + `?` + query，**原字串、參數順序原樣**
  （例：`/api/integration/ledger/purchase-report?shopId=X&from=2026-10-05&to=2026-10-11`；
   receipts 路徑同上但 path 係 `/api/integration/ledger/purchase-report/receipts`，`cursor` 都入簽名）
- **簽名覆蓋 query** ⇒ 換 `shopId`／改日期／換 `cursor` 必須重新簽名
- 時效：**5 分鐘**（超時會被拒）
- secret 只存在兩邊伺服器，**唔好**放喺前端或登入後可讀嘅地方

**Node.js 例子**

```js
const crypto = require("node:crypto");

function signPurchaseReport({ secret, path, shopId, from, to, cursor }) {
  const timestamp = Math.floor(Date.now() / 1000);
  let q = `shopId=${encodeURIComponent(shopId)}&from=${from}&to=${to}`;
  if (cursor) q += `&cursor=${encodeURIComponent(cursor)}`;
  const pathWithQuery = `${path}?${q}`;
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
| 同一組 `(shopId, from, to)` 喺 Ledger 端快取 60 秒再重用 | 為咗「保持新鮮」重複拉同一組參數 |
| 鑽取明細先叫 `/receipts` | 為咗攞明細而每次都重拉成噸 summary |

每個請求都係一次真實資料庫查詢（雖然 v2 有快取＋匯總表，定時輪詢仍然會令 DB 負累隨門店數線性增長）。

### 3.1 限流（④ 上線前提）

| 維度 | 上限 | 超額回應 |
| --- | --- | --- |
| **每店** | **30 次／分** | `429 too_many_requests` |
| **全域**（所有店合計） | **300 次／分** | `429 too_many_requests` |
| **並發**（同時進行嘅 DB 查詢） | **10** | `429 too_many_requests`（帶 `Retry-After`） |

🔴 **30 次／分 per shop 係防撞牆嘅硬上限，唔係建議你用幾多次。**
正常 on-demand 用法（一位店主一日撳幾十次）永遠唔會撞到。
撞到 429 代表**你嘅用法有 bug**（例如意外跌入一個每 3 秒拉一次嘅 loop），唔係「我哋限你用」。

🔴 **全域 300／並發 10** 係為咗「門店一多 DB 撐唔住」嘅保護：即使每間店都守 30/min，
100 間店同時撳都會有 3000 次／分湧入 ⇒ 全域＋並發上限確保 DB 唔會被集體打爆。
呢兩個係**服務端強制**（in-memory best-effort；多實例環境要用共享儲存／distributed lock 先真正收口）。

---

## 4. 回應

### 4.1 summary 成功（HTTP 200）

```jsonc
{
  "v": 2,
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
    { "date": "2026-10-05", "currency": "MOP", "receiptCount": 1, "totalAmount":  880.50 }
  ],

  "suppliers": [
    { "name": "澳門糧記", "supplierId": "c2a9…", "currency": "HKD", "receiptCount": 4, "totalAmount": 9800.00 }
  ],

  "paymentBreakdown": [
    { "method": "bank_transfer", "label": "銀行轉賬", "currency": "HKD", "receiptCount": 7, "totalAmount": 20100.00 }
  ],

  "items": [
    {
      "name": "泰國香米", "unit": "KG", "currency": "HKD",
      "totalQuantity": 25, "totalAmount": 800.00, "avgUnitPrice": 32.00,
      "lineCount": 1, "lastPurchaseDate": "2026-10-11", "changePercent": 4.2, "direction": "up"
    }
  ],

  "flags": {
    "stockInOnly": true,
    "multiCurrency": true,
    "receiptsTruncated": false,
    "itemsTruncated": false
  }
}
```

> 🔴 **`v` 升到 2**（v1→v2 係唔兼容改動：路徑拆分＋限流收緊＋ETag）。
> Ledger 見到 `v:2` 就用新契約；v1 嘅舊 client 唔可以當 v2 用。

### 4.2 receipts 成功（HTTP 200）

```jsonc
{
  "v": 2,
  "shopId": "SHOP_000123",
  "range": { "from": "2026-10-05", "to": "2026-10-11" },
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
        { "lineId": "d3f1…", "name": "泰國香米", "quantity": 25, "unit": "KG",
          "unitPrice": 32.00, "totalPrice": 800.00, "productKey": "thai-jasmine-rice", "isStockItem": true }
      ]
    }
  ],
  "total": 12,
  "hasMore": true,
  "nextCursor": "eyIioJ6…"   // opaque base64url；下一頁帶返落 cursor=
}
```

- `total` = 符合區間嘅單據總數（截斷前）。
- `hasMore` = 仲有下一頁。
- `nextCursor` = 下一頁 cursor；`hasMore=false` 時為 `null`。

### 4.3 欄位說明

**`kpi`**（同 v1）

| 欄位 | 說明 |
| --- | --- |
| `currencies` | 區間內出現過嘅幣別清單 |
| `byCurrency` | **逐幣別**嘅單據數、總額、單均（改由 `purchase_report_daily` 讀出，O(日數)） |
| `receiptCount` | 單據總張數（跨幣，可以直接加） |
| `totalAmount` | ⚠️ **恆為 `null`** —— 見 §5.1 |
| `itemLineCount` | 品項行數（≠ 件數） |
| `avgPerReceiptDay` | ⚠️ **恆為 `null`** —— 跨幣無意義 |

**`daily[]`**（趨勢）：改由每日匯總表讀出，查一年都係 O(日數)。一個 `(日期, 幣別)` 一條。

**`receipts[]`**（逐張單據，新 → 舊，cursor 分頁）：`receiptDate` 得日期、`recordedAt` 唔做日界（同 v1 §5.3）。

**`items[]`**（品項聚合）：`totalQuantity` = 同品名＋單位＋幣別合併；`changePercent` / `direction` 同上次買入價比（見 §5.2）。

---

## 5. ⚠️ 三個必須知道嘅口徑

### 5.1 幣別會混用 —— 拆開睇，唔好加總

同一間店同一區間內**可能有 HKD 亦可能有 MOP**。服務端**唔會做任何匯率換算**。

🔴 `kpi.totalAmount` 恆 `null`、`kpi.avgPerReceiptDay` 恆 `null`；所有聚合維度都帶 `currency`。
**顯示建議**：`kpi.currencies` 有幾個幣別就開幾張卡，卡與卡**唔加總**。

### 5.2 品項升跌口徑

`items[].direction` ∈ `up`（貴咗）／`down`（平咗）／`same`／`new`（第一次買過）；`changePercent` = (今次加權均價 − 上次買入均價) ÷ 上次 × 100。
聚合 key = `name` 去空白轉小寫（同名跨單據合併）；金額 = Σ(單價 × 數量)。詳見 macau-pos `src/lib/purchase-items.ts` 嘅 `buildItemStats` 口徑（expenseRecorder 要逐字對齊）。

### 5.3 單據日期冇時刻，唔好用錄入時間

`receiptDate` 係單據上嘅日期（得日期）。`recordedAt` 係**店員幾點輸入系統**嘅時間，補登舊單可以差幾日。
⇒ **日界分組、畫圖、一切「邊日」嘅判斷，一律用 `receiptDate`，唔好用 `recordedAt`。**

---

## 6. 範圍與截斷

### 6.1 時間範圍無上限

`from` / `to` 冇任何日數限制，可以查全歷史。v2 因為有每日匯總表（③）同限流（④），全歷史查詢已受保護。

### 6.2 兩層：聚合（summary）vs 明細（receipts）

| 層 | endpoint | 內容 | 截斷 |
| --- | --- | --- | --- |
| **聚合層** | `/purchase-report` | `kpi` / `daily` / `suppliers` / `paymentBreakdown` / `items` | **永不**（讀匯總表 ＋ SQL GROUP BY，無原始行） |
| **明細層** | `/purchase-report/receipts` | 逐張單據（含 items） | cursor 分頁，每頁 **50**，靠 `hasMore`／`nextCursor` 攞落去 |

⇒ 「今年買咗幾多錢、邊間供應商最貴、邊款料最貴」**查幾耐都準確**，summary 永遠完整、永遠唔截斷。

### 6.3 receipts 分頁

- 每頁 **50 張**（`limit` 硬封頂 50，傳大過 50 當 50）。
- **cursor 分頁（唔用 offset）**：`cursor` = 上頁 `nextCursor`（opaque base64url，內含最後一行嘅 `receipt_date`＋`receipt_id`）；首頁唔帶。
- 深分頁唔會飄移（offset 喺資料變動時會漏／重行）。
- `total` 永遠係真實總數（唔受分頁影響）。

### 6.4 見到 `hasMore: true` 點處理

1. 顯示「第 N 頁」＋「共 X 張」，**唔可以**將 `receipts.length` 當總數。
2. 「載入更多」帶 `nextCursor` 再叫一次 `/receipts`。
3. 分析功能（KPI／圖表／排行）**用 summary**，唔受分頁影響。

---

## 7. 失敗回應

```jsonc
{ "error": "unauthorized" }         // 401：簽名錯／過期
{ "error": "bad_shop_id" }          // 400：shopId 格式錯
{ "error": "bad_range" }            // 400：日期格式錯，或 from > to
{ "error": "shop_not_found" }       // 404：店舖未綁定（見 §8）
{ "error": "too_many_requests" }    // 429：撞限流（per-shop / 全域 / 並發，見 §3.1）
{ "error": "server_misconfigured" } // 500：我哋 secret 未配置（fail-closed）
{ "error": "rpc_not_deployed" }     // 503：SQL 未跑（42883 / PGRST202）
{ "error": "upstream_unavailable" } // 503：資料庫故障／回傳值驗證失敗
```

**共同原則：唔會回「假零」。** 查詢失敗就回 5xx，唔會送一張 0 元／0 件嘅卡（假數比冇數危險）。

### 7.1 條件請求（②）

summary endpoint 支援 `If-None-Match: "<dataVersion>"`：

- 若 `dataVersion` 同你上次攞到嘅一樣 ⇒ 回 **`304 Not Modified`**（無 body，只帶 `ETag`＋`Cache-Control`），**唔重查 DB**。
- `dataVersion` 係**每店**一個整數，任何 `stock_in` 單有寫入就 +1（trigger 維護）。
  ⚠️ 佢係**商戶級**而唔係**區間級** ⇒ 保守（該店任何單據變動都會令所有 range 嘅 304 失效），但保證唔會畀到舊數。

---

## 8. ⚠️ 「查得到但零張單」嘅準確語意

| 情況 | HTTP | 回應 | 你哋應該顯示 |
| --- | --- | --- | --- |
| 查得到，區間內**真係冇單** | **200** | `receipts: []`、零值 KPI、`total: 0` | 「該期間沒有買貨紀錄」—— **正常狀態** |
| 店舖從未用 Ledger 登入過 | 404 | `shop_not_found` | 「店舖未連接」 |
| 服務未部署／資料庫故障 | 503 | `rpc_not_deployed` / `upstream_unavailable` | 「暫時無法取得」 |
| 簽名錯／過期 | 401 | `unauthorized` | 「暫時無法取得」 |

🔴 **`receipts: []` 係有效答案，唔係錯誤。** 只可以當 200 正常處理，唔可以因為陣列係空就彈錯誤或紅字。

---

## 9. 回應標頭

| 標頭 | 說明 |
| --- | --- |
| `cache-control` | `private, max-age=60`（①；`private` ＝ 只畀 Ledger 伺服器，唔入共享 CDN） |
| `etag` | `"<dataVersion>"`（②） |
| `x-purchase-report-v` | `2` |
| `x-purchase-report-path` | `/api/integration/ledger/purchase-report`（summary）或 `…/receipts` |
| `x-purchase-report-caps` | 能力清單（見 §10） |

> ① `max-age=60` 係服務端快取：60 秒內同一 `(shopId, from, to)` 嘅重複請求唔使重查。
> 配合 ② `ETag`，Ledger 帶 `If-None-Match` 就連呢 60 秒內都慳到 DB 查詢（直接 304）。

---

## 10. 能力探測（caps 標頭）

`v` 已經係 `2`（唔兼容 v1），所以呢版**唔靠 caps 做版本降級**。caps 用嚟宣告「呢次回應有咩節」，
方便 Ledger 以後加欄位時唔使升 `v`：

```
x-purchase-report-caps: kpi,daily,suppliers,paymentBreakdown,items,receiptsCursor,etag
```

- summary 永遠有 `kpi,daily,suppliers,paymentBreakdown,items,etag`。
- receipts 額外有 `receiptsCursor`（cursor 分頁能力）。
- 日後加新節（例：庫存現況）⇒ 只加 caps 值，唔升 `v`，舊 client 見唔到就忽略。

---

## 11. 本版範圍

### v2 只回「入貨單」

資料庫入面單據分三類：`stock_in`（入貨）、`expense`（租金水電薪資等營運支出）、`other`。

**v2 只回 `stock_in`**（`flags.stockInOnly` 恆 `true`）。v3 會加機讀 `type` 參數（`type=stock_in|expense`）。

### 庫存現況唔喺呢度

「現存幾多件、需唔需要補貨」屬於庫存主檔，會另開一條 API（第二階段）。

---

## 12. 安全事項

1. **secret 只喺 Ledger 伺服器**。唔好放喺前端、唔好寫入會下發到瀏覽器嘅設定。
2. **唔可以重用**其他 integration 嘅 secret（線下營業摘要、webhook、SSO 各有各把）。共用一把 = 一邊爆就兩邊爆。
3. 本 API **淨係讀**，冇任何寫入。
4. 回應**唔會**包含相片、職員姓名、記事等私人內容（單據 OCR 原文一律唔會外傳）。
5. 每次請求都會驗簽 + 限流（④ 三維）；失敗嘗試會記錄喺服務端日誌。
6. 🔴 **聚合全部行 SQL（⑥）**：所有 KPI／趨勢／品項／供應商／付款都係由 RPC 喺 DB 內 GROUP BY 砌好，
   **絕對唔可以**喺 client 用 supabase-js `select` 拉原始單據行落 Vercel 再加總 ——
   supabase-js 預設**靜默截斷喺 1000 行**，拉唔晒就會令數字算錯（假零），而且反覆拉會踩 egress 紀律。
7. 🔴 **快取係 `private`**：回應可能含供應商名／金額，只可以 cache 喺 Ledger 伺服器，唔可以落公共 CDN。
8. 🔴 **ETag 係商戶級**：跨 range 保守失效冇問題，但切記唔好當佢係「區間級」快取鍵。

---

## 13. 上線步驟

| # | 步驟 | 負責 | 上線前提？ |
| --- | --- | --- | --- |
| 1 | 雙方各產生一把專用 HMAC secret | 雙方 | — |
| 2 | expenseRecorder 跑 SQL（匯總表＋trigger＋兩支 RPC）＋ backfill 舊單 | expenseRecorder | 🚩 ③ |
| 3 | expenseRecorder 配置環境變數（`LEDGER_PURCHASE_REPORT_HMAC_SECRET`）、部署 route | expenseRecorder | — |
| 4 | 雙方用 staging secret 跑 §2.3 嘅 curl 測試（核對 payload） | 雙方 | — |
| 5 | 交換正式 secret | 雙方 | — |
| 6 | Ledger 開通入口（summary ＋ receipts 兩條路徑都要簽到） | Ledger | — |

🔴 **上線前提（首 4 點，缺一不可）**：① 服務端快取 `private, max-age=60`；② `dataVersion`＋`ETag`/304；
③ 每日匯總表 `purchase_report_daily` + backfill；④ 限流 30/店＋全域 300＋並發 10。
冇呢 4 樣，全歷史查詢會隨門店數線性打爆 DB，唔可以上線。

**降級行為**：secret 未配置 ⇒ 500（fail-closed）；SQL 未跑 ⇒ 503（`rpc_not_deployed`）；DB 故障 ⇒ 503。
兩種情況都應該顯示「暫時無法取得」，**唔好顯示空白卡或 0**。

---

## 14. 常見問題

**Q：查全歷史會唔會爆？**
唔會。v2 有每日匯總表（KPI／趨勢讀佢，O(日數)）＋限流（30/店＋全域 300＋並發 10）。
全歷史都受保護，最重嘅查詢反而有保護（呢點同 v1 相反，v1 係「無上限又無保護」）。

**Q：點解 summary 同 receipts 分兩條？**
v1 一次過包晒（KPI＋500 單＋1000 品項），「睇一張卡」都要拉成噸嘢。v2 張卡（summary）幾 KB；
要睇明細先叫 `/receipts`（cursor 每頁 50），減 payload 又唔會飄移。

**Q：點解 `totalAmount` 係 `null`？**
因為同一區間可能有 HKD 同 MOP，加埋個數字冇意義。用 `kpi.byCurrency` 分幣別睇。

**Q：ETag 係咪區間級？**
唔係，係**商戶級** `dataVersion`。該店任何 `stock_in` 單有變就 +1，所有 range 嘅 304 都失效 →
保證唔會畀舊數（代價係偶爾多查一次 DB，但配合 60s 快取影響極微）。

**Q：點解唔可以喺 client 加總？**
supabase-js 預設靜默截斷喺 1000 行，拉唔晒就假零；而且反覆拉踩 egress 紀律。所有聚合行 SQL RPC。

**Q：點解同一日喺 `daily[]` 會出現兩條？**
因為 HKD 同 MOP 分開計。畫圖時按 `date` 分組。

**Q：點解唔會回相片？**
單據辨識嘅原文（含相片路徑、店員手寫備註）屬店內資料，唔會經呢條 API 外傳。

---

## 15. 聯絡

技術問題或 payload 唔符合預期，請直接聯絡，我哋會查資料庫實際值同你哋對數。
