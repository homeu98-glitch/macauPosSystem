# 37. APK 打印格式適配 — 同事改動需求書（Native Bridge）

> **目的**：POS 網頁經 `window.PosNative.printJob(json)` 落單去 Sunmi APK，APK 要用 `EscPosRenderer` 產生完整 ESC/POS 票據（店名抬頭、票種、單號、時間戳、切紙、每台 charset）。呢份係交畀 APK 同事嘅改動需求，POS 端已經接好，等 APK 對齊。
>
> **背景**：POS 有兩條打印路徑 —— ① Native bridge（`PosNative.printJob`，本需求主體）；② HTTP Hub fallback（`/api/print`，純文字）。只有 ① 會用到 `EscPosRenderer` 嘅完整格式。以下所有要求都係針對 ①。

---

## 1. 現狀問題（點解要改）

APK `EscPosRenderer.renderReceiptTicket` 而家只印 `name x qty`：

```kotlin
for (item in job.items.orEmpty()) {
    buf.line("${item.name} x${item.quantity}")
}
```

但 POS 嘅收據 builder 將 **總計、付款方式、店名、salon 嘅小計/折扣/套票/積分/定金/小費/應收/找零/賺分** 全部塞落每個 item 嘅 `note` 欄（同埋 `specs` 放規格）。如果收據 renderer 唔印 `note` / `specs`，經 native 落單嘅收據會變成「淨係有 item 名 + 數量，所有金額同資料都消失」。

`renderKitchenTicket`（廚房/取消單）本身就印 `specs` + `note`，所以廚房單冇問題，得收據單有呢個漏。

---

## 2. 必須改動（P0 · 阻擋性）

**檔案**：`net/EscPosRenderer.kt` → `renderReceiptTicket(...)`

將 item 迴圈改成同 `renderKitchenTicket` 一致，render `specs` 同 `note`：

```kotlin
for (item in job.items.orEmpty()) {
    val qty = if (item.quantity <= 0) 1 else item.quantity
    buf.line("${item.name} x$qty")
    for (spec in item.specs.orEmpty()) buf.line("  · $spec")
    item.note?.takeIf { it.isNotBlank() }?.let { buf.line("  $it") }
}
```

效果：收據會逐行印出「品名 x 數量」→ 規格細項 → 備註/金額細項，同廚房單一致。POS 傳過嚟嘅 total / payment / 店名等全部喺 `note` 入面，會正確顯示。

> 唔使改 `renderKitchenTicket`、`renderTestPage`、或者 `Bridge.printJob` 嘅分派邏輯（按 `kind` 去 `renderReceiptTicket` / `renderKitchenTicket` / `renderTestPage` 嗰段已經啱）。

---

## 3. 合約確認（P1 · 對齊用，唔啱先改）

POS `dispatchJobToNative` 會 call：

```js
window.PosNative.printJob(JSON.stringify(payload))
```

`payload` 結構（APK `Bridge.printJob` 已經收 `{ job, printer, kind, storeName, paymentMethod, total }` 呢個形）：

```jsonc
{
  "job": {
    "id": "print-xxxx",
    "orderNo": "A123",                 // 單號（可空 string）
    "tableName": "3號枱",              // 枱號 / salon 客戶名（可空 string）
    "ticketType": "normal",           // "normal" | "addon" | "void"
    "printerId": "printer-xxx",
    "printerName": "前檯收據機",
    "items": [
      { "name": "炸雞", "quantity": 2, "specs": ["大"], "note": "走冰" },
      { "name": "總計", "quantity": 1, "specs": [], "note": "MOP 100" }
    ],
    "createdAt": 1755667200000        // ⚠️ epoch millis（Long），唔係 ISO string
  },
  "printer": {
    "id": "printer-xxx",
    "name": "前檯收據機",
    "connectionType": "lan",
    "ipAddress": "192.168.1.112",
    "lanPort": 9100,
    "paperSize": "80mm",              // 含 "58" → 32 寬，否則 42 寬
    "charset": "gb18030"              // ⚠️ 每台可配：gb18030 / gbk / big5 / utf-8
  },
  "kind": "receipt",                  // "receipt" | "kitchen" | "test"
  "storeName": "示範店",              // 收據 header 用
  "paymentMethod": "",                // 暫空（POS 經 note 傳，見下）
  "total": null                       // 暫 null（POS 經 note 傳，見下）
}
```

### 3.1 `createdAt` 格式
POS 傳嘅係 **epoch millis（Long）**。`PrintJobDto.parseTimestamp` 已經 accept ISO 同 millis，但請同事確認 APK 端 `renderKitchenTicket` / `renderReceiptTicket` 用 `createdAt` 嗰句係 `Date(job.createdAt ?: ...)` 而 `createdAt` 係 `Long?` —— 咁就啱。如果 APK 內部有將 `createdAt` 當 string 處理就要改。

### 3.2 `charset` 要 apply
`renderReceiptTicket` / `renderKitchenTicket` 已經有 `resolveCharset(printer?.charset)` 並 fallback GB18030 → UTF-8，請同事確認 `printer.charset` 有從 payload 嘅 `printer` 物件讀到（而家 POS 一定帶 `charset`，預設 `gb18030`）。如果 APK 某條路徑（例如 HTTP fallback `printTextTicket`）hardcode UTF-8 而忽略 charset，嗰條路徑印中文會亂碼，但唔影響 native 主路。

### 3.3 `kind` 映射
- `kind === "receipt"` → `renderReceiptTicket`
- `kind === "kitchen"` → `renderKitchenTicket`（分區出單 / 取消單 / 標籤機都用呢個）
- `kind === "test"` → `renderTestPage`
- 缺省 → `renderKitchenTicket`

### 3.4 `storeName` / `paymentMethod` / `total` 參數
POS 暫時 **唔會填 `paymentMethod` 同 `total`**（留空 / null），因為收據嘅總計同付款已經喺 `job.items[].note` 入面。APK 如果收到非空 `total` / `paymentMethod` 就印對應行；收到空就唔印。呢個設計令 native 路徑同 HTTP fallback 路徑（`renderJobToText` 都係印 note）保持一致，唔會重複印總計。

> 如果同事想用 APK 原生 `total` / `paymentMethod` 行（更靚），可以之後再做：POS 改為將總計/付款拆出嚟做專屬參數、唔好放落 note。呢版先做最小改動令資料唔漏。

---

## 4. 驗收標準（同事改完 self-check）

- [ ] 收據經 `PosNative.printJob({kind:"receipt"})` 落單，印出嚟有：店名抬頭、票種「收據」、單號、枱號、**每項嘅規格細項、每項嘅備註/金額細項（總計/付款/店名等都顯示）**、時間戳、切紙。
- [ ] 廚房單（`kind:"kitchen"`）維持現有樣（已經印 specs+note，唔使改）。
- [ ] 中文用 `printer.charset`（預設 GB18030）編碼，唔係 hardcode UTF-8。
- [ ] 標籤機（`role:"label"`，POS 傳 `kind:"kitchen"`）印到普通文字票（暫無 QR/條碼需求）。
- [ ] `createdAt` 印出正確時間（唔係 1970 或當機時間）。

---

## 5. 已知 v1 cosmetic 問題（唔阻擋，之後再 refine）

收據經 native 落單時，`單號` / `桌台` / `店名` 會同時出現喺 APK header（嚟自 `job.orderNo` / `job.tableName` / `storeName` 參數）同 builder 嘅 note 行（POS 收據 builder 都有擺呢三行）。即係會印兩次。POS 側已知呢個，之後會 refine builder 移除重複 meta 行；APK 側唔使特別處理。

---

## 6. 聯絡 / 上下文

- POS 端改動：見 `docs/36-native-print-agent.md`「Native bridge 重新啟用（2026-08-20 · 打印格式適配）」sub-section。`src/lib/print-bridge/native.ts` 係新 bridge，`dispatch.ts` / `salon/print.ts` 已改為 native 優先、Hub HTTP fallback。
- 呢份需求書只講 APK 側。APK 同事改完 rebuild APK、裝機測試就得。
