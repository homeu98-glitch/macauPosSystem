# 交接 · Print-Relay 側「打印成功」兩級狀態實作指引

> **日期**：2026-09-07
> **對象**：`print-relay` 團隊（Android Hub APK / Desktop Companion / Cloud Relay 同事）
> **配套（web 側已完成）**：`docs/102-printed-terminal-state-plan.md`（server `printed` 終態設計）
> **相關**：`docs/98`（中繼排查）、`docs/96`（Sunmi relay 規格）、`docs/46`（cloud relay 骨架）
>
> **本文目標**：web 側已經完成「已發送 / 打印成功」兩級狀態 UI（見 §6 改動清單）。
> 本文列出 **print-relay 這一側** 需要確認／完成的改動，使「打印成功」代表**真實出紙**，
> 而非「POS 已把資料交給 relay」。同事可按本文件獨立修改，唔使等 web 側。

---

## 0. 一句講晒

Web 已經分得開「**已發送**」（POS 把任務交給打印通道）同「**打印成功**」（打印通道確認真實出紙）。
Relay 側要做嘅，係**保證回報 `printed` 之前真係印到紙、回報 `failed` 時真係印唔到**（例如打印機未連線就要報 `failed`，唔好唔報導致 web 永遠顯示「已發送」）。
**agent 回報合約本身唔使改**（沿用 `docs/102` 的 `sent`=`Hub 印到` 語義，server 會翻譯成 DB `printed`）。

---

## 1. 現狀數據流（Web ↔ Relay 全貌）

```
┌────────────┐   PRINT_JOB_CREATED    ┌──────────────────┐
│  Web POS   │ ───(sync queue)──────▶ │  pos_print_jobs  │   status: pending
│ (dispatch) │                        │   (Supabase)     │
└────────────┘                        └────────┬─────────┘
      │ local status = "sent"                   │ Realtime / claim RPC
      │ (＝「已發送」: POS 已交 relay)            ▼
      │                                  ┌──────────────────┐
      │                                  │  Relay Agent     │  pos_claim_print_jobs()
      │                                  │ (APK/Companion)  │  → status: printing
      │                                  └────────┬─────────┘
      │                                           │ 真實出紙 / 失敗
      │                                           ▼
      │                                  POST /api/pos/print-agent/result
      │                                  { jobId, status: "printed" | "failed" }
      │                                           │
      │                                           ▼
      │                                  pos_print_jobs.status = "printed" | "failed"
      │                                           │
      │  ◀── GET /api/pos/print-jobs/status ───────┘  (web 每 8s 輪詢 + Realtime)
      │       回填本地 PrintJob.status             
      │                                           
      ▼                                           
  local status: "printed"(打印成功) / "failed"(失敗) / 維持 "sent"(已發送)
```

**兩級狀態語義（最終對外）**：

| 顯示 | 本地/DB 狀態 | 含義 | 由邊個設定 |
|---|---|---|---|
| **已發送** | 本地 `sent` | POS 已把任務交付打印通道（native / companion / relay），**不代表出紙** | Web `dispatch.ts` 派發後即設 |
| **打印成功** | DB `printed` → 回填本地 `printed` | 打印通道（APK/agent）**真實出紙成功**後回報的終態 | Relay agent 回報 `printed`，server 寫入 |
| **失敗** | DB `failed` → 回填本地 `failed` | 打印通道回報失敗（打印機未連線／夾紙／IO 錯） | Relay agent 回報 `failed` |
| **待補傳** | 本地 `pending` | 仲未派發（離線緩衝中） | Web dispatch 前 |

---

## 2. Relay 側需要完成的改動（核心）

### 2.1 行為要求（最重要）

1. **真實出紙確認後才報 `printed`**
   - 唔好喺「把 ESC/POS 字節丟落 socket／藍牙／USB 就即報 `printed`」。
   - 要先確認打印機**真係出咗紙**：例如發送後查打印機 realtime status（DLE EOT）、
     或等 OS 打印管理器嘅「作業完成」回調、或 USB/BT 通道返回成功 ACK。
   - 若某傳輸係純 fire-and-forget（冇 ACK），請喺該通道註明「打印成功」只係 best-effort（資料已送達），
     並盡可能加一次 status query 驗證。

2. **失敗必須可靠回報 `failed`**
   - 打印機未連線、夾紙、缺紙、IO 超時、驅動拋錯 —— **全部要報 `failed` 並帶 `error` 原因**。
   - **呢點直接解決 web 側「打印機未連線仍顯示已發送」嘅投訴**：若 agent 印唔到又唔報 `failed`，
     DB 會停在 `pending`/`printing`，web 本地 `sent` 就永遠顯示「已發送」，用家以為印咗。
   - 重試上限內（`attempts < 5`）server 會把 `failed` 打回 `pending` 俾其他 agent 接手；
     超過 5 次才落 `failed` 終態（見 §4）。

3. **冇改 agent 回報合約的必要**
   - 沿用 `docs/102` 設計：agent 成功印到 → 報 `sent`（server `result` route 會翻譯成 DB `printed`）。
   - **注意**：server 目前把 agent `sent` 同 `printed` 都視為成功終態（寫 DB `printed`）。
     所以 agent **報 `sent` 即等於 web 顯示「打印成功」**。呢個語義要 relay 同事知：
     agent 報 `sent` 之前，必須係「真印到」（對齊 2.1.1），否則 web 會顯示假嘅「打印成功」。

### 2.2 可選增強（更細緻嘅中間態，需與 web 協調）

若想 web 再分多一級「**已交給打印機驅動、未確認出紙**」，可以：
- agent 報 `sent` = 已交驅動（handoff）；
- agent 報 `printed` = 確認出紙（confirmed）。
- **但呢個需要 web 側同步改 `result` route（agent `sent`→DB `sent` 而非 `printed`）+ 輪詢 route 加回 `sent`）**。
  屬於協調改動，**唔係本次必需**。本次只要做好 2.1 嘅「真實確認才報成功 + 失敗必報 `failed`」就得。

---

## 3. 涉及介面 / 欄位

### 3.1 agent → server 回報介面（relay 側主要呼叫點）

**`POST /api/pos/print-agent/result`**

| 項 | 說明 |
|---|---|
| 認證 | Header `x-agent-id` + `x-agent-token`（server `verifyAgent` 驗證，且會核對 `claimed_by` 防冒充） |
| Body | `{ "jobId": string, "status": "sent" \| "printed" \| "failed", "error"?: string }` |
| 成功回應 | `200 { "ok": true }` |
| server 行為 | `sent`/`printed` → `pos_print_jobs.status='printed'`, `finished_at=now()`, `last_error=null`, `claimed_by=null`（釋放）<br>`failed` → `attempts<5` 時 `status='pending'`,`claimed_by=null`（可重領）；否則 `status='failed'`，`last_error=error`(截 300 字) |

> relay 同事只需確保**喺正確時機 call 呢支 API**，並傳入正確嘅 `status`。

### 3.2 server → web 輪詢介面（relay 唔使 call，但要知道語義）

**`GET /api/pos/print-jobs/status?storeId=xxx`** → 回 `[{ id, status: "printed"|"failed", lastError }]`
（只回終態 `printed`/`failed`；`pending`/`printing` 唔回，web 本地維持「已發送」）。

### 3.3 `pos_print_jobs` 關鍵欄位（relay 回報時 server 會寫）

| 欄位 | 類型 | 用途 |
|---|---|---|
| `id` | text (PK) | job id，agent 回報用 `jobId` |
| `store_id` | text | 隔離用，agent 只會 claim 自己 store |
| `status` | text | `pending`→`printing`→`printed`/`failed`（終態） |
| `claimed_by` | text | 認領嘅 agent_id；`printed`/`failed` 後置 null |
| `claimed_at` | timestamptz | 認領時間；`claimed_at < now()-60s` 可被其他 agent 接手 |
| `attempts` | int | 重試次數；`<5` 先會被 re-claim |
| `last_error` | text | `failed` 時記失敗原因（展示畀用家） |
| `finished_at` | timestamptz | 成功出紙時間 |
| `ttl` | bigint (epoch ms) | 過期唔印（避免隔夜單突然出紙） |

---

## 4. 資料流轉邏輯（原子 claim，防重印）

`pos_claim_print_jobs(store_id, agent_id, limit)`（migration `0020_print_relay.sql`）：

```sql
where j.status in ('pending', 'failed')      -- 只揀呢兩個，printed/printing 唔會 re-claim
  and coalesce(j.attempts,0) < 5
  and (claimed_by is null or claimed_at < now() - interval '60 seconds')  -- 死機 60s 後接手
order by created_at
for update skip locked                      -- 兩部 agent 同時收事件，第二部 skip → 物理唔重印
-- → 設 status='printing', attempts+1, claimed_by=agent_id
```

**關鍵保障**：`printed` 唔在 claim 揀選集 → 印完嘅單**永遠唔會被重印**。`sent`/`printed` 對 agent 嚟講都係成功終態（server 落 `printed`），所以 agent 唔使區分「handoff 定 confirmed」來避免重印——只要成功就報 `sent`/`printed`，失敗就報 `failed`。

---

## 5. 與其他模組的依賴關係

| 模組 | 位置 | 依賴關係 |
|---|---|---|
| **Web dispatch** | `src/lib/print-bridge/dispatch.ts` | 派發後設本地 `sent`（＝「已發送」）。relay 回報唔影響呢層。 |
| **Web 輪詢回填** | `src/components/print-center.tsx` `syncCloudPrintOutcomes` | 每 8s 拉 `/print-jobs/status`，把 DB `printed`→本地 `printed`、DB `failed`→本地 `failed`。**已實作，relay 唔使理。** |
| **Web Realtime** | `src/lib/pos/use-pos-realtime.ts` + `pos-app.tsx` `onPrintJobUpsert` | 訂閱 `pos_print_jobs` UPDATE，即時回填（唔等 8s）。已容許 `sent`→`printed` 向上升級。 |
| **Server result route** | `src/app/api/pos/print-agent/result/route.ts` | agent 回報入口，**relay 直接 call 呢支**。把 `sent`/`printed`→DB `printed`。 |
| **Claim RPC** | `supabase/migrations/0020_print_relay.sql` | 原子拎單，防重印。relay 唔使改。 |
| **Native bridge / Companion** | `src/lib/print-bridge/{native,companion}.ts` | 走呢兩條通道嘅單，本地 `sent` 語義同上；若呢兩條通道想顯示真實「打印成功」，佢哋自己亦要回報確認（另案）。 |

**結論**：relay 側改動**自包含**——只要 agent 在正確時機 call `result` 並傳正確 `status`，
web 側（已 deploy）就會自動顯示正確兩級狀態，唔使等 web 再改。

---

## 6. Web 側已完成嘅改動（俾 relay 同事知會發生咩）

| # | 檔 | 改動 |
|---|---|---|
| 1 | `src/app/api/pos/print-jobs/status/route.ts` | 輪詢**保留** `printed`（唔再降格為 `sent`），原值透傳 |
| 2 | `src/components/print-center.tsx` | `syncCloudPrintOutcomes` 回填 `printed`；filter tabs 加「打印成功」；badge 區分「已發送」(emerald)／「打印成功」(sky)；清除鈕加「清除已成功」 |
| 3 | `src/lib/print-jobs.ts` | 新增 `clearPrintedPrintJobs()`；「清除已發送」只清 `sent`（不含 `printed`） |
| 4 | `src/components/pos-app.tsx` | `onPrintJobUpsert` 容許 `sent`→`printed`/`failed` 向上升級（終態不降級） |
| 5 | `src/lib/types.ts` | `PrintJob.status` 已含 `"printed"`（早前 `docs/102` 已加） |

---

## 7. 驗收標準（relay 同事自測）

1. **正常打印**：落單 → agent 印到紙 → web 打印中心該單由「已發送」變「打印成功」（sky 色徽章）。
2. **打印機未連線**：agent 印唔到 → **必須**在合理時間內回報 `failed` → web 顯示「失敗」+ 原因，**唔可以**停留在「已發送」。
3. **重印防護**：同一張單唔會因 relay 重開／web 重連而重複出紙（`printed` 唔入 claim 揀選集）。
4. **重試**：`failed` 且 `attempts<5` → server 打回 `pending` → 其他 agent 接手重印；超 5 次落 `failed` 終態。

### 自測 SQL（relay 側可要求 web 側協助跑）
```sql
-- 印一張單，確認 agent 回報後 status 落 printed / finished_at 有值
select id, status, claimed_by, finished_at, last_error
from pos_print_jobs
where id = '<job_id>'
order by created_at desc;
-- 預期成功：status='printed', claimed_by=null, finished_at 唔係 null
-- 預期失敗：status='failed', last_error 有原因文字
```

---

## 8. 已知限制（轉交時一併告知）

1. **Agent 崩潰唔報**：若 agent claim 到（`printing`）後崩潰、永遠唔回報，DB 停在 `printing`，
   web 本地維持「已發送」。claim RPC 只 re-claim `pending`/`failed`，**唔 re-claim `printing`**。
   → 建議 relay 側加「`printing` 超時（如 120s）回報 `failed`」嘅守護邏輯。
2. **Fire-and-forget 通道**：純 socket 打印機可能冇 ACK，此時「打印成功」只係 best-effort。
   建議加一次 printer status query 驗證出紙。
3. **舊紀錄兼容**：歷史 `sent` 本地紀錄無法回溯變 `printed`，filter / badge 已處理混合情況。
4. **Native / Companion 通道**：呢兩條若未回報確認，web 側「打印成功」對佢哋只係 best-effort（另案處理）。

---

## 9. 聯絡 / 下一步

- Web 側改動已合併，部署後即可見兩級狀態。
- Relay 側按 §2 確認行為、按 §7 驗收。若有 §2.2 更細緻中間態需求，先同 web 側協調 `result` route 改動。
- 相關 server 設計細節見 `docs/102-printed-terminal-state-plan.md`。
