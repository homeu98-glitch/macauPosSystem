# 取餐碼 001 為何唔喺報表／交班明細（2026-09-24 表嫂美食）

> 一句話：**001 這張單從來冇進入過 POS 嘅雲端訂單庫（`pos_orders`）。**
> 訂單頁見到它，係因為「線上訂單」讀嘅係會員通 Ledger；報表／交班明細讀嘅係 POS 自己嘅訂單庫 ⇒ 兩邊自然唔同。

---

## 1. 症狀

| 畫面 | 見到 001？ | 資料來源 |
|---|---|---|
| 訂單 → **線上訂單**（今天 · 共 1 張） | ✅ 見到（外賣自取、MOP 43、已完成、已支付（餘額扣點）、預約 13:00） | 會員通 **Ledger** `orders` |
| 營業報表 → **訂單明細** | ❌ 冇 | 雲端 **`pos_orders`**（純雲端，永不 merge 本機） |
| 交班 → **訂單明細** | ❌ 冇 | 以雲端為準（本機＋雲端 LWW） |

---

## 2. 取證（全部唯讀、anon key 直查生產 DB）

工具（同名前綴 `.out.txt` 留證）：
`tools/_probe-order001-20260924.cjs`、`_probe-storegroup-20260924.cjs`、`_probe-pj001-20260924.cjs`、
`_probe-find001-20260924.cjs`、`_probe-missing-20260924.cjs`、`_probe-reportcount-20260924.cjs`

### 2.1 雲端訂單庫冇呢張單

- 表嫂（`8291f843-9def-4956-9d0b-1cfef2598306`）09-24 澳門日：`pos_orders` **32 張**（31 settled ＋ 1 sent_to_kitchen）。
- 今日入咗 POS 嘅線上單只有 **002／003／004／005／006／007**（取餐碼被排到堂食真枱 A03–A08 ⇒ 經「排位」建單）。
- 反查 `id=eq.ledger-f74b4a98-c28c-4afb-9727-b8c86d84338c` 與 `online_order_id=eq.…` ⇒ **兩邊都搵唔到**。
- ⚠️ 陷阱：`local_order_no=eq.001` 只會命中的係 **09-23** 嗰張（`ledger-cf100f81…`, MOP 48, A09）—— 唔係今日呢張。

### 2.2 但佢確實出過紙

`pos_print_jobs`（10:25:37，表嫂）：

| 欄位 | 值 |
|---|---|
| `order_no` | `001` |
| `order_id` | `ledger-f74b4a98-c28c-4afb-9727-b8c86d84338c` |
| `table_name` | `自取` |
| `ticket_type` / `printer_group` | `normal` / `kitchen` |
| `once_key` | `kitchen:normal:0:3sigr5`（有 `onceKey` ⇒ 自動路徑入隊，唔係手動補打） |
| 內容 | `快閃餐(榄菜肉碎四季豆饭)` ×1、`預約時間: 09/24 13:00`、`表嫂美食` |

🔴 **冇 `receipt` 票** ⇒ POS 端**從未「結帳／完成」過**呢張單（自動結帳必定帶 `receipt:<reopenCount>`）。

### 2.3 全店今日只有呢一張「有出紙但雲端冇單」

把今日 `pos_print_jobs` 嘅 `order_id` 集合 vs `pos_orders.id` 集合對比：

```
雲端 pos_orders：32 張 ／ 出過紙嘅單（去重）：29 張
🔴 有出紙但雲端冇：1 張 → 10:25:37  no=001  id=ledger-f74b4a98-…  （kitchen/normal）
```

### 2.4 報表「28 張」復算 ⇒ Ledger 補單 = 0 張

可計（`settled`／`paid`）＋`updated_at` ∈ 澳門 09-24 ＝ **31 張**；剔除截圖當時（約 20:04–20:10）之後才結帳嘅 3 張 ⇒ **恰好 28 張**，逐行同截圖吻合（08／07／002／訂單01…）。
若「Ledger 純線上已付款單」補入生效，應該係 **29 張** ⇒ **今日補入 0 張**。

---

## 3. 根因（兩層疊加）

### 第一層：這張線上單 POS 從來冇採納成訂單

「外賣自取（快餐）」嘅線上單，POS 收到後走嘅係**出紙兜底路徑**（`ledger-pos-bridge.ts`
`ensureKitchenPrintForLedgerOrderOnce()` → 只 `appendPrintJobsWithSync()` ＋ `rememberPrintedLedgerOrder()`），
**唔會**建本地鏡像單（對照「快餐採納」`upsertLedgerLocalOrder(..., "quick_counter_adopted")`）。

⇒ 商家若冇喺 POS 撳「採納／完成」，就永遠冇本地記錄、冇 `ORDER_CREATED` 上雲。
⇒ 客人在 Ledger 用餘額扣點已付款、Ledger 側亦已 `completed`，POS 這邊一張單都冇。

**影響：錢收到，但報表少計 MOP 43，而且冇任何提示。**

### 第二層：報表／交班嘅「Ledger 補單」今日冇生效

設計上呢類單應該由 Ledger 補入：

| 用途 | 函式 | 條件 |
|---|---|---|
| 報表明細／人流 | `loadOnlineByHour()`（`restaurant-daily-report.tsx:1579-1793`） | 非 cancel ＋ `paymentStatus === "paid"` ＋ `createdAt ?? updatedAt` ∈ 澳門今日 |
| 交班「線上實收」 | `sumPaidLedgerOrders()`（`src/lib/ledger/paid-orders.ts`） | 同上 |

今日補入 0 張 ⇒ 其中一環未成立。**未 100% 定位**，候選（按可能性）：

1. `onlineFetchInfo.status === "error"｜"skipped"`（Ledger session 過期 / `merchantId` 為空）⇒ 靜默只用 POS；
2. RPC `list_merchant_orders` 冇回呢張單（分頁游標 `p_since`／`p_since_id` 語義）；
3. 該單唔符條件（時間或 `payment_status`）。

> ⚠️ 註：Ledger 專案 `zymdemjflsckicwcinxl` 嘅 anon **讀唔到**（`orders` 表 42501、RPC `list_merchant_orders` 42501）
> ⇒ 要讀 Ledger 只可經 `/api/admin/ledger/orders`（需 admin session token）或商戶 console。

**一步可判**：報表「尖峰時段（每小時訂單）」卡右上 tag ——
`POS+Ledger`＝抓成功（⇒ 屬第 3 類）／`僅 POS`＝抓失敗（⇒ 第 1 類）／`POS`＝未登入 Ledger。

---

## 4. 修法建議

### P0 — 唔可以再靜默漏單（防守式，唔取決於第二層成因）

報表／交班加「**對數警示**」：把「Ledger 已付款線上單」同「POS 已入帳單」做差集，
顯示「**N 張線上已付款單未入 POS 記錄（MOP X）**」，並提供一鍵補建。

理由：呢類漏單今日完全冇症狀（冇紅標、冇 toast），商家只會見到「報表同實際收錢夾唔埋」。

### P1 — 讓「已付款線上單」自動入帳（治第一層）

二選一：

- **(a) 主動採納**：快餐／自取線上單到達（或自動接單）時，直接 `upsertLedgerLocalOrder(..., "quick_counter_adopted")` 建本地單；因為錢已收，狀態可直接 `settled`。
- **(b) 被動兜底**：偵測 Ledger 側 `completed` ＋ `payment_status=paid` 而 POS 冇對應單 ⇒ 自動補建（需去重，避免同「排位」重複）。

⚠️ 兩者都要跟「一次過出多張紙」嘅鐵律：補建時**唔可以**重新出紙（已有 `printedLedgerOrders` 帳本可複用）。

### P2 — 定位並修好「Ledger 補單」本身

先按第 3 節「一步可判」分辨係失敗定條件問題，再決定係修 session/錯誤暴露，抑或放寬／修正條件。

---

## 5. 唔建議做嘅事

- ❌ 唔好喺 POS 手動補一張等額單「填數」—— 會令本地／雲端／Ledger 三邊更亂，亦破壞單號序列。
- ❌ 唔好改報表去 merge 本機訂單 —— `restaurant-daily-report.tsx` 明文禁止（會重蹈「換機數字唔同」）。

---

## 6. 附：本次用到嘅唯讀取證腳本

| 腳本 | 用途 |
|---|---|
| `_probe-order001-20260924.cjs` | 近 72h 全部 `pos_orders`（含命中比對） |
| `_probe-storegroup-20260924.cjs` | 按 `store_id` × `source` 分組，確認跨店汙染 |
| `_probe-pj001-20260924.cjs` | 今日 `pos_print_jobs` ＋ 001 全文 |
| `_probe-find001-20260924.cjs` | 用 `id`／`online_order_id`／`local_order_no` 反查 |
| `_probe-missing-20260924.cjs` | 出紙集合 vs 雲端訂單集合嘅差集 |
| `_probe-reportcount-20260924.cjs` | 復算報表應有張數（兩種日界口徑） |
