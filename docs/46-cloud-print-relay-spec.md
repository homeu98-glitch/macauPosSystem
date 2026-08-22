# 46. Cloud Print Relay + Stationary Agent 實作規格（Phase 5 互聯網備援）

> **目的**：將 [`docs/43-cross-platform-print-dual-path.md`](./43-cross-platform-print-dual-path.md) 嘅 path B（LAN 唔到 → 經 internet fallback）落成具體可執行嘅規格，交後端團隊 + APK/companion 團隊。
> 本文 = 協議定稿 + 部署選型 + 安全 + 失敗模式 + 分階段實作。配套骨架見 `print-relay/`（relay server + stationary agent），同埋本 repo 嘅 `src/lib/print-bridge/relay-transport.ts`（終端側 `PrintTransport` 骨架）。
>
> **重要定位**：relay **唔取代** LAN 直打。佢只係「終端暫時離開店內 LAN」嗰陣嘅 fallback。喺店內就 LAN 直打，最快最穩。

---

## 0. 三個角色（來自 doc 43，再確認）

| 角色 | 喺邊 | 做咩 | 由邊個做 |
|---|---|---|---|
| **Terminal Local Agent** | 每台 POS 終端 | 收 POS 網頁 `print(job)` → 決定 LAN 直打 or relay → 出單 / 轉交 | 已經有（APK / 桌面 companion / iOS App） |
| **Cloud Print Relay** | 雲端常駐 | 只中轉，store-scoped 隔離，唔落 DB | **本文主體（新 backend）** |
| **Stationary Agent** | 店內常開機 | 收 relay job → 用同一套 `LanTransport` 出單 → 回 result | 新（同 Sunmi Hub APK 合併 或 獨立常開 App） |

---

## 1. 何時 escalate 去 relay（切換條件）

唔好亂 escalate。規則（per-printer 狀態機 `ON_LAN ↔ RELAY`）：

1. **LAN anchor 偵測**：店內廣播 mDNS `_macau-print._tcp.local`，txt record 帶 `storeId=<storeId>`（由 Stationary Agent / 店內打印機廣播）。
2. anchor 在 + 打印機 socket 失敗 → **打印機問題**，唔 escalate，只返錯誤碼俾 POS。
3. anchor 唔在（resolve 唔到）→ **終端離開店內 LAN** → escalate 去 relay。
4. **Healing**：每 45s 重探 anchor；連續 2 次 anchor 在 + LAN 直打造成功 → 由 RELAY 切返 ON_LAN（防 flap）。
5. **job `ttl`**：relay 側 + 終端側都 check，過期即丟，唔出單、唔當成功。預設 60s。

> ⚠️ 區分「打印機壞」vs「LAN 冇」係成個雙路徑最關鍵嘅防呆。anchor 係「店內 LAN 仲在唔在」嘅真相來源。

---

## 2. 部署位置 / 技術選型（⚠️ 決策點）

| 選項 | 優點 | 缺點 | 建議 |
|---|---|---|---|
| **Supabase Realtime**（Broadcast / Presence，store-scoped channel） | 已經有 Supabase Auth，store token 直接復用；唔使管連線；自帶 TLS | 訊息體積 / rate 有限制；broadcast 係 fire-and-forget（要自己處理 ack） | **優先考慮**（最快落地） |
| **自建 Node WSS 服務**（Railway / Render / Fly.io / VM） | 完全可控；可以 storeId 做 room；可以做嚴格 ack + TTL 佇列 | 要自己部屬 + 維運 + 擴展 + 監控 | 要複雜語意（store 隔離 / 持久 ack）時用 |
| Vercel / Next serverless | 唔使額外部屬 | **唔適合長連 WSS**（冷啟 + 10s/平台 timeout） | ❌ 唔用 |

> 兩個選型都必須 **store-scoped 隔離**：用 `storeId` 做 room / channel key，唔可以跨店。

---

## 3. 協議（WSS / Realtime 訊息幀）

統一 JSON 訊息（relay 只中轉，唔改內容）。`job` / `printer` / `kind` / `storeName` 同 [`docs/37`](./37-apk-native-bridge-print-format.md) / [`docs/45`](./45-apk-dual-path-print-agent.md) 的 payload 完全一致；新增 `storeId` / `ttl` 已經喺 Phase 0 落咗。

| 方向 | 訊息 | 欄位 |
|---|---|---|
| Terminal → Relay | `submit` | `{ storeId, token, job, printer, kind, storeName, ttl }` |
| Relay → Terminal | `submit_ack` | `{ ok, jobId, error? }` |
| Relay → Stationary | `dispatch` | `{ storeId, job, printer, kind, storeName, ttl }` |
| Stationary → Relay | `result` | `{ storeId, jobId, ok, code, error? }` |
| Relay → Terminal | `result` | `{ storeId, jobId, ok, code, error? }` |
| 任一方 → Relay | `anchor` | `{ storeId, at }`（心跳，證明店內在線） |

- `jobId` = `job.id`（跨端對單用，同 `window.__posNativePrintResult` 嘅 `jobId` 一致）。
- `code` 用 [`docs/45` §5](./45-apk-dual-path-print-agent.md) 嘅錯誤碼枚舉。
- `ttl` 為 epoch millis（null = 唔設過期）。

---

## 4. 安全（⚠️ 必須）

- **認證**：connect 時帶 `?token=<signedStoreToken>`。Relay 驗證 token 屬於該 `storeId` 嘅 merchant 後，先 subscribe 該 `storeId` room。**唔可以無認證 subscribe 任意 storeId**（否則跨店偷單）。
- **TLS 必須**：全部 `wss://`，唔用 `ws://`。
- **唔落 DB**：relay 只 in-memory 暫存 pending job 等 in-store agent 取；過 `ttl` 即丟。唔持久化單據內容。
- **rate limit**：per `storeId` 限流，防濫用 / 防刷。
- **token 簽發**：優先用現有 Supabase Auth 派生嘅 store-scoped JWT / 短期 token；唔好自建一套。

---

## 5. 失敗模式

| 情況 | 行為 |
|---|---|
| Relay 連唔到 | Terminal 保留 job `pending`，本地 `ttl` 過期轉人工 / 等重連。**唔可以當印咗**。 |
| Stationary 收咗但冇回 `result` | Relay 側 timeout（≤ `ttl`）→ 返 `RELAY_AGENT_TIMEOUT` 俾 Terminal → POS 標 `failed`。 |
| Stationary 本身離線 | Terminal `submit_ack` ok 但收唔到 `result` → 同上 timeout；可加「Store 離線」狀態燈俾店主。 |
| `ttl` 過期 | relay + 終端都丟 job，唔出單。 |

---

## 6. 分階段實作

- **P5.0** 協議定稿（本文件 + doc 43）✅
- **P5.1** Relay server（Node WSS 或 Supabase Realtime）—— 骨架 `print-relay/server.mjs`
- **P5.2** Stationary Agent（店內常開，`LanTransport` 出單）—— 骨架 `print-relay/stationary-agent.mjs`
- **P5.3** Terminal relay client：本 repo `src/lib/print-bridge/relay-transport.ts`（實作 `PrintTransport`，WSS submit + 收 `result`）；`dispatch.ts` 加「anchor 唔在 → 用 `RelayTransport`」
- **P5.4** mDNS anchor 偵測（APK / companion native 做）
- **P5.5** healing / 狀態機 / 「Store 離線」狀態燈
- **P5.6** 驗收 + 安全審計

---

## 7. 待決策（要問用家 / 後端）

1. 用 **Supabase Realtime** 定 **自建 Node WSS**？
2. **Stationary Agent** 用咩裝置跑？同 Sunmi Hub APK 合併一個「常開」mode 定獨立 desktop companion？
3. **store token** 點簽發（用現有 Supabase Auth 定自建）？

---

## 8. 配套骨架說明

- `print-relay/server.mjs` —— 最小 WSS relay（store room、submit→dispatch、result 回傳、TTL 丟、anchor 心跳）。auth 係 placeholder（⚠️ 唔係生產級）。
- `print-relay/stationary-agent.mjs` —— 最小店內 agent（connect relay 做 stationary、收 dispatch、「打印」stub、回 result）。
- `src/lib/print-bridge/relay-transport.ts` —— 本 repo 終端側 `RelayTransport` 骨架，實作 Phase 0 嘅 `PrintTransport` 接口（WSS submit + 等 `submit_ack`/`result`）。暫未接入 `dispatch.ts`，留 P5.3 接。

> 骨架只係證明協議可行 + 俾團隊有嘢落手；**auth / 持久 ack / 生產級容錯要 P5.1–P5.6 補**。
