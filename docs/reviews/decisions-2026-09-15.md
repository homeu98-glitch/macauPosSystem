# 三項待拍板事項 —— 決定與理由（2026-09-15）

> **目的**：呢三項之前列為「需商家拍板」。本文直接給出**明確決定 + 理由 + 前置條件**，
> 並標明「需你確認的一個參數」。Ledger 側可以據此對齊。
> **關聯**：[`system-audit-2026-09-15.md`](./system-audit-2026-09-15.md) §5.3、[`dining-optimization-2026-09-15.md`](./dining-optimization-2026-09-15.md) §6

---

## 決策 1 · 沽清（sold-out）上雲 —— ✅ **做，且定為「店級共用」**

### 現況（實測）

| 事實 | 證據 |
|---|---|
| 雲表已存在、結構齊、已有 anon select policy、已有 `unique(store_id, menu_item_id)` | `supabase/migrations/0010_kiosk_realtime.sql:13-21` |
| **但完全零寫入** —— 全 repo 冇任何 INSERT/UPDATE | `src/lib/pos/soldout.ts:15-19` |
| 沽清只存該機 localStorage ⇒ 多機唔一致、換機即失 | `src/lib/pos.tsx` 讀寫本機 `sold-out` key |
| `/api/inventory/soldout` 係 TODO stub | `src/app/api/inventory/soldout/route.ts:11-15` |
| 落單時的售罄校驗**fail-open**（讀唔到就當冇售罄） | `src/app/api/pos/sync/route.ts:658-661` |

**實際後果**：掃碼／Kiosk 客人可以點已售罄的菜 → 現場「點完才知冇貨」；A 機標沽清、B 機照賣。

### 決定

1. **語意定為「店級共用一份沽清」**（唔係終端設定、唔係個人偏好）——
   沽清係**門店營運事實**：廚房冇貨，全店都唔應該賣得。
2. **真源 = `pos_soldout`**（不必新建表，現有結構已足夠：`store_id` + `menu_item_id` + 售罄狀態 + `updated_at`）。
3. 🔴 **寫入必須經 `/api/pos/sync`，新增事件 `SOLDOUT_UPDATED`** ——
   **唔可以**照 `device-config` 咁樣開一條 direct POST。
   理由：direct POST 在**離線時只能入 outbox，而 outbox 事件 payload 未必包含該欄位**（零售欄位就中過這個坑：
   `DEVICE_CONFIG_UPDATED` 的 payload 唔含零售設定 ⇒ 離線保存 = 永遠上唔到雲）。
   走 `/api/pos/sync` 即自動獲得：outbox 重試、對賬守護、跨店隔離閘、`classifyQueueEvent` 分類。
4. **讀取兩條路**：
   - Realtime：`use-pos-realtime.ts` **已經訂閱** `pos_soldout` 且已有 `onSoldoutUpsert` handler ⇒ 只需接上 store，零新增訂閱。
   - Backfill：`/api/pos/state` **現時唔回 soldout** ⇒ 要加一個 `soldout` 欄位（否則斷線期間漏掉的沽清補唔返，
     與 backfill 同一個設計原則）。
5. **衝突解決：LWW by `updated_at`**，並要求「取消沽清」可被表達（唔可以只用「存在即售罄」，
   否則永遠取消唔到）。建議狀態值：`soldOut: boolean` + 可選 `remainingQty: number | null`（null = 不限量）。
6. 🔴 **失敗模式必須 fail-open**：雲端讀唔到 → 用本機值、**唔阻落單**。
   呢個係紅線：沽清係「減少白做」的優化，唔可以變成「令客人落唔到單」的新故障源。

### 對 Ledger 的影響：**無**

沽清純屬 POS 店內事實，**唔需要上 Ledger、唔需要新 RPC、唔需要改契約**。
Ledger 側只需知：掃碼客人落單時，POS 端（`/api/pos/sync` 的匿名通道）會用雲端沽清做校驗，
所以**掃碼菜單顯示的售罄狀態會與店內一致**（透過餐牌／`bootstrap` 之外的一條獨立通道）。

### ⚠️ 需你確認 1 個參數

**沽清應該「按菜」定「按規格」？**
現時 `pos_soldout` 的 key 係 `(store_id, menu_item_id)` ⇒ **只做得到按菜沽清**
（例：整體「凍檸茶」售罄，但做唔到「凍檸茶 · 少冰」單獨售罄）。
若需要規格層級，要加欄位／改 unique key，屬 migration 範圍。**默認：按菜。**

---

## 決策 2 · `printZones` 由 per-device 升為店級 —— ✅ **做，但用「雙讀過渡」**

### 現況（呢個係一個真 bug，唔止係設計問題）

| 事實 | 證據 |
|---|---|
| `printZones`（打印分區）實際儲存在 **per-device** 的 `pos_device_configs.local_settings` | `src/app/api/pos/device-config/route.ts:54-64`（upsert by `device_id`） |
| 但讀取端用「**store_id + 最新 updated_at**」取一行 ⇒ 語意變成店級 | `api/pos/state/route.ts:143-145`、`kds/kds-server.ts:206-212` |
| ⇒ **最後保存任何設定的那台機，會把它的 printZones 蓋成全店** | `kds/kds-server.ts:186-197`（代碼註解自認 P1 未做） |
| 而 `printZones` 正是 **KDS 分區的權威來源** | `kds/kds-server.ts:177-215` |

**實際後果**：A 機改了打印分區 → B 機之後保存任何設定（例如改個備註）→ 分區被 B 機的值覆蓋 →
廚房單去錯打印機／KDS 工位錯亂。這是「靜默」的，冇任何錯誤提示。

### 決定

1. **`printZones` 定為「店級真源」** —— 語意是「哪個工位印哪些菜」，屬全店事實，唔係終端事實。
2. **per-device 只保留真正屬於設備的東西**：本機有哪幾台**實體打印機**（IP／USB／連線方式）。
   ⇒ 分界線：**「印邊啲菜」= 店級；「用邊台機」= 設備級。**
3. **過渡採「雙讀」**：讀取時 **店級優先 → 店級未設定才 fallback 落 per-device 舊值**。
   ⇒ 舊機／未更新版本行為完全不變，零風險上線。
4. **Backfill**：migration 時把「目前店最新一行」的 `printZones` 寫入店級真源
   （＝凍結現狀，唔會突然改變任何店的實際分區）。
5. **寫入**：設定頁儲存時寫店級；**停止再寫** device 級的 printZones（但繼續讀，做過渡保險）。

### 需協調的範圍（三端）

| 端 | 要改什麼 |
|---|---|
| Web 設定頁 | 儲存目標由 device → 店級；保留讀 fallback |
| KDS（`kds-server.ts`） | 讀取改為店級優先 |
| Hub / Companion / Android | 確認 `printerGroup` 解析仍然一致（它們只讀 job 上的 `printerGroup`，理論上唔受影響） |
| `print-job-enqueue` / `escpos-template` | 確認 `printZones` → 打印機綁定的解析路徑 |

### 對 Ledger 的影響：**無**（純 POS 店內設定）

### ⚠️ 需你確認 1 件事

**多部收銀機的分區設定，今後係唔係一律全店一致？**
（即「A 機改分區、B 機應該即刻跟住變」—— 本文假設係。
若原來刻意想讓不同機有不同分區，就要改用「店級預設 + 終端覆蓋」兩層模型，屬不同設計。）

---

## 決策 3 · `PrintJob.ttl` 長度 —— ✅ **12 小時（絕對期限，非時長）**

### 🔴 先講一個極易寫錯的點

`ttl` 唔係「時長」，係**絕對的 epoch 毫秒期限**。守衛寫法（`0035` line 60）：

```sql
and (j.ttl is null or j.ttl > (extract(epoch from now()) * 1000)::bigint)
```

⇒ **正確計法**：`ttl = (created_at 的 epoch ms) + 12 * 60 * 60 * 1000`
（寫成 `ttl = 43200000` 會變成 1970 年就過期 ⇒ 所有 job 永遠印唔出，且係靜默。）

### 現況

`ttl` 只在 `src/lib/types.ts:1399` 定義、只被 `native.ts:109` 讀取轉發；
**所有 builder 都冇寫 `ttl`**（`print-jobs.ts:140-161,249-265,302-323,386-403,511-532`）。
⇒ `ttl` 恆為 `null` ⇒ 上面那條守衛**永遠成立** ⇒ 「隔夜補印」的真實風險存在
（打烊前卡住的 pending 單，翌日 APK 一上線就照印，客人／廚房見到一張昨日舊單）。

### 決定

| 項目 | 決定 |
|---|---|
| 值 | **`created_at + 12 小時`**（絕對 epoch ms） |
| 由誰寫 | 🔴 **server 端**寫 `pos_print_jobs` 時統一設定（唔靠 client）—— 避免 web／Android／relay 三端不一致 |
| 人手重打 | **唔受影響**：重打會建**新 job**（新 `created_at` ⇒ 新 ttl），商家人手補印永遠做得到 |
| 為何係 12 小時 | 對齊專案既有的「班次」尺度：`SHIFT_OVERTIME_MS = 10 * 60 * 60 * 1000`（`shift-sync.ts:21`，即「連續開工 10 小時」為逾時門檻）。**12 小時 = 一個完整班次 + 2 小時緩衝** ⇒ 保證「同一班內卡住嘅單一定救得返」（中繼機離線幾小時後返嚟，照樣補印） |

### 已知取捨（誠實記錄）

若店舖**閉店時長 < 12 小時**（例：23:00 收工、10:00 開工 = 11 小時），
則打烊前建立的 job 在翌日開工時可能仍在 TTL 內 ⇒ **隔夜舊單仍會被印一次**。

⇒ 所以**建議第二道閘（可分開獨立做，亦可一齊做）**：

> **在 claim RPC 加「同營業日」過濾** ——
> 只認領「Macau 時間同一營業日」建立的 job，日界建議取 **04:00**（避開跨午夜營業的店）。

呢個做法比單靠 TTL 更貼題：唔需要猜店舖的營業時間長度，直接表達「唔好印隔夜紙」的原意。

### ⚠️ 需你確認 1 個參數

**店舖最晚營業到幾點？有無營業時段跨越凌晨 04:00？**
（用嚟定「營業日日界」。若冇跨 04:00，日界取 04:00 就安全；若有，要另議。）

### 對 Ledger 的影響：**無**（`ttl` 純屬 POS 打印隊列內部欄位）

---

## 一覽表（給 Ledger / 工程側對齊用）

| 項目 | 決定 | 對 Ledger 影響 | 需你確認 |
|---|---|---|---|
| 沽清上雲 | ✅ 做，**店級共用**；經 `/api/pos/sync` 新事件 `SOLDOUT_UPDATED`；`/api/pos/state` 補 soldout；fail-open | **無**（純 POS 店內事實） | 按菜 or 按規格？（默認按菜） |
| `printZones` | ✅ 升店級真源 + **雙讀過渡** + backfill 凍結現狀；per-device 只留「有哪幾台打印機」 | **無** | 多機分區是否一律全店一致？（默認是） |
| `PrintJob.ttl` | ✅ `created_at + 12h`（**絕對 epoch ms**），由 **server 端**寫；人手重打不受限 | **無** | 最晚營業幾點？有無跨 04:00？ |

**三項的共通上線原則**（與本專案既有教訓一致）：
1. 一律**先雙讀／先凍結現狀**，唔好一次性切換語意。
2. 一律**fail-open**：設定類同步失敗唔可以令落單／出紙失效。
3. 一律要有**migration + 回退 SQL**，並且註明「邊個行為會改變」。
