# 桌台「只閃一下」＝孤兒單自動隔離（2026-09-22 20:30）

> 影片：`55975d45c53c68a72816ab375cecf84d.mp4`（6.4 秒、720×1280 直倒、30fps）。
> 抽幀腳本 `tools/_grab-tablet-flash.cjs`（HEVC → H.264 → Chrome CDP 逐 0.2 秒截圖，共 33 幀）。
> 關鍵幀存於本目錄（`01…05`）。

---

## 1 影片實況（逐幀）

| 時間 | 畫面 | 內容 |
|---|---|---|
| t=0.0 | 營業結語（報表） | 訂單數 **34**、營收 **MOP 2,268**；結帳記錄最新一筆 **A02 Mpay 22/09/2026 19:52 MOP 40** |
| t=4.0 | 訂單頁 `/orders` | 店內線下訂單見到 **MOP 98「製作中」19:33**（＝訂單29，A01） |
| **t=5.0** | **桌台總覽（1樓）** | **A03 橙卡：1樓 · 已坐 1/— · 應收 MOP 41 · 已下單**；左邊第一格（A01）亦係橙（被畫面裁走） |
| **t=5.2** | 同上 | **A03 仍然係橙卡（MOP 41）** |
| **t=5.4** | 同上 | 🔴 **A03 變「空閒」**；左邊嗰格橙色亦消失 |
| t=6.4 | 同上 | 全部空閒（A02/A03/A04/A06/A07/A08） |

⇒ 「只閃爍了一下」＝**A03（應收 MOP 41）同 A01（MOP 98）兩張未結帳枱卡，喺 0.2–0.4 秒內由「已下單」變成「空閒」**。

對照雲端（`_probe-order19c`）：

| 單 | 枱 | 金額 | 狀態 | 對應卡片 |
|---|---|---|---|---|
| 訂單25 | A03 | **41** | `sent_to_kitchen` | ✅ 影片中閃走嘅橙色卡 |
| 訂單29 | A01 | **98** | `sent_to_kitchen` | ✅ 左邊被裁走嘅橙色格 |
| 訂單19 | A01 | 99 | `sent_to_kitchen` | 早前已被隔離（所以 A01 可以再開 訂單29） |

**雲端兩張單一直冇變過** ⇒ 消失純粹係**本機側**行為。

---

## 2 為何會「閃一下就走」

### 2.1 枱卡狀態嘅來源（純本機推導）

```ts
// pos-app.tsx
const openOrders = useMemo(() => orders.filter(o =>
  o.status === "draft" || o.status === "sent_to_kitchen" ||
  o.status === "paid"  || o.status === "reopened"), [orders]);      // 2240 行

const tableOrderMap = useMemo(() =>
  new Map(openOrders.slice()
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map(o => [o.tableId, o])), [openOrders]);                       // 2332 行
```

⇒ 枱面「已下單／應收 MOP xx」**完全由 `orders`（＝localStorage）推導，唔會即時查雲端**。
`orders` 一變，卡片即刻重繪 —— 呢個就係「閃」嘅載體。

### 2.2 令 `orders` 少兩張單嘅一段：孤兒單自動隔離

```ts
// pos-app.tsx `loadRuntimeState()`（每次 /api/pos/state 回應之後跑）
if (!payload.incremental) {                                   // 1508 行
  const orphanRows = computeOrphanLocalOrders(cleaned, payload.orders!, loadQueue());
  if (orphanRows.length > 0) {
    const n = quarantineOrders(orphanRows.map(r => r.orderId), "auto-full-pull");
    if (n > 0) {
      cleaned = cleaned.filter(o => !qIds.has(o.id));         // 枱卡即刻變空閒
    }
  }
}
saveOrders(cleaned);
```

判準（`sync-reconcile.ts` `computeOrphanLocalOrders`，四個條件同時成立）：

1. 本機係**非終態**單（`draft / sent_to_kitchen / paid / reopened`）← 訂單25、29 符合；
2. **雲端今次回應嘅 `payload.orders` 冇呢個 id** ← 節流骨架（`orders: []`）符合；
3. outbox 冇任何 `pending / failed` 嘅 `ORDER_*` 事件支持佢；
4. **單齡 ≥ 10 分鐘**（`ORPHAN_MIN_AGE_MS`；訂單25 18:40、訂單29 19:33，都過咗）。

⇒ `quarantineOrders()` 將佢哋**由 `orders` localStorage 移走**（移入隔離區），
並 `saveOrders(remaining)` → dispatch `pos-orders-changed` → `setOrders(loadOrders())`
→ `openOrders` 重算 → `tableOrderMap` 冇咗 A01／A03 → **卡片變「空閒」**。

### 2.3 為何係「一下」而唔係持續閃

隔離係**單向**嘅：`filterResurrectedOrders()` 會攞住隔離 id 剔走，
之後所有 realtime／backfill 都**唔可以令佢復活**（`pos-app.tsx` 1907 行）。
⇒ 消失一次就唔會返嚟（要靠人手還原）。

### 2.4 為何「最尾」才閃

* 條件 4 有 **10 分鐘單齡門檻** ⇒ 落單後頭 10 分鐘唔會被隔離；
* 條件 2 要**該次回應嘅 orders 係空／缺**。今次成因＝今日新增嘅 **P0b 舊版節流**回空骨架
  （log 由 **19:56:33** 起、該機 ip `60.246.53.111` 每個 pull 都係
  `[egress] mode=legacyThrottled bytes=205 orders=0`）。
* 影片第一幀嘅結帳記錄最後一筆係 **19:52**、log 窗口由 19:56:33 開始就係連續節流 ⇒
  **時間窗吻合**（影片應該就係 19:5x 嗰段）。

⇒ 併起來：**收銀啱啱切去桌台總覽 → 背景一個 pull 返到空骨架 → 兩張未結帳單被判孤兒 → 卡片即變空閒**。
用戶手上就係「睇住佢閃一下」。

---

## 3 同前面幾個症狀係同一條根

| 症狀 | 同一個成因 |
|---|---|
| 「19 號訂單搵唔到」 | 訂單19（A01）被隔離 → 列表冇 → 報表亦唔會列（未結帳） |
| 「A01 同時有兩張未結單（訂單19 + 訂單29）」 | 訂單19 被隔離後枱面顯示「空閒」，收銀再開一張 |
| 「未結帳單又不見了」（今次） | 訂單25 + 訂單29 被隔離 |
| 桌台「只閃一下」 | 就係隔離嗰一刻嘅畫面 |

---

## 4 已修 / 待辦

**已修**
1. `src/app/api/pos/state/route.ts`：`legacyThrottled` 節流骨架由 `orders: []`
   改為**回本店全部未結帳單**（孤兒判準即變 no-op）；＋ `&& supabase`／`storeId` 守門。
2. `src/components/pos-app.tsx`：隔離發生時**出可見 toast**
   （「有 N 張未結帳單被自動隔離…去設定 → 同步健康 → 隔離區可還原」）——
   之前自動隔離**零可見提示**，收銀只見到「閃一下」。
3. 守衛測試：`src/lib/pos/pos-app-queue-base.test.ts`（節流骨架唔可回空 orders／隔離要出聲）。

**待辦**
| 優先 | 項目 |
|---|---|
| P0 | 部署 + 全店裝置重新載入（舊 bundle 係一切上游） |
| P1 | 孤兒隔離加「雙重確認」：需連續 N 次全量拉取都冇嗰張單才隔離（而唔係一次就移走） |
| P1 | 「同步健康」隔離區加**明顯紅點**（現時要自己入去睇） |
| P1 | 隔離事件寫入 `pos_queue_events`／獨立審計表，方便事後追（現時只有 localStorage） |

---

## 5 立即還原（商家操作）

1. `/pos`（或 `/orders`）→ **設定 → 同步健康 → 隔離區** → 逐張**還原**。
   影片中被隔離嘅係 **訂單25（A03, MOP 41）** 同 **訂單29（A01, MOP 98）**。
2. 每部 iPad **重新載入**（換新 bundle）→ 唔會再被空骨架隔離。
3. 之後確認枱面 A01／A03 恢復「已下單」。
