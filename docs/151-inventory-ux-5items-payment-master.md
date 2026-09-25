# 151 · 庫存五項 UX 優化 ＋ 支付方式主檔（admin 統一設置）

日期：2026-09-25 ｜ 涉及兩個 repo：`macauPosSystem`（POS/商家端）、`expenseRecorder`（admin panel）

---

## 0. 一句話總結

支付方式由「兩個 repo 各自 hardcode」改為 **admin 統一設置 → POS 讀主檔**；
庫存頁嘅供應商／品類收進「設置」；新增收據 modal 改為觸屏；品項支援歷史快選。

**admin panel 就係 expense-recorder（`https://expense-recorder-sigma.vercel.app`，
用 `60000000` / `0000` 登入），所有 admin 功能都寫喺嗰邊，唔會放入 macau-pos。**

---

## 1. 先講清楚三件既有事實（唔講就會做錯）

### 1.1 `merchants.name` 係**全表唯一**

`expenseRecorder/supabase_schema.sql:7`：

```sql
CREATE TABLE merchants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,   -- ← 全域唯一
  ...
);
```

`supabase_schema_v2.sql:41` 另外加咗 `user_id`：

```sql
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES shop_users(id) ON DELETE CASCADE;
```

⇒ **同時存在**「`name` 全域唯一」同「`(user_id, name)` 複合唯一」兩個約束。

**呢個就係 duplicate key 嘅根因**：

* POS `resolveMerchantId()` 用 `upsert(..., { onConflict: "user_id, name" })`；
* upsert 本身搵到 `(user_id,name)` 所以**唔會**報 42P10；
* 但**新行**插入時仍然會撞 `merchants_name_key` ⇒ `23505 duplicate key`；
* ⇒ **兩間店唔可以各自有同名供應商**（例如兩間都叫「大興行」）。

**J 決定：保持全表唯一**（唔改 DB）。所以 POS 端做嘅係「優雅提示」而唔係「拆約束」：

| 情況 | API 回應 | UI 行為 |
|---|---|---|
| 本店已有同名 | `409 { code: "ALREADY_EXISTS", merchant: {id,name} }` | 自動選用該供應商 + 綠字提示「已經存在，已自動選用」 |
| 其他店已用同名 | `409 { code: "NAME_TAKEN" }`（**唔回 id**） | 琥珀色提示「與資料庫既有供應商衝突」 |

🔴 `NAME_TAKEN` **唔可以**回傳嗰個 id —— 否則本店會掛起第二間店嘅供應商（跨店資料污染）。
呢點有守衛測試。

**要根治**（如果日後想兩店同名）就要喺 expenseRecorder 跑：

```sql
ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS merchants_user_id_name_key ON merchants (user_id, name);
-- 可回滾：DROP INDEX merchants_user_id_name_key; ALTER TABLE merchants ADD CONSTRAINT merchants_name_key UNIQUE (name);
```

🔴 依 J 2026-09-25 決定**保持全表唯一**，所以上面 SQL **冇執行、亦冇寫成檔案**，
純粹記錄「日後要改嘅話改乜」。保持唯一嘅副作用係：跨店同名供應商建立唔到，
商家會見到「與資料庫既有供應商衝突（merchants_name_key）」嘅明確提示。

### 1.2 expenseRecorder 將「設定」偷藏喺 `merchants` 表（保留名 KV）

`expenseRecorder/lib/account-settings.ts`：

| 保留名 | 內容 |
|---|---|
| `__shop_settings__:<userId>` | 門店設定（自訂單位、賬戶狀態），放 `address` 欄 |
| `__global_settings__` | **全域設定**（單位清單 ＋ 今次新增嘅支付方式主檔） |
| `__preset_json__:` / `__settings_json__:` / `__global_units__:` | `address` 欄嘅 payload 前綴 |

⇒ 任何「唔加 user_id 篩選／唔過濾」嘅供應商查詢都會**漏出假供應商**。
POS 側已加 `isReservedMerchantName()`（規則：真實供應商名唔會 `__` 開頭）。

⚠️ 刻意喺 JS 過濾而**唔用** PostgREST `.not("name","like","__%")`：
SQL `LIKE` 嘅 `_` 係單字元通配符，`__%` 實際會 match 幾乎所有名 ⇒ **會濾走全部供應商**。

### 1.3 `normalizePosLocalSettings()` 係**逐欄重建**（著名陷阱）

`src/lib/storage.ts`。新欄位唔加白名單 = reload / 雲端同步時**被靜靜剷走**。
歷史受害者：`receipt.qrUrl`、`receipt.returnPolicyText`、`label.paperSize`、
`standaloneSpecGroups`、`shiftTemplatePresets`。
今次新增 `invCategories` **已同時**加落：`types.ts`、`mock-data.ts`、`storage.ts`（有守衛測試）。

---

## 2. 支付方式主檔（需求 1）

### 2.1 設計

```
admin（expenseRecorder /admin/payment-methods）
   │  寫入 merchants["__global_settings__"].address
   │  payload = { units?, paymentMethods: [{code,label,enabled,scope}] }
   ▼
POS  GET /api/inventory/payment-methods   ←  service_role 讀同一條列
   │  scope="purchase"  → 新增收據（進貨）
   │  scope="checkout"  → 收銀台結帳（由商家喺設備設置自己剔）
   ▼
讀唔到就 fallback 內建 DEFAULT_PAYMENT_METHODS（唔會令庫存頁爆掉）
```

`scope` 三值：`both`（現金／信用卡）、`purchase`（月結／銀行轉賬／支票）、`checkout`（轉數快）。

### 2.2 為何用保留列而唔開新表

零 SQL／零 migration、即時生效，而且**跟足 expenseRecorder 既有慣例**（全域單位就係咁樣存）。
代價係 `address` 變成一個雜 payload，所以**寫入一定要 merge**（見下）。

### 2.3 🔴 真實陷阱：`payload` 一定要 merge，唔可以整份覆蓋

舊寫法：

```ts
// ❌ 舊：整份覆蓋
await supabase.from("merchants").upsert({
  user_id, name: GLOBAL_SETTINGS_MERCHANT_NAME,
  address: encodePayload(GLOBAL_UNITS_PREFIX, { units: normalized }),
}, { onConflict: "user_id,name" });
```

加多一個 `paymentMethods` key 之後，**任何一邊儲存都會將另一邊靜靜蓋走**
⇒ admin 改完支付方式，全域單位清單就會無聲 reset。

正解：全部寫入經 `patchGlobalSettings()`（先讀返現有 payload，再併入 patch）。
另外舊前綴 `__global_units__:` 亦要**仍然讀得到**（否則現有單位清單一夜跌返預設）。

### 2.4 「未設定」vs「設定成空清單」

兩邊（admin 儲存層 + POS 讀取層）都用 **`Array.isArray`** 判別：

```ts
if (!Array.isArray(raw)) return DEFAULT_PAYMENT_METHODS;  // 從未設定 → 預設
// raw 係陣列（即使係 []) → 照用，唔補預設
```

冇呢個區分，admin 就**永遠清唔空**個主檔。有守衛測試。

### 2.5 新增檔案／改動

**expenseRecorder**

| 檔案 | 改動 |
|---|---|
| `lib/account-settings.ts` | 加 `PaymentMethodScope` / `PaymentMethodDef` / `getDefaultGlobalPaymentMethods()` / `normalizePaymentMethods()` / `paymentMethodsForScope()`；`readGlobalSettings()` + `patchGlobalSettings()`（merge-safe）；`loadGlobalPaymentMethods()` / `saveGlobalPaymentMethods()`；`isReservedMerchantName()` 補 `__global_settings__` |
| `app/admin/payment-methods/page.tsx` | **新增** admin CRUD 頁（顯示名／代碼／範圍／啟用／↑↓排序／刪除／還原預設／儲存）＋ POS 兩邊介面即時預覽 |
| `components/Navigation.tsx` | admin 導覽加「支付方式」（圖示刻意重用 `Wallet`，避免 lucide 版本對唔上時整個導覽爆掉） |
| `app/admin/page.tsx` | 加「支付方式主檔 →」快捷連結 |

**macauPosSystem**

| 檔案 | 改動 |
|---|---|
| `src/app/api/inventory/payment-methods/route.ts` | **新增** 唯讀 GET：讀主檔，讀唔到回內建預設 + `warning` |
| `src/lib/inventory-stats.ts` | 加 `PaymentMethodDef` / `DEFAULT_PAYMENT_METHODS` / `normalizePaymentMethods()` / `paymentMethodsForScope()` / `paymentMethodLabelMap()` |

`paymentMethodLabelMap()` 保留內建標籤做兜底：admin 改走／停用某個 code 之後，
**舊收據照樣存住嗰個 code**，冇兜底就會顯示裸英文 key（同一類「月結顯示唔到」問題）。

---

## 3. 需求 2：新增收據 modal 觸屏重做

| 欄位 | 舊 | 新 |
|---|---|---|
| 付款方式 | `<select>` + `<option>` | **chip**（由主檔 `scope=purchase` 驅動） |
| 付款狀態 | `<select>` | **chip**（未付款／已付款） |
| 品類 | 自由文字 input | **chip** 選清單（∪ 現有值）＋「其他（手動輸入）」出口 |
| 供應商 | `<select>` + 手動輸入 | `<select>` ＋ **「＋ 新增」即時建立** |

* `chipCls()`：`px-4 py-3 text-base`（≥ 44px 高，唔用 `text-xs` 做撳制文字）。
* 舊單據嘅付款方式若唔喺主檔（被停用／改走），喺 chip 下面**明文顯示**
  「原本係『X』（已停用）」⇒ 唔會一儲存就被靜靜改走。

---

## 4. 需求 3：品項歷史快選

新增 `GET /api/inventory/receipt-items?account=`：

* 按 `receipt_items.user_id` 收窄、`order("created_at", desc)`、`limit(400)`；
* **一次** query，之後打字係**本機過濾**（唔會每按一個字就打 server）；
* 上限 80 個建議，同名只保留最近一次嘅單價／日期。

為何要另開 route：`/api/inventory/receipts` 只回**當前 range**（預設 today），
用嗰批做「歷史品項」會出現「今日冇落單 ⇒ 建議清單空」。

**🔴 觸屏關鍵：建議一定要用 `onPointerDown` + `preventDefault()`，唔可以用 `onClick`。**

撳落去嗰一刻 input 會先 `blur`，而 `onBlur` 會收埋建議清單 ⇒ `onClick` **永遠唔會觸發**
（＝「建議撳唔到」）。有守衛測試。

自動填價**只喺單價空白時**才填，唔會蓋走用戶已改嘅價錢。

---

## 5. 需求 4／5：供應商 ＋ 品類收進「庫存・設置」

新增 `src/components/inventory/inventory-settings-panel.tsx`：

* 兩個 tab：**供應商（n）／ 品類（n）**，觸屏用大按鈕切換，唔用下拉；
* 供應商：新增／改名（inline）／刪除 —— **刪除係兩步確認**（觸屏誤觸成本高）；
* 品類：新增／改名／刪除，存 `PosLocalSettings.invCategories`（門店層設定）；
* 提示搬入面板內（唔再放喺頁面最頂 —— 供應商區喺頁面下半部，放頂等於冇提示）。

主頁（`inventory-view.tsx`）改動：

* 移除成個「供應商（新增 / 修改 / 刪除）」section（呢個正是原本把日常用嘅收據清單推到下面嘅原因）；
* header 加「設置」掣；
* 供應商 API 嘅 PATCH／DELETE 呼叫**完全離開主頁**（有守衛測試用 URL 路徑判別，
  唔可以用 `method: "DELETE"` 判別 —— 主頁自己刪「收據」都係 DELETE）。

⚠️ 品類改名／刪除**唔會追溯**舊收據（品類係存在 `raw_ocr_data.category` 嘅快照），
所以刪除確認文案同成功訊息都有明確講明。

---

## 6. 一併修掉嘅既有問題

1. **假供應商外洩**：`GET /api/inventory/merchants` 以前冇過濾保留名，
   `__shop_settings__:<uuid>` 會變成下拉一項。
2. **保留名入口未擋**：用戶可以打 `__global_settings__` 做供應商名 →
   錯誤訊息會變成一句莫名奇妙嘅 unique 衝突。而家 400 明確擋。
3. **`42P01` 以外嘅 schema 未就緒冇降級**：加 `isMissingColumnOrTable()`（`42P01` + `42703`），
   因為 expenseRecorder 係另一個部署節奏，唔可以假設欄位齊
   （實例：`receipt_items.user_id` **唔喺任何一支現存 SQL 檔**，係人手 ALTER 加嘅）。
4. **付款方式分佈圖**：改為用 `labelMap`（主檔優先）而唔係淨係 server 回嘅 label。

---

## 7. 驗證

| 項目 | 結果 |
|---|---|
| POS `tsc --noEmit` | 0 error |
| expenseRecorder `tsc --noEmit` | 我改動嘅檔案 0 error（其餘為專案原有 `TS7016` module-resolution 噪音） |
| POS `node --test` | **1618 pass / 0 fail**（其中庫存守衛 38 條） |
| 跨 repo 對齊測試 | `payment-method-defaults-parity.test.ts` — 兩邊預設逐字一致 ✔ |
| POS eslint（改動檔） | 0 error |
| POS `next build` | 見下 |
| expenseRecorder `next build` | 見下 |

### 過程中真實捉到嘅一個 bug

`ReceiptFormModal` 有 `if (!open) return null` early return，而我把 `categoryOptions`
寫成 `useMemo` **放喺 early return 之後** ⇒ `react-hooks/rules-of-hooks` error。
改為純 IIFE 計算（品類得幾個，根本唔需要 memo）。

---

## 8. 未做／待跟進

1. **未 commit / 未 push**（兩個 repo 都係）。
2. **`__global_settings__` 內容要向後兼容**：第一次儲存會由 `__global_units__:` 前綴
   遷移到 `__global_settings__:`；舊前綴仍可讀。
3. **商家端「結帳顯示邊幾款」**：`PosLocalSettings.paymentMethods` 已有編輯器
   （設備設置），今次**未**改為「從 admin 主檔挑選」。目前係：主檔派發 `checkout` scope
   嘅清單，商家嘅本地清單仍然獨立生效。若要完全收口，需另開一次改動。
4. **`consent` 類未處理**：`resolveMerchantId()` 收到 `merchant_id` 時**直接採用、唔驗證
   ownership** ⇒ 理論上可以將收據掛去另一間店嘅 `merchant_id`。屬既有 scoping 缺口，
   建議下次收口（加 `.eq("user_id", userId)` 覆核）。
5. **`receipt_items.user_id` 唔喺任何 SQL 檔**：建議喺 expenseRecorder 補一支 migration
   記錄呢一欄，否則新環境重建 DB 會缺欄。
