# 後廚屏 / 出餐台屏（KDS）方案 · docs/116

> 目標：iPad 一部掛後廚、一部擺出餐台，**同一個登入入口**揀「後廚屏」／「出餐台屏」，
> 屏上睇單、點掉單品、確認出餐，**唔經打印機**。
> 狀態：**方案（未實作）**。實作前請先睇 §9 風險，尤其 R1 / R2 / R5。

---

## 0. 已拍板嘅決定（2026-09-11，用戶確認）

| # | 問題 | **決定** | 對方案嘅影響 |
|---|---|---|---|
| 1 | 屏係替代打印定並存 | **並存**（`both`） | 廚房單照印，屏同步顯示。`kitchen` print toggle **保持開啟**，唔郁現有出紙行為。試行期風險最低。 |
| 2 | 工位點劃分 | **用菜單嘅 `printerGroup`** | 唔另設「後廚屏工位」概念。實際值：`kitchen` / `drinks`（`receipt` 係收銀機、`label` 係標籤，**唔做為工位**）。顯示名要一層 fallback map（`{kitchen:"廚房", drinks:"水吧"}`）＋ 有配打印機就用打印機 `name`。 |
| 3 | 出號（叫號）屏 | **暫時唔做** | `POST /api/pos/kds/orders` 只做 `ready` / `recall`，唔需要 `call` 相關欄位。P2 再議。 |
| 4 | 後廚屏帳號 | **同 kiosk 一致** | 用店長／經理嘅 8 位電話帳號登入一次 → 寫 `KdsDeviceBinding` → 之後開機直接入後廚。**唔**為廚房師傅另開 PIN（唔改 Ledger 帳號體系）。 |

⚠️ 決定 2 有一個連帶項：`printerGroup` 係**自由字串**（`type PrinterGroup = string`），
所以「工位清單」唔可以寫死。要由 `bootstrap.printerGroups` 動態產生，
並**剔走 `receipt`**（收銀機唔係工位）。

決定 3 有一個連帶項：出餐台屏確認出餐後**唔會**有任何叫號行為，
所以「客人點知可以攞？」要靠現有嘅收銀台／客人端狀態（`fulfillmentStatus = "ready"` →
`customerOrderStatusLabel()` 已經會顯示「可取餐」）。**零改動就可以運作**。

---

## 1. 結論：可行，而且地基比想像中好

呢個功能唔使由零起。專案已經有幾件關鍵零件，啱啱好可以複用：

| 已在專案裡 | 位置 | KDS 點用 |
|---|---|---|
| 訂單級出餐狀態 | `PosOrder.fulfillmentStatus: "preparing" \| "ready"` | 出餐台屏「確認出餐」直接寫 `ready` |
| 送廚房 / 出餐時間戳 | `PosOrder.sentToKitchenAt` / `servedAt` | 計時器、平均製作時間統計 |
| **菜品分區真源** | `OrderItem.printerGroup` | KDS 工位（炸區／煎區／飲料）直接複用，**零新增設定** |
| 菜品身分口徑 | `orderItemKey()`（`lib/pos/order-item-diff.ts`） | 單品級完成標記嘅 key，**必須** import，唔可以自己砌 |
| 店級 Realtime 渠道 | `usePosRealtime(storeId, …)` | 後廚屏即時見新單，唔用 polling |
| 設備綁店模式 | `saveKioskDeviceBinding()` / `loadKioskDeviceBinding()` | 後廚屏「登入一次、之後開機即入」照抄 |
| 終端憑證 + 自動續期 | `posDeviceAuthHeadersFresh()` | 後廚屏寫入授權 |
| 新單提示音 | `public/sounds/new-order.mp3` | 後廚屏「叮」 |
| 已有帳號體系 | LoginMode 4 種 + Ledger 8 位電話 / 4 位 PIN | 加兩個模式就得 |

**真正缺嘅只有一樣：單品級（一碟一碟）嘅完成狀態。** 現時只有「整張單」嘅狀態。

---

## 2. 你要先確認嘅三件事（**已於 §0 拍板，以下保留為決策依據**）

| # | 問題 | 為何重要 |
|---|---|---|
| **Q1** | 屏係**替代**打印，定係**並存**？ | 決定風險等級。見 §8。**建議先做「並存」**，屏壞咗廚房照跑。 |
| **Q2** | 一部後廚屏只服務**一個工位**，定係全廚房一張單一覽？ | 決定資料模型要唔要 `station` 維度。見 §5。**建議：先做「全部」單工位，P1 再加多工位。** |
| **Q3** | 出餐台屏係按**取餐號**（快餐）定**枱號**（堂食）排？ | 兩者排序、叫號邏輯唔同。 |

呢三個唔答都可以照做，我下面按「建議」嘅口徑寫。

---

## 3. 核心設計決定（最重要嘅一節）

### 3.1 單品狀態放**雲端**，唔放本機

收銀台係 local-first：訂單喺 `localStorage`，經 outbox 推上雲。
但**後廚屏係另一部機**，佢冇、亦唔應該有訂單嘅本機副本。

所以：

> **後廚屏係「雲端直連讀寫裝置」，唔行 outbox。**

- 讀：一次性 REST 拉 `pos_orders` + Realtime 訂閱增量 + 60 秒心跳對賬
- 寫：直接打專用端點（§6），由 server 寫入 DB

⚠️ **唔可以**叫後廚屏走 `/api/pos/sync`。因為 outbox 嘅語意係「推本機已有嘅事」，
而後廚屏根本冇本機單 —— 強行入隊會產生「半張單」事件，污染收銀台嘅同步隊列。
呢個係整個方案最容易踩錯嘅一步。

### 3.2 單品完成用「**已出份數**」，唔用「打勾」

表唔存 `done: true/false`，而係存 `done_qty`（整數）。

| 情境 | 用 `done: true` 會點 | 用 `done_qty` 會點 |
|---|---|---|
| 叉燒飯 x1，標記完成 | done=true | done_qty=1 |
| 客人**加單**變 x3 | done **仍然 true** → **新加 2 碟永遠唔會出現喺屏上 → 靜默漏單** 🔴 | done_qty=1 < 3 → 自動變返「未完成，仲欠 2」✔ |

專案本身已經有「加單補出廚房單」嘅機制（`diffAddedItems()`），
但**跳過廚房單去印**係一件事，**屏上要重新亮起**係另一件事 —— 後者一定要 `done_qty` 先做得到。

「完成」嘅判定 = `done_qty >= item.quantity`。退菜（`item.voided`）嘅行唔顯示。

### 3.3 後廚屏唔可以係「出餐唯一記錄」（除非接受風險）

如果行 §8 嘅 `screen` 模式（唔印廚房單），**後廚屏就係唯一證據**。
咁樣一離線就要**唯讀 + 大聲報警**，絕對唔可以「假成功」：

> ⚠️ 離線時撳「完成」如果只在屏上變灰、冇落到雲端 = 廚房做咗、系統唔知 = 最難 debug 嘅靜默不一致。
> 專案已有明確口徑（`/api/pos/sync` 失敗分類）：**業務拒絕 → 4xx 唔重試；基建失敗 → 5xx 可重試**。
> KDS 要沿用同一精神：**屏上要見到「未上雲」狀態，唔可以扮成功。**

---

## 4. 登入入口（同一入口，加兩個模式）

### 4.1 現狀 → 目標

`LoginMode`（`lib/pos/scan-mode-from-login.ts`）由 4 個擴到 6 個：

| 登入模式 | 導向 | 店級 `scan_mode` | 設備綁定 |
|---|---|---|---|
| `quick`（快餐） | `/` | `quick` | — |
| `dinein`（堂食） | `/` | `dine_in` | — |
| `salon`（美容） | `/salon` | **唔改** | — |
| `kiosk`（自助點餐機） | `/order` | **唔改** | `KioskDeviceBinding` |
| **`kitchen`（後廚屏）** | **`/kitchen`** | **唔改** | **`KdsDeviceBinding{role:"kitchen"}`** |
| **`expo`（出餐台屏）** | **`/expo`** | **唔改** | **`KdsDeviceBinding{role:"expo"}`** |

🔴 **`kitchen` / `expo` 必須令 `scanModeForLoginMode()` 回 `null`**，同 kiosk / salon 一樣。
理由同 docs/115 §12 完全一致：後廚屏係「一部機開機做乜」，唔係「全店客人點樣落單」。
如果後廚屏登入都寫 `quick`，就會同收銀台嘅堂食登入互相覆蓋 → 設定頁顯示嘅 QR 每次登入都唔同。

### 4.2 登入一次、之後開機即入

照抄 kiosk 嘅設備綁定模式：

```ts
// lib/kds/device-binding.ts（新）
type KdsDeviceBinding = {
  storeId: string;
  storeName: string;
  role: "kitchen" | "expo";
  station?: string;      // 後廚屏專屬：綁定呢部機服務邊個工位
  boundAt: string;
};
```

- 登入成功 → 寫綁定（**必帶 `isPlaceholderStoreId()` 硬閘**，唔可以寫示範店代碼）
- 重開機 / reload → 有綁定就直接入 KDS，唔再出登入畫面
- 換店 / 換工位 → 屏右上角「設定」→「重新綁定」（清綁定 + 回登入畫面）

### 4.3 權限

| 角色 | 可以登入後廚屏 | 可以綁定設備 |
|---|---|---|
| `admin` / `manager` | ✔ | ✔ |
| `cashier` | ✔（單次開屏） | ✘ |

理由：綁定 = 呢部 iPad 以後自動入後廚模式。如果任何收銀員都可以綁，
就會出現「收銀台被人綁成後廚屏」——同 kiosk 一樣嘅設備劫持問題。

---

## 5. 資料模型

### 5.1 新增 1 張表（migration `0033_pos_kds.sql`）

```sql
CREATE TABLE IF NOT EXISTS pos_kds_item_state (
  store_id   text        NOT NULL,
  order_id   text        NOT NULL,
  -- ⚠️ 必須同 orderItemKey() 同口徑：`${menuItemId}|${specs}|${price}|${note}`
  item_key   text        NOT NULL,
  -- 工位來自 OrderItem.printerGroup（複用，唔另設一套）
  station    text        NOT NULL DEFAULT '',
  done_qty   integer     NOT NULL DEFAULT 0,
  cooking_at timestamptz,
  done_at    timestamptz,
  done_by    text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, order_id, item_key)
);

CREATE INDEX IF NOT EXISTS pos_kds_item_state_board_idx
  ON pos_kds_item_state (store_id, station, updated_at DESC);
```

**設計說明**

- PK `(store_id, order_id, item_key)` → 同一個單品重複撳 = `upsert`，天然冪等。
- 唔存 `order` 快照、唔存菜名單價 → **唔係第二個訂單真源**，只係貼喺訂單旁邊嘅便條。
  讀屏時 join 雲端 `pos_orders` 拎菜名。
- `station` 冗餘存一份（唔靠 join 推），係為咗 Realtime 按 station 過濾時唔使回查。
- 冇 `void` 狀態：退菜睇 `pos_orders.items[].voided`，唔喺呢張表重複記。

### 5.2 表**唔需要**加嘅欄（重要）

| 諗過要加 | 實際做法 | 原因 |
|---|---|---|
| `pos_orders.kds_status` | 唔加 | 已有 `fulfillmentStatus`，再加一個就會有**兩個真源**打架 |
| `pos_orders.ready_at` | 唔加 | 已有 `servedAt` |
| 單品狀態塞入 `pos_orders.items` JSONB | 唔塞 | JSONB 逐行更新要整行覆寫 → 後廚屏同收銀台**互相覆蓋對方改動**（lost update） |

🔴 第三行係關鍵：如果單品完成狀態放入 `pos_orders.items`，
收銀台加單（整張 order 覆寫）會冧走後廚屏嘅完成標記；反過來都一樣。
**開獨立表 = 兩個寫入者寫唔同嘅行，天然冇衝突。** 呢個係本方案最重要嘅結構決定。

### 5.3 RLS 與 Realtime

照 `0019_pos_online_order_settings.sql` 嘅既有模式：

- `ENABLE ROW LEVEL SECURITY`
- `anon` → **只 SELECT**（Realtime 以 anon role 跑 RLS，唔留就訂閱唔到）
- `service_role` → `ALL`
- `REVOKE ALL ON ... FROM anon, authenticated` → `GRANT SELECT TO anon`
- 加 `supabase_realtime` publication（用 `pg_publication_tables` 判斷，idempotent）

⚠️ 呢張表冇 PII（只有 key / 工位 / 份數 / 帳號），所以 `anon SELECT USING (true)`
同 `pos_soldout` 嘅處理一致。**但 `done_by` 係帳號，屬輕度可識別** → 建議
`anon` 用 `USING (true)` 但**唔**將 `done_by` 塞入前端可見範圍（靠 server 端點遮掉）。

---

## 6. API（3 條新端點，全部要終端憑證）

```
GET   /api/pos/kds/board?storeId=&station=
POST  /api/pos/kds/items      { storeId, orderId, itemKey, station, doneQty, by }
POST  /api/pos/kds/orders     { storeId, orderId, action: "ready" | "recall" }
```

### 6.1 授權

同 `/api/pos/kiosk-settings` POST 一致：

- 收 `Authorization: Bearer <posDeviceToken>`
- 驗 `token.merchantId === body.storeId` → 唔一致就 **403**（跨店隔離）
- 客戶端一律用 `await posDeviceAuthHeadersFresh()`（會自動續期）

> ⚠️ 見到「未經授權：需要 POS 終端憑證。」唔係權限問題，係 token 冇帶／冇續期。
> 呢個係專案常見誤判（見 docs/113）。

### 6.2 `GET /api/pos/kds/board`

一次過回屏上要嘅一切，避免屏自己 join：

```jsonc
{
  "ok": true,
  "serverTime": "2026-09-11T06:05:00.000Z",   // 計時器基準，唔可以用 iPad 本機時間
  "orders": [
    {
      "id": "ord-…", "localOrderNo": "A012", "tableId": "counter", "tableName": "自取",
      "source": "kiosk",
      "status": "sent_to_kitchen", "fulfillmentStatus": "preparing",
      "sentToKitchenAt": "…", "createdAt": "…",
      "items": [
        { "itemKey": "…", "name": "叉燒飯", "quantity": 3, "station": "hot",
          "note": "少飯", "specs": ["大"], "doneQty": 1, "voided": false }
      ]
    }
  ]
}
```

**要點**

- ⚠️ 現有 `/api/pos/orders` **冇回** `fulfillmentStatus` / `sentToKitchenAt` / `source`，
  所以唔可以照用，一定要另開 board 端點（或者補欄，但補欄會影響其他 caller）。
- **`serverTime` 必須由 server 回**：iPad 時鐘可能飄，計時器用本機時間會出現「-3 分鐘」或者整批超時誤報。
- 只回**未結帳**（`status IN ('draft','sent_to_kitchen','paid')`）＋ `updated_at > now() - 12h`。

### 6.3 `POST /api/pos/kds/items`

```jsonc
{ "storeId": "…", "orderId": "…", "itemKey": "…", "station": "hot", "doneQty": 3 }
```

- server 端**必須**重新由 `pos_orders` 讀出該 order，並用 `orderItemKey()` **驗證 `itemKey` 真係存在**。
  唔存在 → 400 `{ ok:false, code:"item_not_found" }`（唔可以盲寫，否則會積累垃圾行）。
- `doneQty` clamp 到 `[0, quantity]`。
- 寫 `pos_kds_item_state` + 返回整張 order 嘅新進度（畀屏即時更新，唔使等 realtime 回來）。
- **絕對唔可以**喺呢條路寫 `pos_orders` 嘅任何欄位。

### 6.4 `POST /api/pos/kds/orders`

| action | 做乜 | 前置條件 |
|---|---|---|
| `ready` | `pos_orders.fulfillment_status = 'ready'`，`served_at = now()` | 全部非退菜單品 `done_qty >= quantity`，否則 **409** 並回「仲欠」清單 |
| `recall` | 清走該單全部 `pos_kds_item_state`（`done_qty = 0`），`fulfillment_status` 回 `preparing` | 允許隨時（客人退單／出錯） |

⚠️ **`ready` 一定要有前置檢查**。冇嘅話出餐台可以「未齊就出餐」→ 客人返嚟話少咗一碟，
而系統顯示「已出餐」——查都查唔到。409 要帶返欠邊幾項，屏上直接高亮。

`recall` 唔改 `pos_orders.status`（唔碰結帳狀態機），亦**唔可以**叫 `update_order_status`。

---

## 7. 介面規格

（可互動原型：`docs/117-kds-mockup.html`，直接開嚟睇）

### 7.1 後廚屏 `/kitchen`（橫向 iPad 1024×768 起）

```
┌──────────────────────────────────────────────────────────────┐
│ 澳門茶餐廳 · 後廚      工位[全部▾]   ⬤ 已連線   未完成 7     │ ← 頂欄 56px
├──────────────────────────────────────────────────────────────┤
│ ┌────────────────┐ ┌────────────────┐                        │
│ │ 自取 A012  02:14│ │ 枱 5     00:41 │                       │
│ │ ───────────────│ │ ────────────── │                       │
│ │ 叉燒飯 x3       │ │ 乾炒牛河 x1    │                       │
│ │  · 少飯         │ │                │                       │
│ │   [1/3] ✓      │ │   [0/1]  ✓     │                       │
│ │ 凍檸茶 x2       │ │                │                       │
│ │   [2/2] 已完成  │ │                │                       │
│ └────────────────┘ └────────────────┘                        │
│  ↑ 卡頭：取餐號/枱號 + 計時器    ↑ 卡身只顯示本站工位嘅行      │
└──────────────────────────────────────────────────────────────┘
```

**規格**

- 卡片**兩欄瀑布流**（唔係表格）。一屏至少見 6 張卡。
- 卡頭左：取餐號（快餐）或枱號（堂食）；卡頭右：**計時器**，由 `sentToKitchenAt` 起算。
- 計時器顏色：`< 3min` 灰 · `3–8min` 橙 · `> 8min` 紅 + 慢脈動。
  閾值**每店可配**（快餐同酒樓差好遠）。
- 菜品行：字號 ≥ 22px、行高 ≥ 56px（**手指唔係滑鼠**）。
- 行右邊一個大「✓」= `doneQty + 1`。行完成 → 灰 + 刪除線，但仍留喺原位（唔好即刻消失，
  否則廚房會懷疑「我係咪撳錯咗」）。
- 卡片全部行完成 → 卡片轉半透明綠色，**留在原位 8 秒**再滑走；期間可撤銷。
- **長按卡片 = 全部完成**（繁忙時段一撳搞掂整單）。
- **長按單品行 = 撤銷**（`doneQty - 1`），防手誤。
- 每次撳完，該行下方出 **2 秒 undo 條**：「已標記完成 · 撤銷」。
- 頂部 toast：新單 → 「枱 5 新單（3 項）」+ 播 `new-order.mp3`；
  加單 → 「枱 5 加單 2 項」+ 卡片整體閃一次邊框。
- 離線 → 頂欄燈變紅 + 大字橫幅「**網絡斷線 · 唔可以確認出餐**」，
  所有 ✓ 掣 disabled（見 §3.3）。

### 7.2 出餐台屏 `/expo`（橫向 iPad）

```
┌──────────────────────────────────────────────────────────────┐
│ 澳門茶餐廳 · 出餐台         [搜尋取餐號/枱號]   已出餐 12     │
├─────────────┬──────────────────────────────┬────────────────┤
│ 待出餐 (7)  │  自取 A012          02:14    │      A012       │
│ ───────────│  ──────────────────────────  │   ┌────────┐    │
│ A012  02:14 │  ✓ 叉燒飯 x3      完成       │   │ 確認    │    │
│ 枱5   00:41 │  ✓ 凍檸茶 x2      完成       │   │ 出餐    │    │
│ A009  04:02 │  ! 例湯 x1      仲欠 1 ← 紅  │   └────────┘    │
│ …           │  ──────────────────────────  │    ↺ 召回       │
│             │  備註：少飯                   │                │
└─────────────┴──────────────────────────────┴────────────────┘
   左：隊列      中：整單核對（唔分工位）        右：大字號 + 大掣
```

**規格**

- 左欄隊列排序：**最早落單排前**（可按枱號／取餐號切換排序）。
- 中欄係**整單**全部菜品（**唔**按工位過濾）——出餐台嘅職責就係核對「齊唔齊」。
- 未完成行用紅色 + 「仲欠 X」；已撤銷／退菜行刪除線。
- 右欄「確認出餐」大掣（≥ 320×120）：
  - 唔齊 → 掣 disabled + 顯示「仲欠 1 項」
  - 齊 → 撳落去 → 寫 `ready` + `servedAt` → 卡片滑去「已出餐」
- 「召回」＝ `recall`，將整單打返後廚屏（客人話漏咗一碟時用）。
- 出餐後（快餐）推去叫號屏 —— 叫號屏可以係同一頁右半嘅大字模式，或者獨立 `/call`。

### 7.3 堂食 vs 快餐嘅差異（硬性口徑）

| | 快餐 / 自取 | 堂食 |
|---|---|---|
| 卡頭顯示 | 取餐號 `A012` | 枱號 `枱 5` |
| 「確認出餐」語意 | 已交付客人 → `servedAt` | 已送出廚房 → `servedAt` |
| `status` 會唔會變 | 唔變（`markQuickOrderCompletedInStore` 由收銀台結帳時做） | 唔變（結帳才 `settled`） |
| 收尾 | 交收銀台「完成」 | 交收銀台結帳 |

⚠️ 出餐台屏**唔可以**順手幫訂單結帳。結帳係收銀台嘅事，涉及會員扣款／Ledger RPC／
返結——屏上一個手勢做埋會令「錢」同「菜」嘅責任邊界消失。呢個係刻意嘅設計限制。

---

## 8. 同打印並存（店級 3 種模式）

設定頁 → 廚房出單，加一個三選一（per-store，沿用 `pos_kiosk_settings` 模式）：

| 模式 | 廚房單打印 | 後廚屏 | 適用 |
|---|---|---|---|
| `print`（預設，即現狀） | ✔ | ✘ | 未裝屏嘅店 |
| `both` | ✔ | ✔ | **過渡期／試點——建議由此開始** |
| `screen` | ✘ | ✔ | 已穩定嘅店（**唯一記錄風險**，見 §3.3） |

實作提醒：

- 中央 `kitchen: boolean` toggle 已存在（`lib/print-toggles.ts`）→ `screen` 模式就係將它閂掉。
- `addon`（加單）票種喺 `both` 模式下**照印**，屏同步亮起。
- ⚠️ 呢個設定如果加入 settings 物件，**必須**加入 `normalizePosLocalSettings()` 嘅白名單，
  否則會被靜默剷走（專案已中過 `qrUrl` / `paperSize` / `shiftPresets`，見 docs/113）。

---

## 9. 風險與專案既有坑

| # | 風險 | 嚴重度 | 對策 |
|---|---|---|---|
| **R1** | **Realtime 訂得唔存在嘅表唔會報錯**（POS 表喺 POS 專案，瀏覽器卻訂 Ledger 專案 → 照顯示 `SUBSCRIBED` 但永遠冇推送 → 屏「reload 先見到新單」） | 🔴 致命 | 必須配置 `NEXT_PUBLIC_POS_SUPABASE_URL` / `_ANON_KEY` 並 **redeploy**；用 `tools/2026-09-11-check-pos-realtime.mjs --watch 20` 一次性探測 `pos_orders` 驗證（**唔可以**靠 channel status） |
| **R2** | iPad 分頁**唔會自動換 JS** → 屏開足一個月都係舊版 | 🔴 高 | ①屏每日凌晨閒時自動 `location.reload()`；②加版本心跳（`/api/pos/version` 對比 build id，唔同就提示 reload）；③出事第一步叫店員**強制 reload** |
| **R3** | iPad Safari 背景節流 → realtime 斷 | 🟠 中 | `usePosRealtime` 已有 `visibilitychange` 重訂；仍要加 **60 秒心跳 REST 對賬**（重訂後補拉） |
| **R4** | iPad 自動休眠／屏幕燒印 | 🟠 中 | Wake Lock API + 引導使用 iPad **引導式存取**（Guided Access）鎖死單一 App |
| **R5** | `screen` 模式下離線假成功 | 🔴 高 | 離線時**唯讀**：✓ 掣 disabled + 大字橫幅。**唔可以**做「本地暫存稍後補推」——時間戳會錯，而且補推邏輯容易變成假成功 |
| **R6** | `item_key` 口徑分歧 | 🔴 高 | 一律 import `orderItemKey()`；加測試鎖死（同 `order-item-diff.test.ts` 同一組 fixture） |
| **R7** | 加單後舊完成標記誤套 | 🔴 高 | 已經由 `done_qty` 設計解決（§3.2）——**唔可以**改回 boolean |
| **R8** | 跨店污染 | 🔴 高 | 每條端點驗 `token.merchantId === body.storeId`；讀取 strict `store_id = storeId` |
| **R9** | 售罄聯動缺失 | 🟡 低 | P2 再加（屏上撳售罄 → 寫 `pos_soldout`） |
| **R10** | `ORDER_UPDATED` payload 格式 | 🟡 低 | KDS 唔行 outbox 就唔會撞；若將來要，必須送 `{ order, addedItems }` 而唔係裸 order |

**排優先次序**：R1 → R6/R7 → R5 → R2 → 其餘。R1 唔解決，整個功能會「好似做到但唔即時」。

---

## 10. 分階段落地

### P0 · 後廚屏（單工位、並存模式）— 最小可用
1. `supabase/migrations/0033_pos_kds.sql`（1 表 + RLS + Realtime publication）
2. 純函式：`lib/kds/kds-board.ts`（由 order + state 砌出屏上模型，**可 `node --test`**）
3. API：`/api/pos/kds/board`、`/api/pos/kds/items`
4. `login-screen.tsx` 加兩個模式 + `lib/kds/device-binding.ts`
5. `/kitchen` 頁（全部工位、無音效、無 undo 條）

**驗收**：收銀台落單 → 後廚屏 2 秒內出現 → 撳 ✓ → 另一部機 reload 見到 `done_qty` 落咗 DB。

### P1 · 多工位 + 營運手感
- `station` 由 `printerGroup` 映射、頂欄工位切換
- 計時器閾值可配、新單音效、undo 條、長按操作
- 離線唯讀閘 + 心跳對賬（R3/R5）
- 設定頁三選一（`print` / `both` / `screen`）

### P2 · 出餐台屏 + 閉環
- `/expo`（`action: "ready" | "recall"`）
- 叫號屏、售罄聯動、平均製作時間統計（進日報）

### P3 · 可選
- 自助點餐機／掃碼單直接落屏（唔經收銀台確認）
- 按工位嘅產能看板（每 15 分鐘出餐數）

---

## 11. 需要你拍板嘅事

1. **Q1/Q2/Q3**（§2）——尤其屏係替代打印定並存。
2. 工位劃分：直接用菜單嘅 `printerGroup`（例如「廚房」「水吧」），定要另開一套「後廚屏工位」？
3. 出餐台屏要唔要同一部 iPad 兼做**叫號屏**？
4. 後廚屏嘅帳號：用店長／經理的 8 位電話帳號綁定（同 kiosk 一致），定係想廚房師傅各有自己嘅 PIN？
   （後者要改 Ledger 帳號體系，成本高很多，**建議唔做**。）

---

## 附：一句話版本

> 地基已經有 8 成（分區 `printerGroup`、出餐狀態 `fulfillmentStatus`、Realtime、設備綁定、終端憑證）。
> 真正要新增嘅係**一張單品完成表**（用「已出份數」而唔係打勾，先頂得住加單）＋**3 條端點**＋**2 個頁面**。
> 最大風險唔係做唔到，而係**Realtime 訂錯專案**（R1）同**屏長期唔更新**（R2）——
> 呢兩個唔搞好，屏會「好似做到，但永遠要 reload 先見到」。
