# 即刻要做嘅事（2026-09-16 09:40 更新）

> 目標：令中繼機重新認領打印任務。
> **唔使改 Vercel env、唔使重裝 APK、唔使改任何代碼。**
> 次序好重要。

---

## 🔴 09:40 重大更新：唔止一間店、唔止一台機

按 `store_id` 掃 `pos_print_jobs`，發現 **DB 裡有三個 store，三台獨立中繼機，全部心跳都停咗**：

| store_id | 未完成 | 風險(<5) | agentId | **最後心跳** | 距今 |
|---|---|---|---|---|---|
| `d564b932-0c91-45e9-86fd-0ec8e2711f13` | 7 | 3 | `ag-0590816d…` | **09-16 08:30:34** | 68 分 |
| `f6ec837a-03d9-48f0-ae05-f1fbc3483221` | 8 | 4 | `ag-4d013eda…` | **09-16 01:31:06** | 488 分（8 小時） |
| `8291f843-9def-4956-9d0b-1cfef2598306` | 43 | 4 | `ag-302b8281…` | **09-15 14:24:37** | **1154 分（19 小時）** |

三個都 `paired:true` + `androidReady:true`（＝配對鏈路正常），但**心跳全部停咗**。

### ⚠️ 而「1138 分鐘前」講嘅唔係你嗰台機

`resolveStoreId()`（`sync-flush.ts:308`）＝ **iPad 登入 session 嘅 `merchantId`**。
你截圖嗰句「最後心跳 **1138** 分鐘前」：

| 候選 | 分鐘數 | 對得上？ |
|---|---|---|
| `8291f843…` | **1154** | ✅ **最接近**（差 16 分 = 截圖到你報告嘅時差） |
| `d564b932…` | 68 | ❌ |
| `f6ec837a…` | 488 | ❌ |

**⇒ 嗰個紅 banner 顯示嘅係 `8291f843…` 嗰台停咗 19 個鐘嘅機。**

---

## 第 0 步（🔴 必做）：確認 iPad 登入邊間店

**點解**：呢個決定你之後查邊台機。若 iPad 登入嘅店 ≠ 你實際用嘅中繼機嗰間店，
你就會一路睇住別店嘅狀態去 debug，永遠對唔上。

**做法**（二選一）：
1. iPad 上開 POS → 設定/帳號 → 睇登入嘅 merchant（或 `localStorage` 嘅 auth session）
2. 或直接在 iPad 瀏覽器 console 跑：
   ```js
   JSON.parse(localStorage.getItem("macau-pos-auth") || "{}").merchantId
   ```

**要對上嘅值**（三個之一）：`d564b932…` / `f6ec837a…` / `8291f843…`

> 💡 你截圖嗰句「1138 分鐘前」暗示 iPad 而家登入嘅係 **`8291f843-9def-4956-9d0b-1cfef2598306`**。

---

## 第 1 步：確認 sweep 狀態（唔使再跑，已知結果）

```sql
select public.pos_void_stale_print_jobs('d564b932-0c91-45e9-86fd-0ec8e2711f13');
-- → 0   ✅ 正常，唔係壞
```

**為何回 0**：函數（`0042:140-146`）只掃 `ttl is not null and ttl <= now` 嘅行。
你嗰 11 張風險單：**10 張 ttl 未過期、1 張 `ttl=NULL`**、**0 張 ttl 已過期** ⇒ 一張都唔符合。

⇒ **`ttl=NULL` 係 sweep 嘅盲區**（歷史遺留：`ttl` 只喺 insert 時寫，舊行恆 NULL）。
要清就只可以用 UPDATE 退路（見第 4 步）。

---

## 第 2 步：叫醒你嗰台中繼機（⚠️ 唔係重新配對）

**點解**：配對完全正常（`paired:true`、`GET /pair` 兩欄有值）。

1. 去商米，**把 App 切到前台**
2. 睇狀態欄：
   - 變 `運行中｜RT已連｜心跳0秒前｜…` ⇒ ✅ 搞定，跳去第 5 步
   - 仍然紅 / 冇反應 ⇒ 去第 3 步

> 💡 **唔需要**撳「配對」、**唔需要**填 storeId、**唔需要**改 Vercel。

---

## 第 3 步：切前台唔動 ⇒ 重啟 App

1. **完全殺掉 App**（最近任務 → 向上滑走）
2. **重新開啟**
3. 若仍然唔動：
   - Android **設定 → 應用程式 → 該 App → 電池 → 「不限制」**
   - 順便開「**自啟動**」

---

## 第 4 步（若有需要）：清 `ttl=NULL` 嘅殘留 job

**逐個 store 分開做，唔好一次過清三個。**

### 4a. 先睇（唯讀）
```sql
select store_id,
       created_at at time zone 'Asia/Macau' as 建單_澳門,
       status, attempts, ttl, printer_name,
       case when ttl is null then '⛔ sweep 盲區'
            when ttl <= (extract(epoch from now())*1000)::bigint then '可 sweep'
            else '✔ 仍有效' end as 分類
  from public.pos_print_jobs
 where store_id in ('d564b932-0c91-45e9-86fd-0ec8e2711f13',
                    'f6ec837a-03d9-48f0-ae05-f1fbc3483221',
                    '8291f843-9def-4956-9d0b-1cfef2598306')
   and finished_at is null
   and coalesce(attempts, 0) < 5
   and ttl is null                    -- ← 只清 sweep 掃唔到嘅
 order by store_id, created_at;
```

### 4b. 作廢（⚠️ 確認 4a 清單正確先跑）
```sql
update public.pos_print_jobs
   set status = 'failed', claimed_by = null, claimed_at = null,
       last_error = 'VOID_STALE: 人手作廢 ttl=NULL 殘留（2026-09-16 中斷排查）',
       updated_at = now()
 where finished_at is null
   and coalesce(attempts, 0) < 5
   and ttl is null
   and store_id = 'd564b932-0c91-45e9-86fd-0ec8e2711f13'   -- ← 逐個 store 換
   and created_at < now();
```

### 4c. 覆核（應回 0）
```sql
select count(*) from public.pos_print_jobs
 where finished_at is null and coalesce(attempts,0) < 5 and ttl is null;
```

> ⚠️ **唔好清仍在營運店嘅單**。另外兩間店（`f6ec837a` / `8291f843`）若已停用就唔理佢哋。

---

## 第 5 步：確認 Wi-Fi 同網段

**點解**：07:35 嘅錯誤 `failed to connect to /192.168.31.38 from /10.61.49.153`
—— 中繼機喺手機熱點（`10.61.x.x`），打唔到店內打印機（`192.168.31.x`）。

1. 商米 Wi-Fi **改連店內路由器**（要 `192.168.31.x`）
2. **關掉流動數據**

---

## 第 6 步：驗證

**逐個 store 打**（用你自己嗰個 storeId）：
```
https://macau-pos-system.vercel.app/api/pos/print-agent/pair-status?storeId=<你的storeId>
```
睇 `lastSeenAt` 有冇變成**現在**（1 分鐘內）。

**成功訊號**：
- App 狀態 = `運行中｜RT已連｜心跳 0 秒前｜…`
- 新 job：`pending` → `printing` → `printed`
- `/prints`：「雲端未認領」消失

---

## ⚠️ 今次唔使做嘅事

| 項目 | 點解唔使做 |
|---|---|
| 重新配對 / 填 storeId | ❌ 三個 store 都 `paired:true`、`/pair` 兩欄有值 |
| 改 Vercel env | ❌ 已實測有值 |
| 重裝 / 降級 APK | ❌ 版本冇問題 |
| 改 `POS_URL` | ❌ 有值 |
| 再跑 `pos_void_stale_print_jobs` | ❌ 已知回 0，佢掃唔到 `ttl=NULL` |

---

## 🔴 另外要留意

`POS_REQUIRE_DEVICE_AUTH` 已被設為 `0` ⇒ **API 鑑權閘全局關閉**。
**唔好即刻改返 `1`** —— 要先確認 iPad 能成功簽發 token，否則會即刻全站 401。

---

## 做完之後

- 若第 2 步成功 ⇒ 問題解決
- 若仍失敗 ⇒ 貼低：① 第 0 步查到嘅 merchantId ② App 狀態欄**完整**字串 ③ 實時 `pair-status` 嘅 `lastSeenAt`
- 若出紙仍失敗 ⇒ 貼低 `/prints` 嘅 `last_error` **原文**
