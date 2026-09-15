# 打印超時機制 —— 可行性評估與實作方向（2026-09-15）

> **提案**：打印持續超過 6 分鐘仍未完成 → 標記「失敗」並停止繼續補打印；另提供手動「重試打印」。
> **評估結論**：**方向正確、可行，但提案只覆蓋了一半**。必須拆成兩個獨立的計時器，且手動重試必須補上「雲端側」實作，否則會出現「顯示已重新送出、但一張紙都唔出」的靜默失敗。
> **關聯**：[`incident-2026-09-15-print-outage.md`](./incident-2026-09-15-print-outage.md)、[`decisions-2026-09-15.md`](./decisions-2026-09-15.md)

---

## 一、可行性結論

| 判斷 | 內容 |
|---|---|
| **技術可行性** | ✅ 可行。所需欄位（`created_at` / `claimed_at` / `attempts` / `status` / `ttl`）**全部已存在**，`pos_claim_print_jobs` 已有相關守衛骨架，不需要改表結構 |
| **提案完整性** | ⚠️ **只覆蓋一半**。「打印超時」只對「**已被認領但冇回報**」有效；對「**從來冇被認領**」（Hub 離線）完全無效 |
| **與今日事故的關係** | 🔴 **今日 58 張積壓，這個提案一張都救唔到** —— 它們全部 `attempts = 0`、`claimed_at = NULL`，即從來冇進入「打印中」，所以冇任何計時器會觸發 |
| **建議** | 拆成 **計時器 A（建立 → 認領）** 與 **計時器 B（認領 → 回報）**，並補一個**雲端側的手動重試**。詳見第六、七節 |

---

## 二、現有機制盤點（避免重複造輪子，並指出死碼）

| 機制 | 位置 | 現況 | 判定 |
|---|---|---|---|
| **重試上限** | `0035:50` `coalesce(attempts,0) < 5` | ✅ 生效 | 「無限重印」其實**已有上限**（最多 5 次）。提案想解決的「無限打印」並唔存在，存在嘅係「**印出嚟嘅係幾日前嘅紙**」 |
| **`printing` 卡死重排** | `0035:54-58` `claimed_at < now() - interval '60 seconds'` | ✅ 生效 | **已有 60 秒超時**。提案的 6 分鐘 = 把這個值由 60 秒放寬到 360 秒 |
| **`ttl` 過期守衛** | `0035:60` `(j.ttl is null or j.ttl > now_ms)` | 🔴 **死碼** | `ttl` 只在 `types.ts:1399` 有型別宣告；**`sync/route.ts`、`result`、`claim`、`print-jobs.ts` 全部零寫入** ⇒ 恆為 NULL ⇒ 守衛永遠成立 |
| **`failed` → `pending` 回復** | `print-agent/result`（`attempts < 5`） | ✅ 生效 | 只適用於「Hub 回報失敗」 |
| **手動「重試打印」** | `print-center.tsx:1884` → `dispatch.ts:101 retryFailedPrintJob()` | ⚠️ **只改本機** | 只寫 localStorage 的 `print-jobs` 然後 `flushPendingPrintJobs()`。**不會動雲端 `pos_print_jobs` 的 `status` / `attempts`** |
| **手動「重打整單」** | `print-center` / `pos-app` | ✅ 有效 | 建立**新 job id** ⇒ 新雲端 row ⇒ 可被 claim |
| **claim 搶單保護** | `0035:62` `claimed_by is null or claimed_at < now() - 60s` | ⚠️ 有隱患 | 見 §五.2（同一部機自己都可搶自己） |

### 🔴 由此得出的兩個關鍵缺口

**缺口 1：提案對「從來冇被認領」無效。**
今日 58 張全部 `attempts = 0`、`claimed_at IS NULL`。冇任何計時器會觸發它們，因為它們從未進入 `printing`。
⇒ 這一類要靠 **`ttl`（建立時間 + 上限）** 或「營業日」來封頂，唔係靠 6 分鐘。

**缺口 2：現有「重試打印」無法復活雲端已終態的 row。**
`retryFailedPrintJob()` 只改本機。若雲端 row 係 `failed` 且 `attempts >= 5`（或已被作廢），Hub **永遠唔會再 claim 到佢**。
⇒ 按鈕會因為本機 job 變成 `sent` 而顯示 **「已重新送出打印」**，但一張紙都唔出 —— **靜默失敗，而且提示係錯的**。
⇒ 這是現存缺陷，也是您提案「手動重試」必須一併修的地方。

---

## 三、提案的優點

1. **方向對**：把「60 秒」放寬到「6 分鐘」**會減少重複出紙**（見 §五.2），比現狀更安全。
2. **欄位齊備**：`created_at` / `claimed_at` / `attempts` 已存在，唔使加欄、唔使改三端。
3. **手動重試 = 有意識的動作**：比自動無限重試更符合「廚房唔想收到過期紙」的直覺。
4. **可審計**：保留 row、寫明原因，事後查得到。

---

## 四、缺點與風險

| # | 風險 | 說明 | 嚴重度 |
|---|---|---|---|
| R1 | **對「未認領」無效** | 如 §二.缺口 1。今日事故屬此類 | 🔴 高 |
| R2 | **誤判（把正在印判成失敗）** | 6 分鐘是**猜的**。`p_limit` 預設一次 claim 5 張，串行打印 5 張長單（每張 30–60 秒）可能貼近甚至超過 6 分鐘；再加上中繼機在流動網絡上報 result 的延遲 ⇒ 會出現「紙已出、狀態變失敗」 | 🔴 高 |
| R3 | **重試衝突 → 重複出紙** | 若把 `printing` 判失敗後，Hub 其實仍持有舊 job 並稍後回報成功；或操作者手動重試而 Hub 正在印 ⇒ 同一張單出兩次 | 🔴 高 |
| R4 | **打印中斷無感** | 6 分鐘後標失敗並停止 ⇒ 廚房**永遠收唔到該張單**（唔會自動補）。若冇告警，等於靜默漏單 | 🔴 高 |
| R5 | **操作者反覆按重試** | 因為按鈕提示是「已重新送出」（§缺口 2），操作者會不斷按，反而製造更多 job | 🟠 中 |
| R6 | **6 分鐘 vs 60 秒的取捨** | 放寬到 6 分鐘 ⇒ 真正卡死的單**恢復延遲由 1 分鐘變 6 分鐘**。繁忙時段 6 分鐘 = 幾十張單堆住 | 🟠 中 |
| R7 | **`ttl` 語意陷阱** | `ttl` 是**絕對 epoch ms 期限**，不是時長。若誤寫成 `360000`（時長）⇒ 全部 job 立即「已過期」⇒ **完全唔出紙且靜默** | 🔴 高（實作陷阱） |
| R8 | **客戶端計時器不可靠** | 若把計時器放在瀏覽器（`pos-app` / `print-center`），收銀機關掉／休眠就唔會執行 ⇒ 必須放**伺服器端** | 🔴 高 |

---

## 五、深入分析：兩個容易被忽略的既有問題

### 5.1 現在的 60 秒反而**更容易**造成重複出紙

`pos_claim_print_jobs` 的搶單保護（`0035:62`）：

```sql
and (j.claimed_by is null or j.claimed_at < now() - interval '60 seconds')
```

**同一個 agent 都可以搶回自己 60 秒前 claim 的 job**（因為條件只比較時間，冇排除 `claimed_by = p_agent_id`）。
⇒ 如果一張廚房單實體打印需要 > 60 秒（長單、慢機、缺紙後補紙），Hub 下一輪 claim（約每 30–60 秒一次）就會**再claim同一張並再印一次**，最多 5 次（`attempts < 5`）。

**⇒ 這可能是「同一張單出咗幾張紙」的其中一個來源。**

**改進**：對**同一個 agent** 用長 timeout（例如 6 分鐘），對**其他 agent** 用短 takeover（例如 60–90 秒，這是「換機／failover」場景）：

```sql
and (
  j.claimed_by is null
  or (j.claimed_by = p_agent_id  and j.claimed_at < now() - interval '6 minutes')
  or (j.claimed_by <> p_agent_id and j.claimed_at < now() - interval '90 seconds')
)
```

呢個寫法**同時**滿足「唔好重複印」同「另一部機死咗要有人接手」。

### 5.2 「停止繼續補打印」其實有兩層意思

| 層次 | 現況 | 需要 |
|---|---|---|
| 停止「同一張單反覆重試」 | ✅ 已有（`attempts < 5`） | 保留 |
| 停止「印出過期嘅紙」 | 🔴 **完全冇**（`ttl` 死碼） | **`ttl` 或營業日 cutoff** |

⇒ 提案的「停止無限打印」若指第二層，**必須靠 `ttl`／營業日**，6 分鐘幫唔到。

---

## 六、改進建議

| # | 建議 | 解決 |
|---|---|---|
| **1** | **拆成三個獨立計時器**（見 §七.1），每個有自己的參數與語意 | R1 / R2 / R6 |
| **2** | **`ttl` 落地**：建立 job 時由 **server 端**寫 `ttl = created_at_ms + N`（決策已定 12 小時，可配置） | R1 / R7 |
| **3** | **加「同營業日」過濾**（澳門 04:00 為日界）作為第二道閘 | R1 |
| **4** | **同 agent 用長 timeout、其他 agent 用短 takeover**（§5.1） | R3 |
| **5** | **手動重試必須有雲端側**（新端點或 RPC），並在**同一個原子操作**裡重置 `status='pending'` + `attempts=0` + 清 `claimed_by/claimed_at` + 清 `last_error` | R5 / 缺口 2 |
| **6** | **重試要冪等 + 去重**：重試前檢查該 job 是否已 `printed`（已出紙就唔准重試，只准「重打整單」建新 id） | R3 |
| **7** | **失敗原因要可區分**：`last_error` 用固定前綴（`TIMEOUT_CLAIM` / `TIMEOUT_STALE` / `VOID_STALE` / `AGENT_FAILED`）⇒ UI 可以分開顯示、統計 | R4 / R5 |
| **8** | **必須有告警**：超時失敗 / 積壓 > N 張 → 收銀台可見（今日事故拖 4 日的直接原因是只有 `/prints` 頁有 banner） | R4 |
| **9** | **紙面標記**：重試出紙的單據加「重印」字樣，廚房一眼分辨 | R3 |
| **10** | **唔好刪 row**：一律改狀態、保留審計 | — |
| **11** | **參數可配置**（per store），唔好硬編 6 分鐘 | R2 / R6 |

---

## 七、建議實作方向與關鍵邏輯

### 7.1 三個計時器（核心設計）

| 計時器 | 起點 | 建議值 | 觸發後 | 對應今日事故 |
|---|---|---|---|---|
| **A. 未認領上限** | `created_at` | **12 小時**（或同營業日）→ 寫入 `ttl` | `failed` + `last_error='TIMEOUT_STALE'`，永不再 claim | ✅ 正是今日 58 張的成因 |
| **B. 認領→回報超時** | `claimed_at` | **6 分鐘**（同 agent）／**90 秒**（其他 agent takeover） | 回到 `pending`（可再試）或 `failed`（超過 `attempts`） | ❌ 與今日無關 |
| **C. 重試上限** | `attempts` | **5 次**（維持現狀） | 永久 `failed`，只可人手重試 | — |

> **您提案的「6 分鐘」= 計時器 B。它解決的是「印唔出但卡住」，唔係「冇人印」。**

### 7.2 實作位置：**必須在伺服器端**

❌ 不要放在瀏覽器（收銀機關機就唔會執行）。
✅ 兩個可行做法，**建議兩者都做**：

**(a) Lazy sweep（零基建，首選）**
在 `pos_claim_print_jobs` 開頭先做一次過期掃描，然後才挑單。Hub 每 30–60 秒 call 一次 ⇒ 順帶清掃，成本極低。

```sql
-- 概念（唔係最終版）
update public.pos_print_jobs
   set status = 'failed',
       attempts = 5,                       -- 令 attempts < 5 不成立 ⇒ 永久唔再被 claim
       last_error = 'TIMEOUT_STALE：超過上限仍未出紙',
       updated_at = now()
 where status in ('pending','printing')
   and coalesce(attempts,0) < 5
   and (
     -- A：從未認領且已過絕對期限
     (status = 'pending' and ttl is not null and ttl <= (extract(epoch from now())*1000)::bigint)
     -- B2：已認領但超過超時（其他 agent 已可接管，呢度只作終局標記）
     or (status = 'printing' and claimed_at < now() - interval '6 minutes'
         and coalesce(attempts,0) >= 5)
   );
```

> ⚠️ 注意 `ttl` 是 **epoch ms**：寫入時 `ttl = (extract(epoch from created_at)*1000)::bigint + 12*3600*1000`。

**(b) pg_cron 定時掃描（可選加碼）**
即使冇 Hub 都定期清掃。需要 `pg_cron` extension。好處是 Hub 長期離線時也有狀態收斂。

### 7.3 手動重試：需要一個新的雲端端點

現有 `retryFailedPrintJob()` **只改本機**（缺口 2）。建議新增：

```
POST /api/pos/print-jobs/retry      （走 posRouteAuthGuard，綁店）
body: { storeId, jobId }
```

**關鍵邏輯（冪等 + 安全）**：

1. 先讀該 row（service_role）。
2. **若 `status = 'printed'` ⇒ 拒絕**（已出紙，唔准重試；提示改用「重打整單」建新 job）。
3. **若 row 屬於其他店 ⇒ 拒絕**（`store_id` 必須等於請求的 storeId）。
4. 原子重置：
   ```sql
   update public.pos_print_jobs
      set status = 'pending', attempts = 0,
          claimed_by = null, claimed_at = null,
          last_error = null, updated_at = now()
    where id = $1 and store_id = $2 and status <> 'printed';
   ```
5. **同時**重置本機 job（呼叫現有 `retryFailedPrintJob()`），否則本機仍顯示舊狀態。
6. 前端把按鈕文案由「已重新送出打印」改為**讀雲端回執**再講成功／失敗 —— 唔可以再靠本機 `sent` 推斷。

**並發保護**：兩個操作者同時按 ⇒ `status <> 'printed'` 條件 + 單一 `update` 已是原子的；再加 `attempts = 0` 重置會令 Hub 可以即刻 claim。若想更保守，可加 `retry_count` 欄並限制每張單最多重試 K 次。

### 7.4 「重試」與「重打整單」的分工（建議寫入 UI 文案）

| 動作 | 語意 | 何時用 |
|---|---|---|
| **重試打印** | **同一張 job** 再送一次（雲端 row 重置） | 確認從未出紙（例如 Hub 離線期間積壓） |
| **重打整單** | **建立新 job**（新 id） | 已出紙但紙張遺失／需要補一份給客人 |

> 兩者都應該在紙面上有可分辨標記（§六.9）。

### 7.5 分階段落地建議

| 階段 | 內容 | 風險 |
|---|---|---|
| **P1** | `ttl` 落地（計時器 A）+ 「同營業日」過濾 → **這一步就解決今日事故** | 低（純新增欄位寫入 + 放寬 claim 條件） |
| **P2** | `printing` 超時改為「同 agent 6 分鐘／其他 agent 90 秒」（§5.1）→ 減少重複出紙 | 低（只改 claim 條件） |
| **P3** | 雲端手動重試端點 + 前端文案修正（§7.3） | 中（新端點 + 前端） |
| **P4** | 告警（超時/積壓 → 收銀台可見）+ 失敗原因分類顯示 | 中（UI） |

### 7.6 驗收標準

- ⬜ 建立一張 job 後，`ttl` 有值且為 `created_at_ms + 12h`（唔係時長）。
- ⬜ 模擬 Hub 離線 13 小時 ⇒ 該 job 自動變 `failed`，Hub 上線後 `pos_claim_print_jobs` 回 **0 張**。
- ⬜ 一張長單打印 90 秒 ⇒ **唔會**被同一 agent 重複 claim。
- ⬜ 對 `printed` 的 job 呼叫重試端點 ⇒ **拒絕**（4xx），唔會重複出紙。
- ⬜ 手動重試成功後，雲端 row 變 `pending` 且 `attempts = 0`，Hub 下一次 claim 拎得到。
- ⬜ 前端提示以**雲端回執**為準，唔可以再出現「顯示已送出但冇紙」。

---

## 八、一句話總結

> **可行，但要把「6 分鐘」重新定位**：它屬於「已認領未回報」的 watchdog，而今日 58 張的真正成因是「從未被認領」——後者要靠 `ttl`／營業日。
> 另外，您要求的「手動重試」目前**只存在於本機**，必須補一個綁店的雲端端點並做成冪等，否則會繼續出現「提示成功但唔出紙」。
> 建議次序：**P1（`ttl` + 營業日）→ P2（claim 超時分段）→ P3（雲端重試端點）→ P4（告警）**。
> 其中 **P1 就是今日事故的根治**，其餘是穩健性加碼。
