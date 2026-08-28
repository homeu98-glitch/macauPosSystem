# 79 — 線上單標籤逐杯出紙（granularity 對齊堂食）

> 狀態：方案已落槌（D1–D4 用戶拍板），待實作。
> 關聯：`docs/55`（Android 模板驅動化，Phase 2 跨 repo 部分）、`docs/37`（APK 格式契約）、`docs/41`（打印路徑總覽）。
> 改碼範圍：本 repo（`src/lib/print-jobs.ts`、`src/lib/ledger/ledger-pos-bridge.ts`、`src/lib/print-bridge/dispatch.ts`、`src/lib/print-bridge/native.ts`、`src/lib/escpos-template.ts`、`src/lib/types.ts`）+ Android APK（用戶另倉庫）。

## 1. 決策落槌

| 題 | 決定 | 備註 |
|---|---|---|
| D1 粒度 | **qty 展開**：5 杯 → 5 張 label；堂食接 label 機同樣處理 | 唔係「一項一張」，係「一杯一張」 |
| D2 label 機分區 | **label 機必須填 zoneId**（如 `drinks`）；嚴格匹配，唔套用 catch-all | 唔需要「每項 multiple printerGroup」，見 §3 |
| D3 Android APK | 用戶自理（跨 repo）；本 repo 出 `native.ts` payload 改動 + 給 APK spec | 見 §4.5 / §4.6 |
| D4 標籤加 qty / 第 n/N 杯 | **唔加** | 標籤模板不變；純靠 qty 展開張數 |

## 2. 背景與現狀

### 2.1 三條渲染路徑對同一個 PrintJob 嘅讀取唔同

| 路徑 | 讀乜 | 標籤版式 |
|---|---|---|
| 網頁預覽 `escpos-render.ts` | template + content + items | 靚 |
| 桌面 Companion 0.1.11 `renderEscPos` | template + content + items | 靚（模板驅動） |
| Android APK `EscPosRenderer` | **只 items**（`native.ts` 冇傳 template/content） | ❌ 廚房式／空 |

### 2.2 線上單標籤粒度錯亂

| 情境 | builder | 結果 |
|---|---|---|
| 線上首次出單 | `ledger-pos-bridge.ts:buildPrintJobsForItems` | 1 個 job 裝晒全部品項（items 陣列） |
| 堂食 / 線上退單 | `print-jobs.ts:buildLabelPrintJobs` | 每項 1 個 job（items 空 + content + template） |

同一張線上單：落單時「一張晒全部」、取消時卻「逐項」→ 前後不一致。根因係兩個 builder 各自演進。

### 2.3 Android 未讀 template（跨 repo，見 `docs/55`）

`native.ts` payload 只轉發 `job.items`，冇 `template`/`content`；APK `EscPosRenderer` 仲係硬編碼舊路，連 label 機都行 `renderKitchenTicket`（`docs/37` §3）。所以就算 POS 出到靚標籤，Android APK 都只出廚房式單——要 Phase 2 先解決。

## 3. 關鍵澄清：多打印機路由已經支援，唔需要 multiple printerGroup

用戶擔心：「set 咗廚房就只去廚房機，點樣同時去廚房機 + 標籤？」

**答案：而家嘅 `role` + `zoneId` 模型已經做到，唔使改 schema。**

- `MenuItem.printerGroup` 係「屬於邊個 zone」（如 `kitchen` / `drinks` / `food`），**單值**。
- 同一個 zone 入面，可以同時有：
  - 一台 `role: "zone"` 嘅打印機 → 出**廚房 slip**（呢個 zone 嘅菜品清單）
  - 一台 `role: "label"` 嘅打印機（zoneId 同佢一樣）→ 出**杯貼**
- `buildKitchenPrintJobs` 同 `buildLabelPrintJobs` 各自 `filter(printer.role === ...)` 再 `it.printerGroup === printer.zoneId` 匹配。**同一個 printerGroup 會同時命中 zone 機同 label 機。**

**具體配置（飲品站）**：

```
drinks 項：MenuItem.printerGroup = "drinks"
  ├─ 打印機 A（role=zone,   zoneId="drinks"）→ 飲品部廚房 slip（「凍檸茶 x5」一次過）
  └─ 打印機 B（role=label,  zoneId="drinks"）→ 5 張杯貼（一台一杯）
food   項：MenuItem.printerGroup = "kitchen"
  └─ 打印機 C（role=zone,   zoneId="kitchen"）→ 廚房 slip；冇 label 機對應 → 唔出杯貼
```

即「一杯一杯貼」係靠 label 機嘅 qty 展開（§4.1）實現；「同時去廚房 + 標籤」係靠同一 zoneId 落兩台唔同 role 嘅機實現。**食材唔使 set 多個分區。**

> 例外（今輪唔做）：若某項要同時出現喺「主廚房 slip」同「飲品部 slip」兩個唔同 zone，先至需要 multiple printerGroup per item——留待日後增強。

## 4. 方案

### 4.1 Phase 1 — 本 repo（預覽 + Companion 即完美；Android 粒度啱但版式廚房式）

**① 抽共用 label builder（single source of truth）** — `print-jobs.ts` 新增：

```ts
export function buildLabelJobsForItems(opts: {
  orderId: string; orderNo: string; tableName?: string;
  ticketType: "normal" | "addon" | "void";
  items: OrderItem[];
  storeName?: string; itemNamePrefix?: string;
}): PrintJob[]
```

內部邏輯：
- `labelPrinters = enabled && role === "label"`
- **嚴格匹配**（唔套用 catch-all）：`it.printerGroup === printer.zoneId`（zoneId 必填；冇 zoneId 嘅 label 機對唔中任何 item → 唔出紙，符合 D2）
- **qty 展開**（D1）：`for (let i = 0; i < item.quantity; i++)` 產生一張杯貼 job
- 每張 job 同時帶：
  - `items: [嗰一杯]`（俾 Android fallback + 預覽兼容）
  - `content: buildLabelContent(orderNo, item, opts)`（甜度/冰量/加料解析）
  - `template: buildSnapshot("label", labelTemplate)`（靚版式）

**② `buildLabelContent` 簽名簡化** — 由 `(order: PosOrder, item, opts)` 改為 `(orderNo: string, item, opts)`（現只用到 `order.localOrderNo`）。call site：`print-jobs.ts` 內部 + `print-center.tsx:279` 預覽 sample。

**③ delegate，消除漂移**：
- 堂食 `buildLabelPrintJobs(order, opts)` → 改為包 `buildLabelJobsForItems({orderId: order.id, orderNo: order.localOrderNo, tableName: order.tableName, ticketType, items: order.items, ...})`
- 線上 `ledger-pos-bridge.ts:buildPrintJobsForItems` 嘅 label 分支 → 改 call `buildLabelJobsForItems`（zone 分支唔變，保留 catch-all + orphan 兜底）
- `buildVoidPrintJobsForOrder` / `buildReopenPrintJobs` 經已 call `buildLabelPrintJobs` → 自動跟到（退單/返結杯貼亦逐杯）

**④ `dispatch.ts` 加 `kind: "label"`**：

```ts
const kind = printer.role === "receipt" ? "receipt"
  : printer.role === "label" ? "label"
  : "kitchen";
```

理由：而家 label 機 `kind` 係 `"kitchen"`，Companion 嘅 titleText 邏輯會喺杯貼頂印「＊＊＊ 廚房 ＊＊＊」（`docs/55` §1）；改 `"label"` 後 titleText 變空，先至啱。網頁預覽 `KitchenTicketPreview` 用 `job.template`，唔受 `kind` 影響。

### 4.2 Phase 2 — 本 repo `native.ts` + Android APK（用戶自理）

對齊 `docs/55` checklist：

**⑤ `native.ts` payload 加 template / content（本 repo）** — `payload.job` 加：

```ts
template: job.template ?? null,   // EscPosTemplateSnapshot | undefined
content: job.content ?? null,     // Record<string,string> | undefined
```

APK 側要定義同一 shape 嘅 Kotlin data class decode。

**⑥ APK `EscPosRenderer` 改動（用戶倉庫）**：
- `NativePrintKind` 加 `"label"`；`Bridge.printJob` 按 `kind` 分派
- 加 template 分支：有 `job.template` 就逐 block 行（label 用 `template.kind === "label"` 決定 section 集），`items` block 逐項印；無 template 留舊 fallback
- 驗證：「設計 == 預覽 == 出紙」對齊 Companion（`companion-server.mjs` `renderEscPos`）
- **APK 必須 rebuild + 派版**（source 改完唔等於生效，desktop 規約同款）

## 5. 設備設定指引（俾商家）

1. label 機 `zoneId` 必填，且要等同目標項嘅 `printerGroup`（如 `drinks`）。
2. 飲品項 `MenuItem.printerGroup` 設 `"drinks"`；食物項設 `"kitchen"`（或 `"food"`）。
3. 同一 zone 配一台 `zone` 機（slip）+ 一台 `label` 機（杯貼），各自 role 唔同、zoneId 相同。
4. label 機 `copies` 咪設 >1（否則每杯印兩張）。
5. dev 模式下，若偵測到 label 機冇 zoneId，console.warn 提示。

## 6. 驗證矩陣

| 項 | 預覽 | Companion | Android（Phase 2 後） |
|---|---|---|---|
| 5 杯凍檸茶 → 5 張杯貼 | ✅ | ✅ | ✅ |
| 杯貼版式（大字品名 / 甜度 / 冰量 tag） | ✅ | ✅ | ✅ |
| 食物項唔出杯貼 | ✅ | ✅ | ✅ |
| 退單杯貼（void）逐杯 | ✅ | ✅ | ✅ |

`tsc --noEmit`（除已知 `layout.tsx` LayoutProps 誤報）+ `eslint` 相關檔歸零。

## 7. 風險 / 待確認

- **R1** Phase 1 後 Android 出到「每杯一張」但係廚房式版式（冇甜度/冰量 tag），要 Phase 2 先靚。若門店主力係 Android APK，建議 Phase 1+2 一齊上。
- **R2** strict label 匹配：若商家手動加 label 機但漏填 zoneId → 唔出杯貼（預期，但建議 UI 強制 label 機填 zoneId，留待設備設定頁增強）。
- **R3** qty 展開張數可能多（大單幾十張），屬預期；label 機 `copies=1` 即可。

## 8. 落實分工

| 步 | 倉庫 | 負責 |
|---|---|---|
| §4.1 ①–④ | macauPosSystem | 本助理 |
| §4.2 ⑤ native.ts payload | macauPosSystem | 本助理 |
| §4.2 ⑥ APK template + kind:"label" | print-agent-android | 用戶 |
