# P2 認領超時窗口：6 分鐘 vs 90 秒 —— 比較與最終選擇

> 日期：2026-09-15
> 前置：`docs/print-timeout-feasibility-2026-09-15.md`（P1–P4 整體方案）
> 用戶硬性要求：**無論揀邊個方案，都唔可以「重複出紙」**

---

## 0. 一句話結論

**揀「分段式」：同一部機（`claimed_by = p_agent_id`）6 分鐘；其他機（`claimed_by <> p_agent_id`）90 秒。**

純 6 分鐘同純 90 秒**兩者都唔可以單獨用**：
- 純 90 秒 → 中繼機正常但慢（串行印 5 張長單）時，**自己搶返自己嘅單** → 重複出紙。
- 純 6 分鐘 → 機真係死咗嘅時候，**冇人接手 6 分鐘**，但呢個係可用性問題，唔係重複出紙問題。

分段式同時滿足「唔重複出紙」＋「機死咗有人接手」。

---

## 1. 先講清楚：現行 SQL 有個真實嘅重複出紙漏洞

`0035_print_job_stale_claim_requeue.sql` 第 62 行：

```sql
-- 原本嘅「搶單保護」：同一部機認領中（60 秒內）唔可以被另一部搶走
and (j.claimed_by is null or j.claimed_at < now() - interval '60 seconds')
```

**呢句寫嘅意圖係「保護」，但實際效果係「60 秒後任何人都可以搶，包括原本嗰部機自己」。**
條件入面**完全冇比對 `j.claimed_by` 係唔係 `p_agent_id`** ⇒ 同一部機 60 秒後重新 claim 同一張單係合法的。

### 為咩會真出事（唔係理論）

`pos_claim_print_jobs` 一次過拎 `p_limit` 張（`claim/route.ts:30` 預設 5），然後 APK **串行**逐張印：

```
claim 5 張 → 印第 1 張（2 秒）→ 印第 2 張（3 秒）→ … → 印第 5 張
```

用到 60 秒嘅情境好現實：
- 收據機係熱敏 + 二維碼點陣（`qr` 欄），一張收據 render + 出紙可以 15–30 秒
- 5 張長單（大單廚房單分區 + 標籤）串行 = 60–120 秒
- 網絡慢（APK 用流動網絡回報 result）

⇒ 第 1 張 claim 咗 60 秒之後仲未回報，而 APK 啱好又 call 一次 claim（APK 有空閒輪詢）→ **同一部機完全合法地再拎返自己嗰張** → 印多次 → **重複出紙**。

> ⚠️ 呢個係現行 code 已存在嘅風險，**唔係 P2 引入嘅**。P2 正好要順手修埋。

---

## 2. 兩個純方案逐項比較

### 方案 A：一律 6 分鐘（唔區分邊部機）

```sql
and (j.claimed_by is null or j.claimed_at < now() - interval '6 minutes')
```

| 面向 | 評價 |
|---|---|
| 重複出紙 | ✅ **極難發生**。同一部機要 6 分鐘後仲喺度 claim 同一張，代表佢同時喺印第 6 分鐘——正常情況下 `attempts` 會先撞到上限，或 job 早已回報 |
| 機死咗接手 | ❌ **慢**。一部 Hub 死咗，另一部要**等足 6 分鐘**先接手。收銀高峯期客人等 6 分鐘先出廚房單 = 唔可接受 |
| 多機並存 | ⚠️ 兩部 Hub 同時運行時，failover 遲鈍 |
| 實作 | ✅ 最簡單（改一個 interval） |
| 誤判風險 | 低 |

### 方案 B：一律 90 秒

```sql
and (j.claimed_by is null or j.claimed_at < now() - interval '90 seconds')
```

| 面向 | 評價 |
|---|---|
| 重複出紙 | ❌ **會發生**（見 §1）。90 秒比現行 60 秒好少少，但長單 / 多張串行一樣會撞。**直接違反用戶硬性要求** |
| 機死咗接手 | ✅ 快（90 秒） |
| 誤判風險 | 高——「正常但慢」同「已經死」兩者用同一個 90 秒判準去判斷 |
| 實作 | 簡單 |

### 對照表

| | A：純 6 分鐘 | B：純 90 秒 |
|---|---|---|
| **會唔會重複出紙** | 幾乎唔會 ✅ | **會** ❌ |
| 機死咗幾時有人接手 | 6 分鐘 ❌ | 90 秒 ✅ |
| 長單 / 多張串行安全 | ✅ | ❌ |
| 符合用戶「唔想重複出紙」 | ✅ | ❌ |

**⇒ 兩個純方案都唔合格。** A 達唔到可用性，B 達唔到安全性。

---

## 3. 最終選擇：分段式（同機長、跨機短）

```sql
and (
  j.claimed_by is null
  -- 同一部機：俾足 6 分鐘佢印完（長單／多張串行），唔可以被自己重複拎
  or (j.claimed_by  = p_agent_id and j.claimed_at < now() - interval '6 minutes')
  -- 其他機：90 秒後可以接手（前者死咗／斷網），因為「唔係自己 claim」⇒ 冇重複出紙風險
  or (j.claimed_by <> p_agent_id and j.claimed_at < now() - interval '90 seconds')
)
```

### 為咩呢個同時解兩個問題

**① 唔重複出紙（用戶硬性要求）**

重複出紙嘅唯一來源係「同一張單被派去兩部機／同一部機兩次」。
- 同一部機：`j.claimed_by = p_agent_id` 分支要求 **6 分鐘**。而 APK 拎到單之後係**串行印**，
  印完一張即回報 result（成功 → `printed` 終態，永不再被 claim）。
  要觸發重複，就要「同一部機連續 6 分鐘冇回報任何 result 而又再 call claim」——
  正常運作下唔可能（APK 每張印完即回報）。
- 其他機：一定要 `j.claimed_by <> p_agent_id` 先可以搶。**原本 claim 嗰部機唔會因為呢個分支而重複拎到自己的單**。

**② 機死咗有人接手（可用性）**

Hub A 死咗 → Hub B 只要見到 `claimed_by = A`（唔等於自己）而且超過 90 秒 → 即刻接手，90 秒恢復出紙，唔使等 6 分鐘。

### 為咩唔係「同機 90 秒 + 跨機 6 分鐘」

反過來就係把兩個方案嘅缺點都拿到：自己 90 秒（會重複出紙）＋其他機 6 分鐘（接手慢）。明顯更差。

---

## 4. 但要留意：分段式仍未根治「兩部機同時開」嘅並發搶單

`for update skip locked` 保證同一 row 唔會同時被兩個 transaction 拎走，但**唔保證**「A 拎走之後 B 唔會喺 90 秒後拎」。

情境：
```
t=0     Hub A claim → claimed_by=A, status=printing, attempts=1
t=0     A 印出紙（物理上出咗一張）✅
t=5     A 嘅 result POST 失敗（網絡）→ 雲端仍 printing (claimed_by=A)
t=95    Hub B claim → claimed_by=A and A<>B and 95s>90s → B 接手 → 再印一張 ❌
```

⇒ **重複出紙**，但要注意：**呢個係「無法確認結果」導致嘅，唔係「判準太短」導致嘅**。
即使用 6 分鐘，一樣會喺 6 分鐘後發生。

### 真正嘅根治手段（P2 已一併納入）

1. **成功路徑 `attempts` 唔歸零 → 無法區分「從未成功」同「成功過但回報丟失」**
   → P2 一併在 `result` route 成功時寫 `attempts = 0`，並保留 `finished_at`。
   咁一來：已經 `finished_at IS NOT NULL` 嘅行，claim 條件要**額外排除**（見 §5）。
2. **`POS 端` 只認 `failed` 唔認 `pending`／`printing`** → 覆蓋成終態，UI 有紅標。
   （已於 `print-jobs/status` 的 `unfinished` 實作）
3. 呢一類「去重」最終仍要靠**中繼機側**嘅本地 jobId 去重（APK 已按 `job.id` 去重，
   `print-jobs.ts` 亦有 tombstone）——見 §6 遺留事項。

---

## 5. 一併修正：`base` 條件應該排除「已成功過」嘅行

現行 claim filter 只揀 `status in ('pending','failed','printing')`。
`printed` 唔會被揀 —— 呢點係好嘅。但 `finished_at` 一旦寫過而 `status` 又被改返 `pending`
（例如 `result` 收到重複的 failed 回報，或人工重試），就會有機會再印。

P2 一併加：

```sql
-- 已經成功出過紙嘅（finished_at 有值）永遠唔再 claim，
-- 除非係 print-center 明確嘅「人工重印」（走 P3 端點，會清 finished_at）
and j.finished_at is null
```

> 配合 P3：人工重試端點會 `set finished_at = null, attempts = 0, status = 'pending'`，
> 所以人工重印唔會被呢個條件擋死。

---

## 6. 最終 SQL（P2 定稿）

`pos_claim_print_jobs` 完整 replace（只改 where 條件，其餘不變）：

```sql
create or replace function public.pos_claim_print_jobs(
  p_store_id text,
  p_agent_id text,
  p_limit    int default 5
)
returns setof public.pos_print_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with picked as (
    select j.id
      from public.pos_print_jobs j
     where j.store_id = p_store_id
       and coalesce(j.attempts, 0) < 5
       and j.status in ('pending', 'failed', 'printing')
       -- 已經成功出過紙（finished_at 有值）→ 永遠唔再 claim（人工重印走 P3 端點清 finished_at）
       and j.finished_at is null
       -- stale printing 重排（原本 60s）
       and (
         j.status <> 'printing'
         or j.claimed_at is null
         or j.claimed_at < now() - interval '90 seconds'
       )
       -- ttl 過期唔好印
       and (j.ttl is null or j.ttl > (extract(epoch from now()) * 1000)::bigint)
       -- 🔴 P2 核心：分段式搶單保護（同機 6 分鐘 / 跨機 90 秒）
       and (
         j.claimed_by is null
         or (j.claimed_by  = p_agent_id and j.claimed_at < now() - interval '6 minutes')
         or (j.claimed_by <> p_agent_id and j.claimed_at < now() - interval '90 seconds')
       )
     order by j.created_at
     for update skip locked
     limit greatest(p_limit, 1)
  )
  update public.pos_print_jobs j
     set claimed_by  = p_agent_id,
         claimed_at  = now(),
         status      = 'printing',
         attempts    = coalesce(j.attempts, 0) + 1,
         updated_at  = now()
    from picked p
   where j.id = p.id
  returning j.*;
end;
$$;

revoke all on function public.pos_claim_print_jobs(text, text, int) from public, anon;
grant execute on function public.pos_claim_print_jobs(text, text, int) to service_role;
```

### 常數一覽

| 常數 | 值 | 用途 |
|---|---|---|
| 同機 reclaim 窗 | 6 分鐘 | 防止自己重複拎（長單／多張串行） |
| 跨機 takeover 窗 | 90 秒 | 機死咗快速接手 |
| stale `printing` 重排 | 90 秒 | 舊 0035 嘅 60 秒，配合跨機窗對齊 |
| `attempts` 上限 | 5 | 不變 |

---

## 7. 揀選理由總結（一頁）

1. **用戶嘅硬性要求係「唔重複出紙」**，所以「同一部機」嘅窗**一定要夠長**（6 分鐘）——
   90 秒對長單／多張串行係實測級別會撞嘅。
2. **但唔可以全局 6 分鐘**，因為中繼機死咗要 6 分鐘先有人接手，收銀場景唔可接受。
3. 分段式係唯一同時滿足兩者嘅做法：**「同一部機慢唔緊要，其他機快接手」**。
   - 同機 → 慢（6 分鐘），安全
   - 跨機 → 快（90 秒），好用
4. 順手修好現行 SQL 嘅真實漏洞（`0035:62` 未排除自己）。
5. 加 `finished_at is null` 令「已成功出紙」嘅行永遠退出搶單池。

**⇒ P2 = 分段式，確定採用，直接開始實作。**

---

## 8. 實作完成清單（2026-09-15）

| 項目 | 檔案 | 狀態 |
|---|---|---|
| P2 分段式 claim RPC + `finished_at is null` 守衛 | `supabase/migrations/0042_print_claim_window_segmented.sql` §A | ✅ 待跑 |
| P2 部分索引（`finished_at is null` + open status） | 同上 §B | ✅ 待跑 |
| P1 隔夜作廢 sweep function | 同上 §D | ✅ 待跑 |
| P1 `ttl` server 落章（`min(建單+12h, 當日 23:59)`） | `src/app/api/pos/sync/route.ts` | ✅ |
| P3 雲端人工重試端點（冪等） | `src/app/api/pos/print-jobs/retry/route.ts`（新增） | ✅ |
| P3 打印中心「重試打印」改打雲端 | `src/components/print-center.tsx` | ✅ |
| P4 失敗原因分類（純函式 + 10 個回歸測試） | `src/lib/pos/print-job-failure.ts` + `.test.ts`（新增） | ✅ 10/10 通過 |
| P4 status route 回原因碼 + 建議 | `src/app/api/pos/print-jobs/status/route.ts` | ✅ |
| P4 result route 寫 `AGENT_FAILED:` 前綴 + 成功清零 attempts | `src/app/api/pos/print-agent/result/route.ts` | ✅ |
| P4 打印中心警示橫幅顯示原因彙總 + 建議 | `src/components/print-center.tsx` | ✅ |

### 驗證結果

```
tsc --noEmit                     → CLEAN
eslint（全部改動檔案）            → 0 errors / 0 warnings
node --test print-job-failure    → 10 pass / 0 fail
```

### 未做 / 遺留

- **0042 migration 未跑**（要人手去 Supabase SQL Editor 貼）→ 跑之前，
  P1 寫嘅 `ttl` 係有值但 claim RPC 仲用舊條件；P2 分段式未生效；sweep function 唔存在
  （status route 已做 best-effort，唔會爆）。
- **APK 側 jobId 去重**未驗（屬 `print-agent-android` repo，見 docs/96）——
  呢層係「雲端窗口」以外嘅最後一道防線，建議一併確認。
- 中繼機「同時兩部開」時嘅 90 秒 takeover 仍可能重複出紙（§4）——
  根治要 APK 側先去重或以 `finished_at` 回報為準，屬下一階段。

