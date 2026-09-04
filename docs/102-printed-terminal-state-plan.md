# 102 · 引入 `printed` 終態 + 保留 reprint（根治 hub 重開重印）

> **一句講晒**：成功打印後把 server `pos_print_jobs.status` 由 `sent` 改為新終態 `printed`（RPC 只揀 `pending`/`failed`，`printed` 永唔會被 re-claim）；唯一重印途徑係 web 既有嘅 `reprintOrder`（已開新 job id）。零 APK 改動。

> **性質**：**根治性修復方案（Plan，未動手）**。關聯 `docs/101`（幂等 upsert，本 plan 嘅前置/替代）。本 plan 只覆蓋 macau-pos；salon 另案。

---

## 1. 點解「仲係重印」（先講清楚，否則 plan 冇意義）

Hub 印完 → `api.report(..., "sent", ...)`（JobRunner.kt:92-96）→ server `result/route.ts` 寫
`status='sent'` + `claimed_by=null`（result/route.ts:50-54）。RPC `pos_claim_print_jobs` 只揀
`status in ('pending','failed')`（0020:85）→ `sent` 理論唔會 re-claim。

但 web 喺 **reconnect / POS tab 重開 / 30s flush** 會重推 `PRINT_JOB_CREATED`（payload `status:'pending'`）：
- 舊 `upsert(onConflict:"id")` = `ON CONFLICT DO UPDATE SET` 全欄照寫 → 把 `sent` 打回 `pending` →
  hub 重開 30s tick 一把 claim 晒 → 重印。（即 docs/101 講嘅 (b) 路徑。）

**我嘅 docs/101 冪等修法正正殺咗呢條重推路徑，但佢喺 web 服務端、要 deploy 先生效。**
你之前應該只 rebuild 咗 `print-relay` APK（APK 唔含呢段 server code）→ 所以「還是一樣」。

本 plan 喺 docs/101 之上加 `printed` 終態：語意更準（物理印到 vs 只係 hub 回報 `sent`），
亦令「冪等保護」更直觀。兩者分開都做得。

## 2. 設計

- **成功** → hub 照舊報 `sent` → server `result` route 翻譯做 `status='printed'`（終態）。
- **RPC** 只揀 `pending`/`failed` → `printed` 永唔會被 re-claim（唔使改 RPC，因為根本唔喺揀選集）。
- **重推 `PRINT_JOB_CREATED`**（docs/101 冪等 update）→ 唔碰 `status` → `printed` 單永唔會被打回 `pending`。
- **`reprintOrder`**（pos-app.tsx:2110 / print-center.tsx:440）→ 已經用 `buildKitchenPrintJobs`/`buildLabelPrintJobs`
  開**新 job id** 再 push `PRINT_JOB_CREATED` → insert 新 `pending` → hub 印。與 `printed` 終態完全兼容，
  **係唯一重印途徑**，plan 唔使改佢。

## 3. 改動清單（全 web，APK 零改動）

| # | 檔 | 改動 |
|---|---|---|
| 1 | `src/lib/types.ts:625` | `PrintJobStatus` 聯合型加 `"printed"`：`"pending" \| "sent" \| "printed" \| "failed"` |
| 2 | `src/app/api/pos/print-agent/result/route.ts:50-51` | `patch.status = "sent"` → `"printed"`（其餘 `finished_at`/`last_error=null`/`claimed_by=null` 唔變） |
| 3 | `src/app/api/pos/sync/route.ts`（docs/101 已改） | 確保 `PRINT_JOB_CREATED` 冪等 update **唔碰 status**（確認已 deploy） |
| 4 | `src/app/api/pos/print-jobs/status/route.ts:24,35` | 輪詢 `in("status",["sent","failed"])` → `["printed","failed"]`；回傳型別加 `"printed"` |
| 5 | `src/components/print-center.tsx` | UI 顯示：`job.status === "sent"` 處補 `\|\| job.status === "printed"`（137/415/429-432/792/799/832/894），文案「已發送」可保留或改「已打印」；filter 下拉（744）加 `printed` |
| 6 | `src/lib/print-jobs.ts:414,435,438` | 「清除已發送」過濾：`j.status !== "sent"` → `!== "sent" && !== "printed"`（否則 printed 單清唔走） |
| 7 | `src/lib/pos/print-job-merge.ts` | 本地 merge 以本地為真源（line 29「本地有就用本地」），`printed` 加進聯合型後自然當終態；補一句註釋 |
| 8 | `src/lib/pos/print-job-merge.test.ts` | 聯合型加 `"printed"`；加 1 個 `printed` 當終態唔被覆寫嘅 case |

### 唔使改（重要）
- `pos_claim_print_jobs` RPC（0020:85）：已經只揀 `pending`/`failed`，`printed` 自然排除。
- `print-relay` APK（Hub）：`report` 照舊送 `"sent"`，零改動 → **唔使重 build APK**。
- 本地 dispatch 嘅 `sent`（dispatch.ts:75 / companion.ts:634 / hub.ts:76）係**本地** status，同 server `pos_print_jobs.status` 無關，唔使動。
- `reprintOrder`：唔使改（開新 id）。
- salon：另案。`salon/print.ts:290 reprintSalonJob` 重用同一 job id，若要做 `printed` 要一併改 salon claim RPC + reprint 開新 id。

## 4. 最小替代方案（想快啲止血）
只 deploy docs/101 嘅 `sync/route.ts` 冪等修法（唔改名 `sent`→`printed`）已經能止重印；`printed` 係語意強化。
建議：先 deploy docs/101 止血 → 再按本 plan 加 `printed`。

## 5. 部署 & 驗收
### 5.1 部署順序
1. deploy `sync/route.ts`（docs/101 冪等）← 止血
2. deploy 本 plan 嘅 1–8 改動（加 `printed`）

### 5.2 驗收 SQL（deploy 後）
```sql
-- 印一張單 → 正常唔會再重印；確認 status 落 printed
select id, status, claimed_by, finished_at
from pos_print_jobs where order_id = '<order_id>' order by created_at;
-- 預期：status='printed'，claimed_by=null
-- 重開 hub 多次 → 唔會再爆印呢張
-- 按「重打整單」→ 出現新 id 嘅 pending 單，hub 印出，舊單仍 printed
```

### 5.3 本地聯調
`npm run dev` → 落單印 → 重開 POS tab → 睇 Network `POST /api/pos/sync` 嘅 `PRINT_JOB_CREATED`
冇再把舊單 status 打回 `pending`（server 端 log 無 `update` status 動作）。
