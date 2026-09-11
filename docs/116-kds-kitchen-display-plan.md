# 後廚屏 / 出餐台屏（KDS）方案 · docs/116

> 目標：iPad 一部掛後廚、一部擺出餐台，**同一個登入入口**揀「後廚屏」／「出餐台屏」，
> 屏上睇單、點掉單品、確認出餐，**唔經打印機**。
>
> 狀態：**P0 已實作（2026-09-11）** —— 後廚屏＋崗位鎖定＋3 條端點＋1 張表。
> 上線前**必做**：① 跑 migration `0033_pos_kds.sql`；② 確認 `NEXT_PUBLIC_POS_SUPABASE_URL`
> 指向 POS 專案（R1）。詳見 **§10.1 實作記錄**。
> 出餐台屏 `/expo` 屬 P2，未做。

---

## 0. 已拍板嘅決定（2026-09-11，用戶確認）

| # | 問題 | **決定** | 對方案嘅影響 |
|---|---|---|---|
| 1 | 屏係替代打印定並存 | **並存**（`both`） | 廚房單照印，屏同步顯示。`kitchen` print toggle **保持開啟**，唔郁現有出紙行為。試行期風險最低。 |
| 2 | 工位點劃分 | **用菜單嘅 `printerGroup`** | 唔另設「後廚屏工位」概念。實際值：`kitchen` / `drinks`（`receipt` 係收銀機、`label` 係標籤，**唔做為工位**）。顯示名要一層 fallback map（`{kitchen:"廚房", drinks:"水吧"}`）＋ 有配打印機就用打印機 `name`。 |
| 3 | 出號（叫號）屏 | **暫時唔做** | `POST /api/pos/kds/orders` 只做 `ready` / `recall`，唔需要 `call` 相關欄位。P2 再議。 |
| 4 | 後廚屏帳號 | **同 kiosk 一致** | 用店長／經理嘅 8 位電話帳號登入一次 → 寫 `KdsDeviceBinding` → 之後開機直接入後廚。**唔**為廚房師傅另開 PIN（唔改 Ledger 帳號體系）。 |
| 5 | 工位要唔要可以即場切換 | **唔可以 —— 登入後先揀崗位，揀完鎖死** | 屏內**冇「全部 / 廚房 / 水吧」切換掣**，只剩一個唯讀崗位徽章。切換要走「⚙ 設定」→ 重新登入。目的係降低誤按。**詳見 §§4.4** |

決定 5 有一個連帶項：**必須留逃生門**（設定 → 切換崗位 → 清綁定 → 回登入）。
冇逃生門就會出現「揀錯咗 = 呢部機廢咗」；但要做到**深兩層 + 要重新登入**，
先算真正防誤按。另外「店只有一個工位」時**唔應該出選擇步驟**，直接鎖定。

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

### 4.4 🔴 崗位（工位）鎖定 —— 登入後先揀，屏內零切換掣（2026-09-11 新增）

**決策**：一部 iPad 開機 = 一個崗位。登入後**強制**揀「廚房」或「水吧」，
揀完就鎖死；屏內**冇「全部 / 廚房 / 水吧」切換掣**，要改只能經「⚙ 設定」→ 重新登入。

#### 為什麼唔係「加兩個登入入口」而係「一個入口 + 揀崗位」

`LOGIN_MODES` 已經有 6 個（快餐／堂食／美容／自助機／後廚屏／出餐台屏）。
再加「後廚屏·廚房」「後廚屏·水吧」會變 8 個，而且撈亂咗兩件事：

| 維度 | 屬於邊個 | 例子 |
|---|---|---|
| **登入模式** | 「呢間店／呢個角色係做乜」 | 快餐定堂食、收銀定後廚 |
| **崗位** | 「**呢一部機**擺喺邊」 | 呢部 iPad 擺喺炒鍋邊 → 廚房 |

同一間店可以同時開「廚房屏」＋「水吧屏」兩部 iPad，兩部機嘅登入模式一樣、
只係崗位唔同 → 崗位係**設備屬性**，自然應該跟設備綁定一齊存。

#### 可行性：地基已經有，唔使新機制

| 需要嘅嘢 | 現成 | 位置 |
|---|---|---|
| 設備綁定（登入一次、之後開機即入） | ✔ 照抄 kiosk | `saveKioskDeviceBinding` / `src/lib/kiosk-order.ts` |
| 工位分類 | ✔ **已經分好** | `OrderItem.printerGroup`（`kitchen` / `drinks`） |
| 屏按工位過濾 | ✔ 原型已驗證 | `renderKitchen()` 嘅 `i.station===station` |
| 跨店隔離 | ✔ | Realtime `store_id=eq.` ＋ 端點用終端憑證 |

**唔需要**新表、新 RPC、新權限模型。`KdsDeviceBinding.station` 一個欄位就夠。

#### 影響範圍

| 檔案 | 改動 | 風險 |
|---|---|---|
| `src/lib/pos/scan-mode-from-login.ts` | `LoginMode` 加 `"kitchen" \| "expo"`；兩者一律回 `null` | **低**。同 docs/115 §12 完全同理 |
| `src/lib/pos/scan-mode-from-login.test.ts` | ⚠️ **必改**：測試 enumerate 全部 mode，加咗值就會 fail（呢個係好事，係安全網） | 低 |
| `src/components/login-screen.tsx` | 加「後廚屏 / 出餐台屏」兩粒掣；`scanOrderHint: Record<LoginMode,string>` 會 **typecheck 強制**補 key（漏咗 build 就紅，捉得到） | 中。`kitchen` 分支唔可以即刻跳頁，要跳去揀崗位 |
| `src/lib/kds/device-binding.ts`（新） | `KdsDeviceBinding` | 低（照抄 kiosk，必帶 `isPlaceholderStoreId()` 硬閘） |
| `src/lib/kds/stations.ts`（新） | 由 `bootstrap.printerGroups` 衍生崗位清單 | 低。**必須排除 `receipt`** |
| `src/app/kitchen/page.tsx`（新） | 入頁先檢查綁定；冇崗位 → 顯示揀崗位 | — |
| `GET /api/pos/kds/board` | 加 `?station=` | 低 |
| `POST /api/pos/kds/items` | **唔使改**（item 本身帶 station） | — |

⚠️ **`printerGroup` 係自由字串**（唔係 union），所以崗位清單**唔可以寫死**，
要由菜單實際用過嘅值動態生成，並且一定要**剔走 `receipt`** ——
收銀機打印機唔係一個工位，畀佢出現喺崗位清單係 bug。

#### 實作方式

```ts
// ① 開機 / 入 /kitchen
const b = loadKdsDeviceBinding();          // localStorage
if (!b)                      → 顯示「揀崗位」
else if (b.role === "kitchen") → 直接入屏，鎖 b.station

// ② 揀崗位
chooseStation(st) →
  saveKdsDeviceBinding({ storeId, storeName, role: "kitchen", station: st, boundAt })
  clearKdsLocalCache()        // ⚠️ 唔清就會殘留上一個崗位嘅狀態
  router.replace("/kitchen")

// ③ 屏內：**冇** station state，只有常數
const station = binding.station;   // 由頭到尾唔會變
```

**必須留逃生門**：屏內「⚙ 設定」→「切換崗位」→ 清綁定 → 回登入。
冇逃生門就會出現「揀錯咗 = 呢部機廢咗」。但要**深兩層 + 要重新登入**，
先達到「降低誤按」而唔係「一刀切死」。

#### 邊界情況（唔處理就會出 bug）

| 情況 | 正確做法 |
|---|---|
| 店只有一個工位（細店只有厨房） | **唔出**選擇步驟，直接鎖定 —— 唔好多餘一步 |
| 菜單完全未設 `printerGroup` | 清單空 → fallback 單一「廚房」，並喺設定頁提示去菜單補 |
| 有人直接打 `/kitchen` 但未綁定 | **強制**去揀崗位。**絕對唔可以**顯示「全部」—— 咁就返返去用戶想消滅嘅嘢 |
| 換崗位（廚房 → 水吧） | 清本機 KDS 快取（`doneQty` 係雲端嘅，但本地 optimistic 層要清） |
| 剩返一個工位但綁定已存在 | 唔變更綁定（避免「設定頁改咗菜單」就靜靜重置部機） |
| 出餐台屏 | **唔需要**崗位（佢要睇全單核對）—— 唔好照抄 |

### 4.5 即時性（Realtime）—— 用戶要求「唔可以有 delay」

**結論：設計係推送式，唔用 polling。但「零延遲」唔可以只靠推送，
一定要補三樣嘢，否則會出現「好似做到，但永遠要 reload 先見到」。**

現成嘅 `usePosRealtime()`（`src/lib/pos/use-pos-realtime.ts`）已經係收銀側用緊嘅實現，
KDS 直接複用，唔使新寫：

| 已經做咗 | 細節 |
|---|---|
| 推送而非輪詢 | `postgres_changes` 訂 `pos_orders` / `pos_print_jobs` / `pos_soldout` |
| 店級隔離 | filter `store_id=eq.<storeId>` |
| 自動重連 | `CHANNEL_ERROR` / `TIMED_OUT` → 3 秒後重訂 |
| 回到前景重訂 | `visibilitychange` → `visible` 就重訂 |

**但仲欠三樣，缺一就會有「delay 感」或者「靜默漏單」：**

1. **重連後補拉（最重要）** —— hook 有 `onResubscribed`（debounce 3s）但**唔會自動補資料**。
   iPad 休眠、轉 Wi-Fi、鎖屏之後，Realtime 會重新 `SUBSCRIBED`，
   但**唔會補發睡著期間嘅事件** → 唔補拉就會永遠少幾張單，直到有人手動 reload。
   **做法**：`onResubscribed` → 立即 `GET /api/pos/kds/board` 覆蓋全屏狀態。

2. **樂觀 UI** —— 撳 ✓ 要**即刻**本地 `doneQty+1`（唔等 server 回應），
   POST 失敗才回滾 + 出紅橫幅。否則每次撳都有 100~300ms 延遲感，
   廚房同事會以為「撳唔到」然後再撳一次 → 變重複確認。

3. **看門狗** —— ① `visibilityState` 變 `visible` 補拉一次；
   ② Realtime 靜咗超過 60 秒而屏上仲有未完成 → **單發**補拉（唔係 loop 輪詢）。
   呢個唔算 polling，係「懷疑脫線就對一次數」。

**🔴 R1 陷阱（必須先解決）**：`getPosSupabaseClient()` 讀嘅
`NEXT_PUBLIC_POS_SUPABASE_URL` / `_ANON_KEY` 一定要指向 **POS 專案**。
錯嘅話 Supabase **唔會報錯**（訂唔存在嘅表照回 `SUBSCRIBED`）→
屏顯示「已連線」但**永遠唔更新**。呢個係 docs/113 已記錄嘅坑，KDS 一定要有
一次過嘅 REST 探測做健康檢查（`PGRST205` 判表唔存在）。

**崗位鎖定 vs Realtime**：**冇衝突，亦唔需要重新訂閱**。
`pos_orders.items` 係 JSONB，Realtime filter 冇得按 station 過濾 →
屏仍然收全店事件，只係本地唔顯示唔屬於自己崗位嘅行。
好處：切崗位唔使斷線重訂。代價：payload 略大（可接受）。

**預期延遲**：DB commit → Realtime 廣播 → client，同店 Wi-Fi 下通常 **< 500ms**。
P0 驗收線：**收銀落單 → 屏上出現 ≤ 2 秒**。

⚠️ 同打印路徑完全無關：KDS **唔經** print relay，亦**唔行** outbox（見 §3.1）。

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

（可互動原型：**`docs/121-kds-ui-mockup-v4.html`** ← 最新，2026-09-11，
已加「登入後揀崗位 + 屏內鎖定（冇『全部』）」；
舊版 `docs/117` / `docs/118` / `docs/119` / `docs/120` 已被取代，唔好用。）

### 7.0 ⚠️ 審稿稿／原型嘅版面硬規則（v1~v3 中過嘅坑）

`docs/117` / `docs/118` 出過「大量元素錯位」，根因唔係個設計，而係**原型本身加咗響應式斷點**：

| 坑 | 後果 | 正確做法 |
|---|---|---|
| 原型加 `@media (max-width: 900px)` 把三欄塌成一欄 | 預覽面板一窄 → 出餐台屏三欄變一欄、完全睇唔明 | **審稿稿一律唔可以有 `@media` 斷點** |
| 用 `aspect-ratio` + `min-height` 做 iPad 外框 | 面板窄過 min-height 換算值 → 比例失真、內容被壓 | 改用**固定畫布 1180×820 + `transform: scale()`** 等比縮放 |
| 單行藥丸用 `display:grid`，再靠 `margin-left:auto` 推右 | grid 單元格由內容決定闊度 → `auto` 邊距失效 → 左右唔對齊 | 單行元素用 `inline-flex`；要左右分開就用 `grid-template-columns: 1fr auto` |
| 用 `display:contents` 做頁面切換包裝 | 跨瀏覽器行為唔一致，flex 子項計算易出錯 | 用真實 `flex:1; min-height:0; display:flex; flex-direction:column` 包裝 |
| 🔴 **捲動區用 `display:grid` 但唔寫 `grid-auto-rows`** | 容器有明確高度（`flex:1` + 固定畫布）→ Chrome 將隱式 `auto` row 壓到 **min-content**（實測 232px），但卡片係 max-content（293~372px）→ **卡片撐爆自己個 row、直接疊落下一個 row 上面**。`overflow-y:auto` 會令佢唔報錯、唔 overflow，只係**靜靜咁重疊** —— console / build log 完全捉唔到 | **`grid-auto-rows:max-content`**（＋ `align-items:stretch` 令同一 row 卡片等高，格線齊） |
| 卡片內列左右內距唔對稱（`.lines{padding:6px 8px}`） | ✓ 掣貼實卡片右邊界，睇落好似被切咗 | `.lines` 左右都要有內距，`✓` 同卡片邊界至少留 14px |
| 靠肉眼判斷「有冇重疊／走位」 | 四輪來回都仲係「錯位」 | **用真實 Chromium 量度**：`tools/2026-09-11-measure-kds-layout.js`（逐卡 bounding box + 兩兩重疊檢測）／`tools/2026-09-11-verify-kds-screens.js`（全畫面掃） |

**已知取捨（v3）**：`align-items:stretch` 令同一 row 兩張卡等高，好處係格線永遠齊、
兩邊嘅 ✓ 掣橫向對齊（廚房同事可以盲撳）；代價係項目少嘅卡底部會有空白（實測最多 ~133px）。
如果將來嫌空白多，可以改為「兩欄獨立堆疊（masonry）」，但就會失去跨卡橫向對齊 —— 二選一。

**落落真代碼（React/Tailwind）時同理**：後廚屏／出餐台屏係**固定角色嘅裝置頁**，
唔應該跟手機斷點重排。iPad 橫向係唯一目標形狀；窄過就橫向滾，唔好塌欄。
對應 Tailwind：`grid auto-rows-max items-stretch`（**唔可以**只寫 `grid`）。

### 7.1 後廚屏 `/kitchen`（橫向 iPad 1024×768 起）

```
┌──────────────────────────────────────────────────────────────┐
│ 澳門茶餐廳 · 廚房屏   ● 廚房 已鎖定    ⬤ 已連線   未完成 7  ⚙│ ← 頂欄 56px
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
│  ↑ 頂欄**冇** 全部/廚房/水吧 切換掣 —— 崗位係鎖喺設備度（§4.4）│
└──────────────────────────────────────────────────────────────┘
```

**規格**

- 卡片**兩欄等高格**（同一 row 兩張卡等高 → 格線齊、兩邊 ✓ 掣橫向對齊）。
  一屏至少見 6 張卡。
  ⚠️ 落 Tailwind 要寫 `grid auto-rows-max items-stretch`（**唔可以**只寫 `grid`），
  否則捲動容器會將 row 壓到 min-content → 卡片互相重疊。見 §7.0。
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
- **頂欄只有一個崗位徽章（唯讀）**，唔可以一撳即切；切換走「⚙ 設定」→ 需重新登入。

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
3. API：`/api/pos/kds/board`（帶 `?station=`）、`/api/pos/kds/items`
4. `login-screen.tsx` 加「後廚屏」模式 + `lib/kds/device-binding.ts`
   + `lib/kds/stations.ts`（由 `printerGroups` 衍生、排除 `receipt`）
5. `/kitchen` 頁：**入頁先檢查綁定 → 冇崗位就顯示揀崗位 → 有就直接鎖定入屏**
6. ⚠️ **同步改 `scan-mode-from-login.test.ts`**（加咗 `LoginMode` 值，唔改就 fail）
7. Realtime 三件套：`onResubscribed` 補拉 ＋ 樂觀 UI ＋ `visibilitychange` 看門狗（§4.5）

**驗收**：收銀台落單 → 後廚屏 **2 秒內**出現 → 撳 ✓ → 另一部機 reload 見到 `done_qty` 落咗 DB。
**另驗**：① 未揀崗位入 `/kitchen` 會被彈去揀崗位；
② 廚房屏唔會見到水吧項目，反之亦然；③ 頂欄「未完成」係本崗位數字。

### P1 · 多工位 + 營運手感
- `station` 由 `printerGroup` 映射、**設定頁切換崗位（要重新登入）**
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

### 10.1 ✅ P0 實作記錄（2026-09-11 完成）

#### 新增檔案

| 檔案 | 作用 |
|---|---|
| `supabase/migrations/0033_pos_kds.sql` | `pos_kds_item_state` 表 + RLS + Realtime publication（全部 idempotent） |
| `src/lib/kds/types.ts` | 型別（**只有 `import type`** → 可被 `node --test` 載入） |
| `src/lib/kds/stations.ts` | 工位推導（剔走 `receipt`/`label`、fallback、`needsStationPicker`） |
| `src/lib/kds/device-binding.ts` | `KdsDeviceBinding`（localStorage + 假店硬閘） |
| `src/lib/kds/kds-board.ts` | **純函式**砌板（client 同 server 共用同一份） |
| `src/lib/kds/kds-server.ts` | 端點共用：授權、讀訂單、讀狀態、讀工位來源 |
| `src/lib/kds/use-kds-realtime.ts` | KDS 專用 Realtime 訂閱（多訂 `pos_kds_item_state`） |
| `src/lib/kds/use-kds-board.ts` | 資料層：即時性三件套（補拉 / 樂觀 UI / 看門狗） |
| `src/app/api/pos/kds/board/route.ts` | `GET` 一次過拉原料 |
| `src/app/api/pos/kds/items/route.ts` | `POST` 單品完成份數 |
| `src/app/api/pos/kds/orders/route.ts` | `POST` `ready` / `recall` |
| `src/app/kitchen/page.tsx` + `src/components/kds/*` | 後廚屏（揀崗位 / 屏 / 設定卡） |
| `src/lib/kds/stations.test.ts`、`kds-board.test.ts` | 47 個單元測試 |

改動：`scan-mode-from-login.ts`（`LoginMode` +2）、`scan-mode-from-login.test.ts`、
`login-screen.tsx`（加「後廚屏」掣 + 導向 `/kitchen` + 唔改營運模式）。

#### 上線步驟（ops）

1. **跑 migration**：Supabase SQL Editor 執行 `supabase/migrations/0033_pos_kds.sql`。
   ⚠️ 未跑都可以部署（屏會顯示「後廚狀態表未建立」大字警示，唔會扮成功），但撳 ✓ 唔會保存。
2. **確認環境變數**（R1，最重要）：
   - `NEXT_PUBLIC_POS_SUPABASE_URL` / `NEXT_PUBLIC_POS_SUPABASE_ANON_KEY` → **POS 專案**（唔係 Ledger）
   - `SUPABASE_SERVICE_ROLE_KEY` → 寫入用（缺咗 `POST` 會 503，唔會扮成功）
3. 平板開 `/login?mode=kitchen` → 登入 → 揀崗位 → 完成。

#### 驗收清單

- [ ] 收銀落單 → 後廚屏 **≤ 2 秒**出現（唔使 reload）
- [ ] 撳 ✓ → 立即變灰（樂觀），另一部機 reload 見到 `done_qty` 落咗 DB
- [ ] 未揀崗位直接打 `/kitchen` → **彈去揀崗位**，唔會顯示「全部」
- [ ] 廚房屏見唔到水吧出品，反之亦然
- [ ] 頂欄「未完成」= **本工位**未完成**份數**
- [ ] 只有一個工位嘅店 → 自動跳過揀崗位
- [ ] 熄 Wi-Fi → 撳 ✓ 回滾 + 紅橫幅（唔可以扮成功）
- [ ] 平板休眠 10 分鐘再開 → 補拉返齊（唔會少單）

#### 同方案有出入嘅地方（連理由）

| 方案原文 | 實作 | 理由 |
|---|---|---|
| board 回「砌好、按工位篩過」嘅板 | 回**原始輸入**（訂單 + 狀態 + 工位來源），客戶端用**同一份**純函式砌 | 客戶端要本地即時重算（樂觀 UI + Realtime 增量），否則每個事件都要再打 REST = 變相 polling，而且會出現兩套砌板邏輯 |
| 「全部完成」判定 | **按本工位**計，唔係跨工位 | 修 bug：一張單同時有廚房／水吧出品時，廚房做完自己嗰碟但水吧未做 → 廚房屏會永遠留住一張已冇嘢做嘅卡 |
| 12 小時窗口用 `sentToKitchenAt` | 改用 `updated_at` | 酒樓長時間嘅單加菜時，`sentToKitchenAt` 已經 13 小時前 → 成張單消失、加嗰兩碟永遠冇人做 |
| `cooking_at` | P0 **唔寫**（留 NULL） | 呢條係全屏最熱路徑（一秒撳幾下），唔想為咗一個 P3 統計欄多打一次 DB |
| `recall` 清走狀態行 | 用 **upsert `done_qty=0`** 而唔係 `delete` | DELETE 事件嘅 `payload.old` 冇 `REPLICA IDENTITY FULL` 就只剩 PK；UPDATE 一定帶完整新行，客戶端唔使特別處理 |
| 綁定失效 → 彈返揀崗位 | **唔自動彈** | 掛喺牆上嘅屏無啦啦跳去揀崗位係災難。改為喺設定卡顯示提示，要改就人手入 |
| 「完成卡留 8 秒」 | **純 client 本地效果**；server 唔會回已完成嘅單 | 否則 reload 之後一班綠色卡會永遠唔走 |

⚠️ **已知未做**：出餐台屏 `/expo` 屬 P2，所以登入畫面暫時只出「後廚屏」一粒掣
（`expo` 已經喺 `LoginMode` 同 `scanOrderHint` 入面，加掣 + 開頁就得）。

---

### 10.2 🔴 分區（崗位）真源修正（2026-09-11，用戶指出）

#### 問題

KDS「揀崗位」畫面顯示嘅係**系統硬編碼**嘅「廚房 / 水吧」，而唔係商家自己設定嘅打印分區。

商家喺「設定 → 打印機綁定 → 打印分區」可以自由新增（例如 **後廚1 / 後廚2 / 後廚3 /
水吧1 / 水吧2 / 水吧3**，或者「EricTest」），但屏上完全見唔到。

#### 根因（兩個獨立錯誤疊埋）

| # | 錯誤 | 後果 |
|---|---|---|
| 1 | KDS 讀 `pos_bootstrap_config.printer_groups` 當成分區清單 | 呢個欄位係 **legacy / demo 值**（`["kitchen","drinks","receipt"]`，見 `mock-data.ts`），同商家分區完全無關 |
| 2 | `STATION_LABELS` 硬編碼 `kitchen→廚房`、`drinks→水吧` | 商家改咗分區名，屏上仍然顯示代碼寫死嗰個；自訂分區（`後廚3`、`erictest-1757…`）就會顯示 raw id |

**分區嘅真正來源**係 `localSettings.printZones: { id, name }[]`
（`src/lib/types.ts` `PosLocalSettings`），由設定頁「保存」經
`/api/pos/device-config` 推上 `pos_device_configs.local_settings.printZones`。
KDS 從來冇讀過佢。

#### 為什麼用戶嘅邏輯係正確嘅

1. **分區係商家嘅商業詞彙，唔係系統嘅固定枚舉。** 設定頁本身就寫「分區可自由新增」。
2. **後廚1/2/3 係三個獨立工作崗位**（各有各嘅師傅、各有各嘅出餐節奏）。合併成「廚房」之後：
   - 每個崗位都要睇晒其他崗位嘅嘢 → 誤撳；
   - 三個崗位嘅 ✓ 混埋一張單 → 冇人知邊個未做；
   - 「未完成 N」對唔上任何一個人嘅工作量。
3. **系統內部本身已經係「各自獨立」**：`OrderItem.printerGroup` 存嘅就係
   `menuPrinterOverrides[itemId] ?? item.printerGroup`，即係**分區 id**。
   「統一合併」純粹係 KDS 顯示層硬加嘅一層對照表。

#### 修正

| 位置 | 改動 |
|---|---|
| `src/lib/kds/stations.ts` | **刪除** `STATION_LABELS` / `isKdsStation`；改為 `deriveKdsStations({ printZones, … })`，名**一律由商家提供**。分區次序亦跟商家設定 |
| `src/lib/kds/kds-server.ts` | 新增讀 `pos_device_configs.local_settings.printZones`（逐個元素白名單化） |
| `GET /api/pos/kds/board` | 回 `printZones` |
| `use-kds-board.ts` / `kitchen-screen.tsx` | 帶落 `buildKdsBoard()` |
| `station-picker.tsx` | 顯示商家分區名（**唔再顯示 raw id** —— 自訂 id 帶時間戳）；圖示改為用**名**做關鍵字比對；加「未收到分區」空狀態 |
| `items` / `orders` 端點 | `isKdsStation` → `isLegacyNonStation`（只擋 `receipt`/`label`，自訂分區一律放行） |
| 確認稿 `docs/121` | 分區卡改為由 `PRINT_ZONES` 生成，示範 6 個獨立分區 |

#### 保留嘅兩個「補救」，唔可以當成真源

1. **`observedStationIds`**（板上訂單實際出現過嘅 `printerGroup`）：舊資料 / 未同步時，
   訂單可能仲係 `kitchen` 呢類唔喺 `printZones` 嘅值。**唔認佢，嗰啲單會完全上唔到屏**
   （比顯示一個怪名嚴重得多）。名就用 id 本身（誠實過亂譯）。
2. **`receipt` / `label` 排除項**：呢兩個係**打印機 role**（`printer.role`），唔係分區 ——
   正常情況下 `printZones` 根本冇佢哋（`printer-wizard-modal` 入面 role === "receipt"
   嘅機係**冇** `zoneId` 嘅）。呢個排除**只**套用到 fallback 值；
   如果商家真係開咗一個叫 `receipt` 嘅分區，會照樣尊重（顯示商家畀嘅名）。

#### 例外情況（要記住）

| 情況 | 處理 |
|---|---|
| 分區 **id 唔穩定**（新增時 `` `${name.toLowerCase()}-${Date.now()}` ``） | ⚠️ **絕對唔可以**顯示 / 依賴 id。改名或刪除再加，id 就變。屏上一律用 `name` |
| 舊訂單嘅 `printerGroup` 係已刪除嘅分區 id | 用 id 做名顯示（唔會 crash、唔會消失） |
| `printZones` 一個都冇（未同步 / 未設定） | 顯示「未收到本店嘅打印分區，請去收銀台設定並撳一次保存」+ 重試掣。**唔會**造假 fallback（以前係硬編碼「廚房」，會令師傅揀到一個永遠冇出品嘅崗位） |
| 分區冇任何菜 / 冇任何單（後廚3 今晚未開） | **仍然要出現**喺清單（要由 `printZones` 推導，唔可以只靠「有單 / 有菜」） |
| 一個師傅要睇兩個分區（後廚1 + 後廚2） | ⚠️ **未支援**。P0 一部機 = 一個分區（「降低誤按」同「多人共用一屏」係相反方向）。若真要做，應該做**明確嘅多選**，唔好偷偷合併 |
| 多部終端各自保存設定 | ⚠️ `printZones` 屈喺 `pos_device_configs.local_settings`（per-device，讀「最新一條」）—— **最後保存嗰部機會蓋走全店分區**。長遠要搬去 `pos_bootstrap_config.print_zones jsonb`（店級，purpose-built）。**屬 P1，未做** |

---

## 11. 需要你拍板嘅事

1. **Q1/Q2/Q3**（§2）——尤其屏係替代打印定並存。 ✅ 已拍板（§0）
2. 工位劃分：直接用菜單嘅 `printerGroup`（例如「廚房」「水吧」），定要另開一套「後廚屏工位」？ ✅ 已拍板（§0 決定 2 + 5）
3. 出餐台屏要唔要同一部 iPad 兼做**叫號屏**？ ✅ 已拍板：暫時唔做（§0 決定 3）
4. 後廚屏嘅帳號：用店長／經理的 8 位電話帳號綁定（同 kiosk 一致），定係想廚房師傅各有自己嘅 PIN？
   （後者要改 Ledger 帳號體系，成本高很多，**建議唔做**。） ✅ 已拍板（§0 決定 4）
5. **（新）** 崗位徽章嘅顯示方式：淨係文字（`● 廚房 已鎖定`）定要埋 emoji？
   → 原型用**色點**（橙=廚房、藍=水吧），因為 emoji 縮到 19px 會睇成「放大鏡」。

---

## 附：一句話版本

> 地基已經有 8 成（分區 `printerGroup`、出餐狀態 `fulfillmentStatus`、Realtime、設備綁定、終端憑證）。
> 真正要新增嘅係**一張單品完成表**（用「已出份數」而唔係打勾，先頂得住加單）＋**3 條端點**＋**2 個頁面**。
> 最大風險唔係做唔到，而係**Realtime 訂錯專案**（R1）同**屏長期唔更新**（R2）——
> 呢兩個唔搞好，屏會「好似做到，但永遠要 reload 先見到」。
