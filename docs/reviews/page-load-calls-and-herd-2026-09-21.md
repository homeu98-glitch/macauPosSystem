# 頁面開啟後嘅自動呼叫 ＋ 重複請求分析（2026-09-21）

> 樣本：Vercel log `macau-pos-system-log-export-2026-09-21T08-35-24.csv`（38.8 分鐘）＋
> Supabase `supabase_logs (4).csv`（14 分鐘，**部署 `f6471d5` 之後**）＋ 商家截圖（開 `/pos` 完全冇操作）

---

## 0. 先睇成果：egress 已經崩塌到幾乎零

| 指標 | 14:31–14:54（優化前） | **15:56–16:35（現況）** | 變化 |
|---|---|---|---|
| **窗口總 egress** | 92.47 MB／29.8 min | **0.45 MB／38.8 min** | **−99.6%** |
| 每小時 | 186 MB/h | **0.7 MB/h** | — |
| 推算每日（8 小時） | ~1.5 GB | **~6 MB** | **−99.6%** |
| `pos/state` 全量 **無** skipQueue | 103 次 | **0 次** | ✅ 消失 |
| `pos/state` 全量 **有** skipQueue | 10 次 | **1 次（424 KB）** | ✅ 每次省 433 KB |
| `queue GET limit=300`（白拉） | 35 次／24 min | **1 次／14 min** | ✅ |
| `pos_orders_page` RPC | 38 次／24 min | **2 次／14 min** | ✅ |
| 守護拉取（`ordersOnly+fields`） | ~7 MB／次（修前） | **45 KB／次** | ✅ **−99.4%** |
| `pos_print_agents` | 114 次／24 min（70 GET ＋ 44 PATCH） | 41 次／14 min（**38 PATCH ＋ 3 GET**） | ✅ 結構改善 |

### 🎉 `f6471d5`（2A/2B）嘅效果可以直接量度

部署之後嘅 Supabase log 顯示 `pos_print_agents` 由「70 GET ＋ 44 PATCH」變成
「**38 PATCH ＋ 3 GET**」：

| 呼叫 | 舊做法 | 新做法 |
|---|---|---|
| heartbeat（26 次） | GET 驗證 ＋ PATCH 蓋章 ＝ 52 query | **PATCH 一個 query**（`update … returning`） |
| claim（12 次） | GET 驗證 ＋ RPC ＝ 24 query | **PATCH 一個 query**（順手蓋章）＋ RPC |
| 合計（14 分鐘） | **76 query** | **50 query**（−34%） |

而剩下嘅 **3 GET** 正正就係 `device-config`（GET 路由）—— **證明「GET 唔會寫入」嘅守衛在生產環境生效** ✅

---

## 1. 開頁自動觸發嘅全部 API call（實測）

開 `/pos` 之後**完全冇操作**，一次過觸發：

| # | 呼叫 | 次數 | 用途 | 必要性 | 可移除／延後？ |
|---|---|---|---|---|---|
| 1 | `GET /pos` | 1 | 載入 HTML／JS | 🔴 必須 | — |
| 2 | `POST /api/pos/kiosk-settings` | 1 | 自助機設定 | 🟠 中 | ✅ **可延後**到真正需要（開自助機時） |
| 3 | `GET /api/pos/bootstrap` | 1 | 門店設定（枱／菜單） | 🔴 必須 | — |
| 4 | `GET /api/pos/store-status` | **3** | 開關店狀態 | 🟠 中 | ✅ **合併成 1**（重複） |
| 5 | `GET /api/pos/state`（全量） | 1（42–424 KB） | 訂單／枱況 | 🔴 必須 | — |
| 6 | `GET /api/pos/shift` | 1 | 班次對齊 | 🟠 中 | ✅ 可延後（未開工唔需要） |
| 7 | `POST /api/topup/pending-count` | 1 | 側欄充值紅點 | 🟠 **低** | ✅ 可延後到撳入會員頁 |
| 8 | `GET /api/online-order-settings` | **5** | 自動接單／開關店狀態 | 🟠 中 | ✅ **合併成 1**（重複） |

⇒ **14 個請求之中，8 個係重複**（`store-status` ×3、`online-order-settings` ×5）
⇒ **可減到 8 個（−43%）**，而且完全唔影響功能。

---

## 2. `online-order-settings` 重複呼叫：適合 group，但有三個 concern

### 實測（Supabase log，14 分鐘）

```
23:06 ×4    35:29 ×5    36:42 ×1    36:43 ×3      ← 每次頁面載入／切頁都爆 4~5 次
```

### 為何會咁

`use-merchant-order-config.ts` 係一個 **module-level store**（一份 state），
但 `refreshMirror()` 係**喺每個 mount 嘅 effect 內各自呼叫**：

```ts
useEffect(() => {
  ...
  void refreshMirror(storeId);      // ← 每個用到呢個 hook 嘅 component 各打一次
  void refreshFromLedger(storeId);
  ...
  document.addEventListener("visibilitychange", onVisibility);   // ← 每個 mount 各加一個 listener
}, [enabled, storeId]);
```

而 POS 主畫面同時有 **4~5 個 component** 用同一個 hook
（`pos-app`、`store-open-pill`、`online-open-pill`、`quick-mode-orders-bar`、`merchant-order-config-section`）
⇒ **5 個 mount ＝ 5 個 GET**；切返前景時**同樣爆 5 次**。

### 建議做法：single-flight ＋ 共用 promise ＋ 單一 listener

```ts
// module-level
let inflight: { storeId: string; promise: Promise<void> } | null = null;

async function refreshMirror(storeId: string) {
  // ① 同店、已有 in-flight → 共用同一個 promise（唔會重複打）
  if (inflight && inflight.storeId === storeId) return inflight.promise;
  const promise = (async () => { /* 原本邏輯 */ })()
    .finally(() => { if (inflight?.promise === promise) inflight = null; });
  inflight = { storeId, promise };
  return promise;
}
```

＋ `visibilitychange` 改成 **模組層單一 listener**（refCount 控制），
同 `pending-count-store.ts` 已經做過嘅手法一樣（嗰邊已收成一個 listener ＋ 30 秒去抖）。

### 🔴 Concern（要逐項處理，唔可以照抄）

| # | Concern | 處理 |
|---|---|---|
| 1 | **切店**：共用 promise 一定要**按 storeId 分開** | 記住 `storeId` 一齊比對（上面示範） |
| 2 | **失敗要清 `inflight`**：否則一次失敗會令之後所有呼叫共用同一個失敗結果 | `.finally()` 清掉（上面示範） |
| 3 | **唔可以改變「每個 mount 都算讀過」嘅語義**：第二個 mount 可能拿唔到「新鮮」值 | 值本身一樣（同一店同一刻）＋ 有 cache（`hydrateFromCache`）＋ **realtime 仍係真源** ⇒ 無影響 |
| 4 | **`refreshFromLedger`（Ledger RPC）亦係同一 pattern** | 要一併 single-flight，否則只收一半 |
| 5 | **失敗靜默**：現時 catch 後靜靜用 cache；合併後要保留同一行為 | `.finally` 清 → 下次照試 |
| 6 | **唔可以用「快取 X 秒」取代**：合併（same-tick）安全，但「5 秒內唔拉」會改變語義 | 建議**只做 same-tick 合併**（single-flight），唔加時間窗；如要加窗，另議 |

**預期**：每次頁面載入 5 → **1**（−80%）；14 分鐘 13 → ~3。
`store-status` 一樣可以照做（3 → 1）。

---

## 3. 為何「冇操作都持續有呼叫」？正常嗎？

要分兩類，**只有第一類係正常**：

### A. 持續呼叫 ＝ **必須**（系統維持運作，屬正常）

| 呼叫 | 實測頻率 | 為何必須 |
|---|---|---|
| `print-agent/heartbeat` | **每 32 秒** | 中繼機 liveness（後台顯示在線／排障唯一證據） |
| `print-agent/claim` | **每 ~70 秒** | 拎待印工作；關店後仲要**重試 failed 單 ＋ 救回卡死單**（RPC 內 90 秒／6 分鐘窗口） |
| `pos/shift` | **每 180 秒** | 跨機班次對齊（另一部機開工／收工要跟得上） |

⇒ 呢三條係「部機著住就要做」嘅事，**唔係 bug**。但**頻率可以再低**（見 §4）。

### B. 唔應該持續／重複（可以收）

- **`online-order-settings` ×5、`store-status` ×3** —— 唔係「持續」，係**每次載入都重複**（herd）。
- **`topup/pending-count` 每 5 分鐘** —— 純為側欄一個紅點。
- ✅ **「每 36 秒一次嘅全量 state 拉取」已經修好**：38.8 分鐘只剩 **1 次**（之前 103 次／23 分鐘）。

### 判斷標準（可以照用）

一個呼叫只有符合以下**任一**情況，才應該「冇操作都持續」：
1. 佢係**外部裝置**嘅心跳（中繼機）
2. 佢係**另一個系統**嘅狀態對齊（班次／店舖開關）
3. 佢有**時效性**（出紙結果、對賬守護）

⇒ **純 UI 顯示**（badge、設定值、模板）**唔應該**持續拉 —— 應該由 realtime 或事件（打開相關頁／撳入去）驅動。

---

## 4. 優化方向與建議（按 ROI）

| # | 項目 | 現況 | 建議 | 預期 | 風險 | 要改 APK？ |
|---|---|---|---|---|---|---|
| **1** | **`online-order-settings` / `store-status` herd** | 每次載入 5＋3 次 | module 層 single-flight ＋ 單一 visibility listener（§2） | **−43% 總請求數**（每次載入 14 → 8） | 低（要按 storeId 分開） | ❌ |
| **2** | **print-agent heartbeat** | 73 次／38.8 min（**現時第一項**） | ① 服務端回應帶 `nextPollMs`（關店／夜間放慢到 2~3 分鐘）<br>② 或未配對／冇 job 時退避 | −40~70% | 中（`last_seen_at` 只作顯示；**UI 閾值 5 分鐘** ⇒ 上限 2~3 分鐘） | ✅ |
| **3** | `topup/pending-count` | 每 5 分鐘 | 改成「撳入會員／充值頁先拉」或 15 分鐘 | 29 → ~5／24 min | 低（紅點延遲） | ❌ |
| **4** | `pos/shift` | 每 180 秒（**關店／未開工都照拉**） | 未開工／已交班就唔拉（或 10 分鐘） | −60% | 低 | ❌ |
| **5** | `kiosk-settings` | 每次開頁 1 次 | 延後到真正開自助機模式 | −1／次載入 | 低 | ❌ |
| **6** | 對賬守護拉取 | 45 KB／次 | 已足夠（−99.4%）；**可選**：把 `ordersOnly+fields` 改行 RPC 精準核實 | 進一步 −30% | 低 | ❌ |

### 唔建議動（會影響正確性／即時性）
- `POST /api/pos/sync`（上雲命脈）
- `GET /api/pos/store-status` **本身**（開關店正確性 —— 只合併重複，唔可以省）
- Realtime 訂閱（即時性命脈；e.g. 收銀「秒級見單」）
- `print-agent/claim`（停咗就永遠唔出紙）

### 一句話總結
**egress 問題已經解決（−99.6%、現時約 6 MB／日）**；剩落嚟嘅係**請求數與架構效率**：
最值得做嘅係 **§2 嘅 herd 合併（一次改動、−43% 請求、零風險）**，
其次係 **print-agent 心跳放慢（要改 APK，但可以省掉現時最大一項）**。

---

## 5. ✅ 已合併嘅優化（2026-09-21 第三批）

> 商家要求：**先逐項確認「零功能影響」才改**。以下係逐項評估結果。

### 逐項功能影響評估

| # | 項目 | 判定 | 原因 |
|---|---|---|---|
| **1** | herd 合併（`online-order-settings` ＋ `store-status`） | ✅ **零功能影響 → 已做** | 只係「同一個 store、同一刻」嘅重複請求共用同一個 promise；**值一樣、時機一樣**，冇任何時間窗 |
| **2** | heartbeat 回應加 `nextPollMs` | ✅ **零功能影響 → 已做** | 加一個 JSON 欄位；**已查證 APK 源碼**（`RelayApi.kt` 用 `org.json` 嘅 `optBoolean`/`optString`，會忽略未知欄位，唔似 kotlinx.serialization 會 throw）⇒ 對現役 APK 零影響 |
| **3** | `topup/pending-count` 改「撳入會員頁先拉」 | ❌ **有功能影響 → 未做** | 側欄紅點本來就係「喺任何頁都見到有待審」；改成按需會令紅點唔再自動更新。而且實測 1.2/min 之中**大部分係用家切 tab 觸發**（唔係計時器）—— 收效低、影響明確 |
| **4** | `pos/shift` 關店／未開工唔拉 | ❌ **有功能影響 → 未做** | 呢個 180 秒輪詢嘅用途係**跨機班次對齊**（另一部機開工 → 本部機自動解鎖「開工」閘）。跳過之後，一部靜置嘅機要等到 `focus`／`online` 先追得上 ⇒ **開工閘延遲解鎖**（真人會有感） |
| **5** | `kiosk-settings` 延後 | ❌ **唔成立 → 未做** | 實測嗰個 `POST /api/pos/kiosk-settings` **唔係開頁觸發**，而係「入工作台」時 apply（`apply-workbench.ts`）；延後會令掃碼模式／kiosk 設定**唔同步上雲** |

### 實際改動

| 檔案 | 改動 |
|---|---|
| `src/lib/pos/single-flight.ts`（新，**零 import**） | `createSingleFlight<T>()`：同 key 同刻共用一個 promise；含「按 key 分開」＋「失敗要清（只清自己嗰條）」兩個死穴嘅處理 |
| `src/lib/pos/single-flight.test.ts`（新，10 條） | 5 個同時呼叫 → task 只跑 1 次；跨店唔共用；失敗之後可以再跑；**慢 flight 完成唔可以清走後來者嘅 flight** |
| `src/lib/pos/use-merchant-order-config.ts` | `refreshFromLedger` / `refreshMirror` 各自包 single-flight；`visibilitychange` 改成**模組層單一 listener** |
| `src/lib/pos/use-store-status.ts` | `refresh()` 包 single-flight；同樣收成**單一 listener** |
| `src/app/api/pos/print-agent/heartbeat/route.ts` | 回應加 `nextPollMs: 60_000`（預備接口，見上面 §2 限制） |

### 驗證（逐項對應「唔影響功能」）

| 檢查 | 結果 |
|---|---|
| `tsc --noEmit` | **0 error** |
| `node --test` | **939 passed / 0 failed**（929 ＋ 10 新） |
| 🔴 **真瀏覽器數請求**（`tools/verify-pos-request-count.cjs`，**新工具**） | **2/2 達標**：<br>· `online-order-settings`：開頁 **5 → 1**、切返前景 **5 → +1**<br>· `store-status`：開頁 **3 → 1**、切返前景 **3 → +1** |
| `tools/verify-pos-flows-live.cjs` | **17/17 ✅、有問題嘅頁面數 0** |
| `tools/verify-pos-api-contract.cjs` | **12/12**（含 print-agent 三個 POST → 503、唔可以 500） |

**「唔影響功能」嘅論證方式（三層）**：
1. **值等價**：single-flight 只合併「同一個 store、同一刻」嘅並發請求，所有呼叫端拿到**同一次讀取嘅結果**；
   失敗會 `.finally()` 清走 flight，所以「下次可以再試」嘅行為不變。
2. **時機等價**：**刻意唔加時間窗**（唔係「X 秒內唔拉」）⇒ 「幾時會讀到新值」完全不變。
3. **顯示等價**：兩個 hook 嘅 `setState`／`hydrateFromCache`／`refCount`／realtime 訂閱邏輯**一行都冇改**，
   只係改「喺邊度、發幾多次網絡請求」；而 17 路由流程測試 + 真瀏覽器截圖覆核過畫面照樣出。

### 未做嘅三項（#3/#4/#5）—— 唔係漏做

見上面評估表：三項都有**明確功能影響**，唔符合「零功能影響才改」嘅前提。
要推進就要先接受相應嘅行為改變（紅點唔自動更新 / 開工閘延遲解鎖 / kiosk 設定唔同步），
呢啲屬產品決策，建議另外拍板。
