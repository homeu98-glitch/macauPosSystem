# 「關店後仍然一直 call」根因分析（2026-09-21 23:00）

> 委託：門店已關，伺服器仍然持續收到請求。你認為關店後唔應該再 call，要求查原因。
> 樣本：`macau-pos-system-log-export-2026-09-21T15-10-53.csv`
>
> 🔴 **兩點關於樣本嘅重要更正**：
> 1. 呢份檔同 `…T14-29-12.csv` **SHA-256 完全相同**（`025c75e70d0d30ed`, 787,061 B）
>    ⇒ 係同一個窗口，唔係新匯出。
> 2. 檔名寫 `15-10-53`（＝澳門 23:10），但**入面最早／最遲嘅請求係
>    `12:52:15Z` → `13:21:49Z`（澳門 20:52 → 21:21）** —— **差咗近 2 個鐘**。
>    ⇒ 呢份 log **證明唔到**「23:00 關店之後」嘅情況；但下面 §3 嘅架構結論
>    （完全冇關店閘）同時間無關，一樣成立。

---

## 0. 一句話結論

**「關店後仍然一直 call」有兩個獨立原因，而主因同「關店」無關：**

| # | 原因 | 佔比 | 性質 |
|---|---|---|---|
| ① | 一部 Mac 嘅**舊分頁**跑住舊 JS，進入 **4.5 秒自激迴圈** | **62% 請求、~97% egress** | 🔴 **Bug**（同店開唔開完全無關，關店照燒 650 MB/小時）|
| ② | **整個系統完全冇「關店就停」機制** —— 所有 client 輪詢都係無條件 | 其餘 38% | 🟠 **設計缺失**（本來就應該有）|

即係：就算你今晚 reload 好嗰部 Mac、①完全消失，②仍然會令關店後維持 **約 9.5 次/分鐘** 嘅呼叫。
要真正滿足你嘅要求，兩件事都要做。

---

## 1. 證據（樣本窗口 20:52–21:21，29.6 分鐘，450 個去重請求）

### 1.1 請求分佈

| 次數 | /分鐘 | route | 來源 |
|---:|---:|---|---|
| **167** | **5.65** | `GET /api/pos/state` | 🔴 Mac 舊分頁迴圈 |
| 55 | 1.86 | `POST /api/pos/print-agent/heartbeat` | APK 中繼機 |
| 33 | 1.12 | `POST /api/topup/pending-count` | 側欄紅點 |
| 32 | 1.08 | `POST /api/pos/print-agent/claim` | APK 中繼機 |
| 30 | 1.01 | `POST /api/pos/sync` | POS 分頁 |
| 25 | 0.85 | `GET /api/pos/shift` | POS 分頁 |
| 15 | 0.51 | `GET /api/online-order-settings` | POS 分頁 |
| 14 | 0.47 | `GET /api/pos/store-status` | POS 分頁 |
| 11 | 0.37 | `/` | 頁面瀏覽 |
| 10 | 0.34 | `GET /api/pos/device-config` | APK 中繼機 |
| 9 | 0.30 | `/login` | 頁面瀏覽 |
| 6 | 0.20 | `/icon` | 頁面瀏覽 |
| 5 | 0.17 | `/pos` | 頁面瀏覽 |
| 4 | 0.14 | `/shift`、`/api/pos/print-agent/result`、`/api/inventory/receipts` | 混合 |
| 其餘 | <0.1 各 | `/orders`、`/reports`、`/settings`、`/inventory`、`bootstrap`、`device-token`、`sequence`、`soldout`、`prints`、`members`、`kiosk-settings`、`ledger/login` | 混合 |

**合計 450 個去重請求 / 29.6 分鐘 ＝ 15.2 次/分鐘（關店時段！）**

### 1.2 egress 加總（`tools/_egress-aggregate-20260921.cjs`）

```
總 egress = 126.53 MB / 29.6 min = 256.8 MB/小時 ⇒ 開 10 小時 ≈ 2.51 GB

  149 次  123.05 MB (97.2%)  平均 865,924 B
      pos/state full ip=60.246.53.111  skipQueue=0 queue=300   ← 🔴 Mac 舊分頁
   17 次    3.40 MB ( 2.7%)   平均 209,832 B   pos/state ordersOnly
    1 次    0.09 MB ( 0.1%)   平均  90,080 B   pos/state full ip=60.246.45.220（新版，正常）
```

**扣走嗰 149 次之後，關店時段嘅真實 egress 只有約 3.5 MB / 29.6 分鐘 ≈ 7 MB/小時。**

### 1.3 🔴 另外發現：多個 route 有「兩個來源同時打」

逐 route 睇呼叫間隔（去重後）：

| route | n | 間隔中位 | 最小 | 設計值 | 判斷 |
|---|---:|---:|---:|---|---|
| `/api/pos/sync` | 30 | **18.6s** | 2.2s | 30s（`sync-flush`）＋ 30s（pos-app 批次） | 🔴 **兩個 30 秒來源交錯 ⇒ 實際約 15~19 秒一次** |
| `/api/topup/pending-count` | 33 | **30.3s** | 0.7s | 60s（fast）／300s（slow） | 🔴 **比設計快 2~10 倍**，有第二個來源或反覆 focus |
| `/api/pos/shift` | 25 | **48.3s** | **0.0s** | 180s ＋ `focus` ＋ `NETWORK_STATUS_EVENT` | 🔴 有 **0.0s 成對**（兩個來源同刻），且比 180s 密 **3.7 倍** |
| `/api/pos/store-status` | 14 | 52.3s | 2.2s | mount／Realtime／visibilitychange（**冇 interval**） | 唔規則 ⇒ 事件驅動，正常 |
| `/api/online-order-settings` | 15 | 52.4s | 0.4s | 同上 | 同上；**同 store-status 完全同一批時間戳** ⇒ 同一個觸發器 |

兩點值得跟進：

1. **`sync` 同 `shift` 都係「兩個來源各打一次」** ⇒ 白白多一倍呼叫。
   `sync`：`sync-flush`（30s，有 pending 才打）＋ `pos-app` 批次（30s）。
   `shift`：180s timer ＋ `window.addEventListener("focus")`。
   🔴 呢個同 2026-09-21 早前修好嘅「thundering herd」係**同一型問題**，
   只係今次唔係「多個 component 各自 mount」，而係「兩條獨立機制做同一件事」。
2. `topup/pending-count` 中位 30.3 秒，同 `pending-count-store` 寫嘅 60s／300s 對唔上
   ⇒ 要查係邊個 call site 用 `fast` 模式，或者係 `visibilitychange` 過密（
   `VISIBILITY_REFRESH_MIN_GAP_MS = 30_000` 剛好對得上 30 秒！）。
   🔴 **即係 `visibilitychange` 每 30 秒就獲准拉一次** ⇒ 如果分頁不停被切前後景
   （或 Safari 反覆觸發），就會變成 30 秒一次嘅「隱形輪詢」。

---

## 2. 原因①：Mac 舊分頁嘅自激迴圈（唔關「關店」事）

詳細證據見 `errwarn-and-call-audit-2026-09-21.md` 附錄 B。重點：

- `ip=60.246.53.111`、**Mac Safari 17.14**、`skipQueue=0 queue=300` ⇒ 跑住 **17:18 之前嘅舊 JS**。
- 每 **4.45 秒**一次、每次 **846 KB**（新版只要 424 KB）。
- **同一部 Mac 另一個分頁係新版**（`skipQueue=1`），29.6 分鐘只拉 1 次 ⇒ 唔係機舊，係**分頁舊**。
- 呢個迴圈係 client-side bug，**伺服器完全控制唔到**；店開唔開都照跑。

✅ **已加防護（待部署）**：`/api/pos/state` 偵測「非 ordersOnly 且冇 skipQueue」⇒
`console.warn` ＋ egress log `legacy=1`，每 IP 每分鐘最多 1 條。

---

## 3. 原因②：架構上完全冇「關店就停」機制 🔴

### 3.1 證據（grep 全 repo）

```
shopClosed / shop-closed / storeIsOpen / isShopClosed
```

⇒ 只出現喺 **server 對 kiosk 落單嘅拒單理由**（`src/app/api/pos/sync/route.ts:872`
`ack(false, "商家不在營業中", { reason: "shop-closed" })`）同客人端嘅錯誤分流。

**`useStoreStatus().isOpen` 嘅全部用途**（grep 結果）：

| 位置 | 用途 |
|---|---|
| `app-sidebar.tsx:167-271` | 側欄 pill 顯示「已暫停」 |
| `online-open-pill.tsx:55` | 線上開關 pill |
| `shift-page.tsx:419,1565` | 交班頁顯示 |
| `use-store-open-toggle.ts:61-71` | 開關按鈕 |

🔴 **冇任何一處用 `isOpen` 去停或放慢週期性呼叫。** 所有輪詢都係無條件跑。

### 3.2 關店後仍然會打嘅嘢（逐項）

| 項目 | 頻率 | 觸發機制 | 關店後應否停？ | 停嘅風險 |
|---|---|---|---|---|
| `print-agent/heartbeat` | 1.86/min | APK `HEARTBEAT_MS=30_000` | 可放慢（→60s 或停） | 要保住 `last_seen_at`（POS 顯示「中繼機在線」）；見 APK 交接文件 A-1/A-3 |
| `print-agent/claim` | 1.08/min | APK `TICK_MS=60_000` | ❌ 唔可以停 | 呢個就係「拉雲端打印任務」；停咗＝關店前後落嘅單永遠唔出紙 |
| `print-agent/device-config` | 0.34/min | APK 每 5 tick | 可放慢 | 打印機改 IP 後生效延遲 |
| `topup/pending-count` | 1.12/min | `pending-count-store` 60s/300s | ✅ 可以停 | 只係側欄紅點；返前景會即時補拉（已有 `visibilitychange`） |
| `pos/sync` | 1.01/min | `sync-flush` 30s（有 pending 才打） | ❌ **唔可以停** | 停咗＝本地訂單／結帳推唔上雲（其他終端／雲端收唔到） |
| `pos/shift` | 0.85/min | pos-app 180s ＋ `focus` ＋ `NETWORK_STATUS_EVENT` | ✅ 可以停（有前提） | 另一部機「開工」時唔會即時知（見 §4） |
| `online-order-settings` | 0.51/min | mount ＋ 事件 ＋ visibilitychange（**冇 interval**） | ⚪ 本身唔係輪詢 | — |
| `pos/store-status` | 0.47/min | mount ＋ **Realtime** ＋ visibilitychange | ⚪ 本身唔係輪詢 | — |
| `pos/state`（全量） | 5.65/min | 舊分頁迴圈（正常應該 ~0） | ✅ 迴圈本身要修 | — |
| 頁面瀏覽（`/` `/login` `/pos` …） | ~1.4/min | 真人開頁／PWA | ⚪ 唔算「自動 call」 | — |

### 3.3 有咩現成資產可以用

🔴🔴 **關鍵發現：`pos_store_status` 已經有 Realtime 推送！**

`src/lib/pos/use-store-status.ts:184-207`：

```ts
channel = supabase
  .channel(`pos-store-status:${storeId}`)
  .on("postgres_changes",
      { event: "*", schema: "public", table: "pos_store_status", filter: `store_id=eq.${storeId}` },
      (payload) => setState({ isOpen: row.is_open, source: "realtime" }))
  .subscribe();
```

而且**刻意冇 `setInterval`**（註釋：「全專案禁 polling」），
並用 `crossTerminalSync: "instant" | "on-enter"` 老實標示「Realtime 通唔通」。

⇒ **「幾時重開」根本唔需要輪詢去偵測** —— 呢個就係做「關店即停」嘅前提，
亦解決咗「停咗就唔知幾時重開」嘅雞蛋問題。

---

## 4. 建議設計（要你拍板，未實作）

### 4.1 核心守衛（純決策、可單測、零 import）

```ts
// src/lib/pos/idle-poll-gate.ts
export function shouldKeepPolling(input: {
  storeOpen: boolean | null;        // useStoreStatus().isOpen（null = 未讀到）
  crossTerminalSync: "instant" | "on-enter";
  hasPendingSyncEvents: boolean;    // 本地仲有未上雲嘅事件
  visibilityState: string;          // document.visibilityState
}): { poll: boolean; reason: string };
```

**判準**（保守）：
停 ⇔ `storeOpen === false` **而且** `crossTerminalSync === "instant"` **而且** 冇 pending 事件。
—— `null`（未讀到）同 `"on-enter"`（Realtime 唔通）一律**照跑**（fail-open，唔可以因為讀唔到就停）。

### 4.2 應用範圍（只限「純顯示」項）

| 停 | 唔停 |
|---|---|
| `topup/pending-count` | `pos/sync`（推單上雲） |
| `pos/shift`（180s tick） | `print-agent/claim`（拉打印任務） |
| `pos/state` 全量（關店後冇需要每分鐘拉 200 張單） | Realtime 訂閱（要即刻知重開 / 新單） |
| KDS 看門狗（如果開住） | `print-flush-worker`（出紙） |

### 4.3 恢復路徑（三條，全部已有）

1. **Realtime `pos_store_status` 事件** → `isOpen` 變 true → 即刻 `refresh()`（**現成**）。
2. **`visibilitychange` 返前景** → 現成 listener（topup / store-status / pos-app 都有）。
3. **使用者任何操作** → 加一個 `pointerdown`/`keydown` listener → 一次性補拉。

⇒ 「關店後零輪詢、重開即時恢復」係做得到嘅，而且**唔需要 Realtime 以外嘅新基建**。

### 4.4 未解決嘅邊界（要你決定）

| 邊界 | 影響 | 建議 |
|---|---|---|
| 關店後**線上接單仍然開**（殘留通道 `residual-channel`） | 客人仲落得到單，但 POS 停咗輪詢 | 守衛要**加入**：`merchantEnabled === true` 時**唔停** |
| 另一部機「開工」而呢部機喺關店狀態 | `pos_shifts` **冇** Realtime 訂閱 ⇒ 呢部機唔會即時知 | 加 `pos_shifts` Realtime，或者保留 5 分鐘慢輪詢 |
| 交班／對數期間（已關店，但老闆要睇今日數） | 停輪詢可能令報表數字唔更新 | 只停「自動輪詢」，**手動操作一律即時拉**（第 3 條恢復路徑已覆蓋） |

---

## 5. 即刻可以做（唔需要改 code，5 分鐘）

1. **去嗰部 Mac（Safari 17.14）閂掉所有 POS 分頁再重開**（或 `Cmd + Shift + R`）。
2. 之後 Vercel log 應該：`skipQueue=1` 100% 出現、舊版警報歸零。
3. 預期：**256 MB/小時 → 約 7 MB/小時**、請求 15.2/min → **約 9.5/min**。

## 6. 待你拍板

| # | 項目 | 風險 | 建議 |
|---|---|---|---|
| 1 | 部署已寫好嘅兩項診斷（`x-pos-state-src` ＋ 舊版偵測） | 零（只加 log，實測回應逐位元不變） | ✅ 即刻 push |
| 2 | `idle-poll-gate` ＋ 停 `topup` / `pos/shift` / 關店後全量拉取 | 中（要 `residual-channel` 一齊考慮） | 建議做，但要先定 §4.4 三條邊界 |
| 3 | 加 `pos_shifts` Realtime 訂閱（令第 2 項可以停得更徹底） | 低（多一條 channel，Realtime 佔 egress <1.2%） | 建議做 |
| 4 | APK 心跳放慢／停（見 `docs/integration/apk-optimization-handover-2026-09-21.md`） | 低 | 交 Ledger 同事 |
