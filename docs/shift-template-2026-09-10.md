# 交班模板（商家可自行編輯嘅交班結算單排版）

日期：2026-09-10
狀態：已實作（migration 0030 / types / escpos-template / escpos-render / storage / mock-data / print-jobs / shift-page / print-center / print-templates route / state route / pos-app）
前置：migration **0027**（`pos_print_templates` 四槽模板按店存 DB）、0030（加 `shift` / `shift_presets` 兩欄）

---

## 1. 用途與適用情境

### 1.1 交班結算單係咩

收銀員收工 / 換班時，POS 會印一張「交班結算單」（喺 `shift-page.tsx` 撳「交班」流程最後一步）：匯總當班嘅
已結帳單數、營業額、應收 / 實收、支付方式分項、會員通線上單、今日買貨成本、現金箱核對、備註。

### 1.2 點解要「交班模板」

交班單以前**完全冇模板**——`shift-page.tsx` 把整張單硬編成一串文字行，塞入 `PrintJob.items`（每行
`quantity: 1`），而且**冇帶 `template` 快照**。打印通道見到「冇 template」就退回**硬編廚房渲染器**，
於是出紙變：

| 症狀 | 成因 |
| --- | --- |
| 抬頭印出 `【廚房單】` | 通道 fallback 到 `renderKitchenTicket` 並寫死票種標題 |
| 多印一行 `打印機: xxx` | 廚房渲染器嘅固定欄位 |
| 每一行尾都帶 `x1` | 廚房渲染器逐行 `${name}  x$qty` |
| 分節標題變純文字 `— 店內（今日）— x1` | 同上，標題都當成一個 item |
| 冇字型 / 粗體 / 對齊 / 分格線 | 硬編渲染器冇視覺設定 |

即係：**設計上就冇模板可用**，商家想改排版只能改代碼。同時「交班即印」同「歷史重打」係兩份**內容都唔同**
嘅硬編 builder，同一張單兩條路出紙唔一致。

### 1.3 適用情境

- 唔同班別 / 唔同店想要唔同匯總粒度：日結單要齊全，現金班只要「應收 / 實收 / 差額」三行。
- 法規 / 稅務要求某幾項必須印（例如現金差額），用模板明確開關比靠代碼保障更實在。
- 連鎖店用一套雲端同步嘅模板，令全部分店出紙格式一致（配合 0027 store-level 同步）。
- 想改抬頭 / 頁尾文案（例如加「如需對帳請聯絡 XXX」）唔使等人改代碼。

### 1.4 明確唔影響嘅嘢

交班模板係**第五個獨立槽位**，改佢**唔會**影響收據 / 標籤 / 廚房單 / 自助點餐機模板（各自獨立存）。

---

## 2. 資料結構

### 2.1 `ShiftTemplate`（`src/lib/types.ts`）

結構刻意對齊 `KitchenTemplate` / `LabelTemplate`（`blocks` + `order` + `headerText` + `footerText`），
令設計介面、`buildSnapshot()`、雲端同步、normalize 可以**行返同一套既有機制**，唔使為交班單另建一套。

```ts
export interface ShiftTemplate {
  blocks: Record<ShiftSectionId, EscPosBlockStyle>;
  order: ShiftSectionId[];
  headerText: string;
  footerText: string;
  /** 分節標題文字（商家可自訂，例如把「— 店內（今日）—」改成「— 堂食（今日）—」）。 */
  sectionTitles: Partial<Record<ShiftSectionId, string>>;
}
```

`ShiftSectionId` = **29 個區塊**（見 `SHIFT_SECTION_META`），分三類：

1. **基本資料**：`header` / `store_name` / `shift_no` / `employee` / `close_time` / `open_time`
2. **值區塊**：`settled_count`、`revenue`、`receivable_total`、`paid_total`、`prepaid`、`refund`、
   `online_order_count`、`online_paid`、`online_balance`、`online_in_store`、`online_total`、
   `payment_breakdown`、`purchase_paid`、`expected_cash`、`actual_cash`、`cash_diff`、`note`、`footer`
3. **分節標題**（`section_*`，值可喺 `sectionTitles` 改）：`section_store`、`section_online`、
   `section_payment`、`section_purchase`、`section_cash`

> **點解冇 `divider` 區塊**：三個 repo 嘅渲染器都**只喺 `items` 區塊前後**產生分格線
> （`escpos-render.ts` / `companion-server.mjs` / `EscPosRenderer.kt`）。交班單冇 `items`，
> 加 `divider` 只會係一個撳完冇反應嘅死開關。所以**刻意唔加**。
> （收據 / 廚房單嘅 `divider` 契約見 `docs/handoff-print-divider-size.md`。）

### 2.2 範本（Variant）

```ts
export interface ShiftTemplateVariant { id: string; name: string; template: ShiftTemplate; }
```

語義同 `PosLocalSettings.specTemplates`（菜品規格模板）一致 —— 係一個**範本庫**：

- **庫** = 具名嘅存檔，**唔係**即時生效嘅；
- **生效嘅係** `PrintTemplates.shift`（工作中模板）；
- 「儲存為範本」= 把目前排版存成具名範本；
- 「套用」= 把範本內容**拷貝**落工作中模板（之後嘅編輯唔會回寫範本）；
- 「刪除」= 只由庫移除，**唔會**動到目前生效中嘅排版（防誤刪令出紙返去預設）。

咁做係刻意嘅：若範本同生效模板係同一份物件，任何一次微調都會改到範本本身，商家就再冇
「還原返上一個版本」嘅機會。

### 2.3 出紙內容快照 `ShiftSettlementSnapshot`

`shift-page.tsx` 喺進入結數預覽（step3）時**固化**一份資料快照，之後「預覽 / 打印 / 跳過」都用同一份，
保證**預覽 == 紙本 == 交班記錄**。同時亦係交班記錄（`shiftHistory`）嘅持久化形狀
（`ShiftHistoryRecord.detail?: ShiftSettlementSnapshot`，令歷史**重打**可以百分百還原當日數字，
而唔係用今日嘅餐牌 / 今日嘅支付方式去重算）。

> 呢個 type 放喺 `types.ts` 而唔係 `shift-page.tsx`：`escpos-template.ts` 嘅 `buildShiftContent()`
> 要讀佢，而 component 唔應該被 lib 反向 import（會成 circular dependency）。

### 2.4 設定與 DB

| 位置 | 欄位 | 說明 |
| --- | --- | --- |
| `PrintTemplates` | `shift: ShiftTemplate` | 第五個槽位（生效中模板） |
| `PosLocalSettings` | `shiftTemplatePresets: ShiftTemplateVariant[]` | 範本庫 |
| `PosLocalSettings` | `activeShiftTemplateId: string` | 上次套用嘅範本 id（UI 顯示「基於：X」；`""` = 自訂排版） |
| DB `pos_print_templates` | `shift jsonb not null default '{}'` | 生效中交班模板 |
| DB `pos_print_templates` | `shift_presets jsonb not null default '{}'` | `{ presets: [...], activeId: "..." }` |

`PrintTemplateKind` 同 `PrintKind` 都已加入 `"shift"`。

---

## 3. 範本管理機制（新增 / 編輯 / 刪除 / 套用）

全部喺 `print-center.tsx`（`/prints` → 新增分頁 **「交班模板」**，tab id `shift-template`）。

| 操作 | 函數 | 行為 |
| --- | --- | --- |
| **新增** | `createShiftPreset()` | 驗證名稱 → 上限檢查 → `crypto.randomUUID()` 生成 id（**唔可以**用 `count`，刪完再新增會撞 id）→ 存成範本並標記為「使用中」（因為內容就係目前排版） |
| **套用** | `applyShiftPreset(id)` | 把範本**拷貝**落 `printTemplates.shift` 同時設 `activeShiftTemplateId`（一次過原子寫入，見 §5.2） |
| **編輯（覆蓋）** | `overwriteShiftPreset(id)` | 用目前排版覆蓋指定範本 |
| **編輯（改名）** | `commitRenameShiftPreset(id)` | 改名（`exceptId` 排除自己再查重名） |
| **刪除** | `deleteShiftPreset(id)` | `window.confirm` 二次確認；只移除庫存項，**唔動**生效中排版；若刪嘅正好係「使用中」嗰個 → 順手清空 `activeShiftTemplateId`（避免 UI 顯示一個唔存在嘅範本名） |
| **分節標題** | `setSectionTitle(id, text)` | 改 `section_*` 區塊嘅標題文字（存 `sectionTitles`，係「設計」唔係「當日數據」） |

### 3.1 撤銷 / 重做（Undo / Redo）嘅邊界

`updateLocalTemplate(nextSettings, recordHistory)` 嘅 `recordHistory` **必須**分開處理：

- 撤銷歷史**只記錄 `printTemplates`**（即「設計」），**唔記錄範本庫**；
- 所以純範本庫操作（新增 / 改名 / 覆蓋 / 刪除）一律 `recordHistory = false` ——
  否則商家撳「撤銷」會莫名其妙噉還原咗排版，但佢啱啱只係改咗個範本名；
- 「套用」就相反：佢**真係**改咗排版 → 要入歷史（可以由撤銷還原）。

改動時順手把 `options?: { recordHistory?: boolean }` 收斂成 simple boolean ——
實際**所有** caller 都係傳 `false`（改動前只有「套用」傳 true，而「套用」已改為原子寫入唔行呢條路），
個 options 物件只係多餘包袱。

---

## 4. 與既有模板系統嘅整合方式

原則：**唔另建一套**，全部沿用收據 / 廚房單嗰套管線。

### 4.1 渲染：`buildSnapshot("shift")` → 同一個 `renderEscPosLines()`

```ts
// escpos-template.ts buildSnapshot()
const source =
  kind === "label" ? withLabelFixedSizes(template as LabelTemplate)
  : kind === "shift" ? normalizeShiftTemplate(withReceipt as Partial<ShiftTemplate>) // 補齊區塊、唔補 divider
  : ensureDividerSection(withReceipt as ...);
```

### 4.2 出紙內容：`buildShiftContent()` 單一真源

改動前有**兩份**近似但內容唔同嘅硬編 builder（`shiftDetailToLines` 用於交班即印、
`buildShiftPrintLines` 用於歷史重打）——同一張單兩條路出紙唔一致。

而家收斂成一個 `buildShiftContent(data, opts): Record<string, string>`（section id → 文字），
就係出紙內容嘅**唯一真源**，同時餵：

- 「交班模板」設計頁嘅即時預覽（`SHIFT_PREVIEW_SAMPLE` 假資料）
- 交班流程嘅預覽（真資料）
- 實際 `PrintJob.content`

### 4.3 打印任務：`buildShiftPrintJobs()`（`src/lib/print-jobs.ts`）

```ts
export function buildShiftPrintJobs(opts: ShiftPrintOpts): PrintJob[] {
  const template = normalizeShiftTemplate(opts.template ?? loadPosLocalSettings().printTemplates.shift);
  const snapshot = buildSnapshot("shift", template);
  const content = buildShiftContent(opts.data, { /* storeName / headerText / footerText / sectionTitles */ });
  return [{ /* ... */ printerGroup: "receipt", items: [], content, template: snapshot, /* ... */ }];
}
```

`shift-page.tsx` 嘅**兩條路徑**都改用佢（`closeShift()` 交班即印 + `reprintShiftRecord()` 歷史重打），
並且 `historyRecord` 寫入 `detail: snapshot`。舊記錄冇完整快照時，`shiftRowToSettlement()`
會由扁平欄位盡量還原（向後兼容）。

### 4.4 跨 repo：**零改動**（已逐個核實）

交班模板嘅 header 靠 **`header` 區塊**（`headerText`）帶出，**唔靠** `PrintTemplateKind` 嘅標題表。
原因：三個 repo 嘅 `TITLE` 表只認 `receipt | label | kitchen`，傳 `"shift"` 會 fall through 去空字串。

| 渲染器 | 位置 | `kind="shift"` 行為 | 需要改？ |
| --- | --- | --- | --- |
| POS web | `src/lib/escpos-render.ts` | `TITLE` 冇 `shift` → 空字串 | ❌ |
| desktop-companion | `companion-server.mjs:443` | `snap.kind === "receipt" ? … : snap.kind === "kitchen" ? … : ""` → `""` | ❌ |
| print hub / relay（APK） | `EscPosRenderer.kt:303` | `when (template.kind) { "receipt"…; "kitchen"…; else -> "" }` → `""` | ❌ |

其他區塊一律行 `content[b.id]` 分支（`EscPosRenderer.kt:399`、`companion-server.mjs:536`），
而 `buildShiftContent()` 產生嘅 key 正好就係 `ShiftSectionId` → 直接對得上。
`divider` / `qr_code` 分支亦唔會被觸發（交班模板冇 `items`、冇 `qr_code`）。

**好處**：商家可以自己改標題文字，而且三個 repo 完全唔使動。

### 4.5 雲端同步（store-level，LWW）

沿用 0027 建立嘅機制，只係多兩個欄：

- **URL**：`/api/pos/print-templates`；GET 進入打印頁即拉、POST 儲存即上傳。
- **Normalize 白名單**：`normalizePosLocalSettings()` 一定要**明確白名單** `shift` / `shiftTemplatePresets` /
  `activeShiftTemplateId`，否則 reload 會被剷走（本 repo 有前科：`receipt.qrUrl`、`standaloneSpecGroups`）。
- **pos-app merge**：`printTemplatesServer` 要帶 `shiftPresets`，並且**必須**有**明確**嘅
  `shiftTemplatePresets` / `activeShiftTemplateId` merge 分支 —— 靠 default 傳播（undefined）會靜靜哋剷走本機範本。

### 4.6 部署順序事故兜底（`isMissingColumnError`）

0030 **未跑**但代碼已部署時，`select shift, shift_presets` 會直接報 Postgres `42703`
（`undefined_column`），**唔兜就會令整條模板同步（連收據 / 標籤 / 廚房模板）一齊壞**。

所以 GET / POST 兩邊都有降級：偵測到 42703 → 只讀 / 寫四個舊欄（`receipt, label, kitchen, kiosk`），
交班模板暫時退回本機預設，其餘槽位照常同步；response 帶 `legacyColumns: true` 做診斷。

> ⚠️ 實作時踩過嘅坑：**唔好**把 select 欄位抽成 `(columns: string) => supabase...select(columns)`
> 呢種包裝 —— 參數寫 `string` 會令 supabase-js 嘅 `select<Query extends string>` 推導唔到欄位名，
> `data` 變成 `GenericStringError`，之後 `data.receipt` 全部報 TS2339。兩個 select 一定要各自 inline。

---

## 5. 驗證與錯誤處理

### 5.1 輸入驗證（`validatePresetName`）

| 規則 | 錯誤訊息 |
| --- | --- |
| 空白 | 請先輸入範本名稱。 |
| > 20 字（`SHIFT_PRESET_NAME_MAX`） | 範本名稱最多 20 個字。 |
| 同名（改名時排除自己） | 已經有同名範本「X」，請改個名。 |
| 範本庫 ≥ 20 個（`SHIFT_PRESET_LIMIT`） | 範本數量已達上限（20 個），請先刪除唔用嘅範本。 |

上限係防 localStorage 塞爆（每個範本都係一整份模板）。

### 5.2 執行期防護

- **套用時範本已唔存在**（另一部機刪咗）→ toast「找不到此範本（可能已被其他裝置刪除），請重新載入頁面。」，唔靜默失敗。
- **原子寫入**：`applyShiftPreset` 初期寫法係 `updateShiftPresets(...)` 之後再 `applyTemplate(...)`。
  兩者都由**同一個 stale `localSettings` closure** 砌新 state → 第二次 `setLocalSettings` 會把第一次**覆蓋走**，
  結果「使用中」標籤永遠唔會更新，而且會 push **兩格**撤銷歷史。已改為**一次過**寫入
  （`activeShiftTemplateId` + `printTemplates.shift` 同一個 `setLocalSettings`）。
- **刪除二次確認**：`window.confirm` 並明文講「目前生效中嘅排版唔會受影響」。
- **不做無效操作**：`.find()` 揾唔到 → 直接 return（唔改 state、唔入歷史）。
- **normalize 保證非空**：`normalizeShiftTemplatePresets()` 出廠至少一套「標準交班單」，
  client 唔需要為「server 傳咗個空陣列」寫額外 fallback；`normalizeShiftTemplate()` 會逐個區塊
  補返出廠預設 + 保留商家已存嘅設定（舊 DB 記錄缺新區塊都唔會被當權威蓋走預設）。

---

## 6. 部署步驟

1. 跑 migration：`supabase/migrations/0030_pos_print_templates_shift.sql`
   （`add column if not exists` ×2，nullable → 舊 row 唔使 backfill）。
2. 部署代碼。
3. 驗收：`/prints` → 「交班模板」分頁 → 改排版 / 新增範本 / 套用 → 撳「儲存模板」→
   另一部機（同 storeId）入 `/prints` 應該見到同一套模板同範本庫。

**跨 repo 唔需要改動**（見 §4.4），亦唔需要同 desktop-companion / print hub 同步發版。

---

## 7. 已知事項 / 待跟進

- **`react-hooks/refs` lint 誤報**：`print-center.tsx` 早有此類 React Compiler 誤報
  （`patchBlock` 等，改動前基線 5 error）。今次新增嘅範本操作函數令同一類誤報增加到 3 個呼叫點。
  屬**誤報**（ref 讀取只發生喺事件處理器內），**唔阻 `next build`**（Next 16 已唔喺 build 時跑 ESLint）。
  要徹底消音會需要把範本面板抽成子組件，屬獨立重構。
- **兩個欄實際上「預覽」同「出紙」都要靠 `content` 快照**：若將來有人只存 `template` 而唔存
  `content`，出紙會空白 —— 所有交班出紙路徑**必須**行 `buildShiftPrintJobs()`。
- **端到端出紙未喺真機驗證**：已靜態核實三個渲染器嘅分支，但未有一張真實紙本佐證。
  建議驗收時分別用 hub APK / desktop-companion 各印一次。
