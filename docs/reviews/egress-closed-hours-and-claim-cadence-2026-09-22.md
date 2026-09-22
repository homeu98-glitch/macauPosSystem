# Egress 第三次覆核：關店時段仲有咩喺度打？claim 應唔應該 block？

日期：2026-09-22 17:50
樣本：`supabase_logs (13).csv`（1,000 行，窗口 14:17–17:29 澳門）
＋ Vercel `…T09-28-32.csv`（1,376 條 `[egress]` 行，窗口 09:05–15:13 澳門）
工具：`tools/_egress-closed-window-20260922.cjs`（新）、`_egress-byip-20260922.cjs`

---

## 0. 一句話結論

**關店時段已經做得到「零」**（16:00–17:00 完全 0 次 call）；
你見到嘅「一上線就爆」係 **15:00–15:15 嘅訂單頁 3 秒迴圈**（已修）。
**claim 唔應該 block**（出紙唯一通道），但已改為「冇單就退避」。

---

## 1. 關店時段逐段實測（Supabase log）

| 時段（澳門） | 次/分 | 主要來源 |
|---|---|---|
| 14:17–15:00 | 12.9 | `claim` 82 ＋ `pos_print_agents` 90（**每 ~30 秒**）＋ `device_configs` 33 ＋ `orders_page` 31 |
| **15:00–15:15** | **20.3** | 🔴 **`pos_sessions` 109 ＋ `rpc/pos_orders_page` 107，中位間隔 3.0 秒** |
| 15:15–15:30 | 4.8 | 只剩 `claim` 30 ＋ `pos_print_agents` 33 |
| 15:30–16:00 | 1.4 | 只有 APK（每 ~60 秒） |
| **16:00–17:00** | **0.0** | ✅ **完全零** |
| 17:00–17:29 | 0.2 | 5 次（＝你自己開 admin「雲端用量」頁） |

⇒ **「關店唔應該 call 任何嘢」已經達成**（16:00–17:00 完全零），唔需要 block 任何 API。

## 2. 「一上線數據量就好可怕」＝ 15:00–15:15 嘅 3 秒迴圈

**指紋**：`pos_sessions` ＋ `pos_orders_page` **成對出現、中位間隔 3.0 秒**，
而全程**冇** `device_configs` / `print_jobs` / `templates` ⇒ 呼叫係 `ordersOnly=1`（而非全量 state）。

對照 Vercel log 同一時段（15:05:40 / 15:06:04 / 15:06:25 …）：
`bytes=291 KB orders=200 limit=200 offset=0 columns=default start=-` ⇒ **每次 291 KB**。

⇒ 15 分鐘 × 20 次/分 × 291 KB ≈ **87 MB（未壓縮）**。

**呼叫者**：`src/components/local-orders-panel.tsx` 嘅 `pullServerOrders()` ——
`limit=200`（預設）、`start=-`（冇日期範圍）、`columns=default` 三者完全吻合。
**為何會 3 秒一次**：觸發③ 監聽 `POS_SYNC_QUEUE_CHANGED_EVENT`，
而 flush 每推一批就 dispatch 一次 ⇒ 只要部機有嘢入隊／flush，就「再拉一次」。

✅ **已修**（見 §4）：15 秒最少間隔 ＋ 順手補 `x-pos-state-src: orders-panel`（之前冇來源標記 ⇒ 無法歸因）。

## 3. claim 應唔應該 block？—— **唔應該 block，但要退避**

| 論點 | 數據 |
|---|---|
| 出紙**唯一**通道 | 雲端 `pos_print_jobs` → 中繼 APK claim。**block 咗 ⇒ 關店後嘅結尾結帳收據、補打帳單永遠印唔出** |
| 成本實測 | 152 次 / 192 分鐘；每次 ＝ 1 PATCH ＋ 1 RPC(0 行) ≈ 300 B（未壓縮）⇒ **≈ 0.17 MB/日** |
| 相對佔比 | 舊分頁迴圈 **1.4 GB/日** ⇒ claim 佔 **約 0.01%** |

⇒ **block claim 對 7.27 GB 毫無幫助**；但「關店照樣每 30 秒打一次」確實違反你嘅原則 ⇒ 改為**退避**。

✅ **已改**：三檔 ＋ 空閒退避（純模組 `print-agent-cadence.ts`，9 條單測）

| 情境 | 間隔 |
|---|---|
| 取滿 `limit`（仲有積壓） | 5 秒 |
| 有取得 job | 15 秒 |
| 連續冇 job 第 1／2／3／4+ 次 | 30 / 60 / 120 / **180 秒（上限）** |

- 關店空閒：**2,880 → 480 次/日（−83%）**。
- 🔴 上限 180 秒係硬線（POS 網頁寫死「`last_seen_at` ≥5 分鐘 → 疑似離線」）。
- 🔴 **唔會令關店後要印嘅單遲到**：APK 有 Realtime 訂閱（INSERT → 即刻 claim），退避只放慢**兜底輪詢**。

## 4. 今次已實作

| 改動 | 檔案 | 效果 |
|---|---|---|
| 訂單頁最少間隔 **15 秒**（＋ `force` 逃生門） | `local-orders-panel.tsx` | 3 秒迴圈 → 最多 4 次/分 |
| 訂單頁加 `x-pos-state-src: orders-panel` | 同上 | 下次可歸因 |
| **P3 修（上一輪）**：`ordersOnly` 有 `since` 都做增量 | `state/route.ts` | 每次 **291 KB → ~3 KB（−99%）** |
| claim 三檔 ＋ 空閒退避 | `print-agent-cadence.ts`（新）＋ `claim/route.ts` | 關店請求 −83% |
| 守衛升級 | `state-incremental-contract.test.ts`（＋2）、`print-agent-cadence.test.ts`（新，9）、`heartbeat-contract.test.ts`（值域改掃 cadence 模組） | 鎖住三條鐵律 |

**驗證**：`node --test` **1,187 passed / 0 fail**｜`tsc` 0 error｜`eslint` 0 error。

## 5. ⚠️ 重要校準：`[egress] bytes=` 係**未壓縮**，帳單係**壓縮後**

| 指標 | 值 |
|---|---|
| 我由 Vercel log 加總（client response bytes，**未壓縮**） | 928.7 MB（09:05–15:13） |
| Supabase Dashboard 22 Sep 帳單（PostgREST，**壓縮**） | **351.2 MB**（＋Realtime 7.5） |
| 比例 | **≈ 2.6×** |

⇒ 以後做估算：**帳單 ≈ `[egress] bytes` ÷ 2.6**。
（今日 22 Sep 嘅 358.7 MB 之中，**約 320 MB 發生喺 14:05 之前** ⇒ 中午部署之後確實止住咗大部分。）

## 6. 仲可以再減嘅清單（按效益）

| 優先 | 項目 | 現況 | 可減到 |
|---|---|---|---|
| **1** | **叫商家 reload／關掉嗰部舊分頁** | 0.67 次/分 × 404 KB ＝ **3.6 MB/小時** | **~0.4 MB/小時**（改用新 bundle 後開頁只拉 30 KB） |
| 2 | 訂單頁 3 秒迴圈 | 291 KB × 20/分 | ✅ 已修（15 秒 ＋ since ⇒ ~0.7 MB/小時） |
| 3 | claim（關店） | 2,880 次/日 | ✅ 已退避（480 次/日；bytes 細，主要省請求數） |
| 4 | 報表全量（`limit=5000 start=-` 482 KB/次） | ~2 次/小時 | 加「同日同範圍」快取 → 近乎 0 |
| 5 | `mount` 仍多數走全量（`incr=1` 只 17 次 / 22 次 mount） | 336 KB/次 | 查點解水位冇生效 → ~30 KB |
| 6 | P0b 再收緊（90 → 180 秒） | — | 再 −50%（但舊頁資料會遲 3 分鐘；Realtime 仍即時） |

## 7. 備註：另一個「關店但仲有 call」嘅正常情況

**只關一條通路**（例如只關線下、線上仍開）按設計會繼續監察 —— 呢個係刻意嘅
（`residual-channel.ts` 殘留通道警示），唔算 bug。真正「全關」＝ 16:00–17:00 嘅零 call。
