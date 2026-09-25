# 150 · Ledger「線下營業摘要」API（POS 側實作）

> **日期**：2026-09-25
> **契約**：[`docs/integration/pos-offline-report-api.md`](../integration/pos-offline-report-api.md)（Ledger 2026-09-24 發出，v1）
> **審視**：[`docs/integration/pos-offline-report-contract-review-2026-09-25.md`](../integration/pos-offline-report-contract-review-2026-09-25.md)
> **回覆 Ledger**：[`docs/integration/pos-offline-report-reply-2026-09-25.md`](../integration/pos-offline-report-reply-2026-09-25.md)
> **狀態**：**已實作、未部署**（等 Vercel push ＋ 商家跑 0058 ＋ Ledger 交換 secret）

---

## 1. 做咗啲乜

Ledger 報表頁要開一張「店內 POS（線下）」卡，同佢哋自己嘅線上數字**並排顯示、不加總**。
資料方向係 **Ledger 伺服器 → POS Vercel**（同 v3.x 相反），POS 只提供**一支唯讀 GET**。

| 檔案 | 角色 |
|---|---|
| `supabase/migrations/0058_pos_offline_report_rpc.sql` | `public.pos_offline_report(text, date, date) returns jsonb`：DB 內一次過聚合（stable／security invoker／只 grant `service_role`） |
| `src/lib/pos/offline-report.ts` | 契約純邏輯：UUID／日期鍵驗證、90 日 clamp、HMAC 驗簽、RPC 回值嚴格驗證、回應組裝（**零 `@/` 依賴**，可 `node --test` 直接載入） |
| `src/app/api/integration/ledger/offline-report/route.ts` | 路線：驗簽 → 參數 → 限流 → RPC → 驗值 → 回應 |
| `.env.example` | 新增 `LEDGER_OFFLINE_REPORT_HMAC_SECRET`（A-4 段，附「唔可以同 webhook secret 共用」警告） |
| `src/lib/pos/offline-report.test.ts` | 22 條純邏輯測試 |
| `src/lib/pos/offline-report-guard.test.ts` | 27 條源碼守衛（secret 分家／假零禁令／migration 口徑／鑑權例外） |
| `tools/check-pos-offline-report-sql.py` | 用 libpg_query（pglast）驗 0058 語法（外層 + 逐條 body 語句），**本機冇 Postgres 都驗得到** |

**零新依賴**（冇引入 `pg`）、**零新 Supabase 連線**、**冇出任何 DB 憑證**。

## 2. 口徑（唯一真源，逐項對齊 `/reports`）

| 項目 | 定義 | 為何 |
|---|---|---|
| 計入 | `status in ('settled','paid')` | ＝ `isSaleCountable()`；2026-09-25 用戶拍板「線下 `paid` 要計」 |
| 剔除 | `refunded` / `partially_refunded` 整張 | 同報表一致（毛額口徑，`flags.refundsNetted = false`） |
| 排除 | `online_order_id is not null` | 線上投影單，Ledger 自己已有該筆線上數（實測主店 09-24 有 8 張 / MOP 392） |
| 日歸屬 | `coalesce(settled_at, reopened_at, updated_at, created_at)` 轉 `Asia/Macau` | ＝ `orderEventInstant()`（**唔可以只寫 `settled_at → updated_at`**，會漏 `reopened_at` 腿） |
| 人流 `covers` | `table_id = 'counter'` → 1 人；否則 `greatest(1, party_size)` | ＝「當日人流」卡（`restaurant-footfall.ts`）；**唔係**報表 `Agg.covers`（Σ party_size，快餐會係 0） |
| 金額 | DB 內已換 **avos 整數**（`round(MOP × 100)`、非負） | `pos_orders.total` 係 MOP `numeric`，唔係 avos |
| 支付方式 | 原字串（`Mpay`／`現金`／`會員餘額 + Mpay`…），`left(…, 32)` 截斷 | 開放值域、有組合付款；> 32 字會被 Ledger 整包拒收 |
| 範圍 | 90 個日曆日；超出 ⇒ 保留 `to`、`from = to − 89 日`、`clamped = true` | 契約 §驗證順序 4 |
| `breakdown.dineIn/quick` | **刻意唔出** | POS `/reports` 冇呢個維度，新發明口徑第一次對數一定對唔上（用戶 2026-09-25 拍板 v1 唔出） |

## 3. 三個設計決定（連理由）

### 3.1 為何用 RPC 而唔係 route 內 PostgREST 加總

90 日窗口逐行拉落 Vercel 再加總 ＝ 每次報表載入 1～9 個請求、約 1–2 MB，而且 PostgREST **冇 `GROUP BY`**（支付方式分項砌唔出，同 `docs/94 §1.2` 結論一致）。
⇒ 一支 `stable` function，一次請求、幾個 byte，口徑亦只寫一次。

### 3.2 為何唔照契約建議用 `docs/94` 嘅 `build_full_report()`

`report_ro.build_full_report()` 嘅 body 引用 83 號嘅 22 個 `report_ro.v_*` view，而 **83 從未在 production 建立**
⇒ 唔係權限問題（`security definer` 救唔到），係 **view 唔存在** ⇒ `create` 唔到。
拉 83 落嚟等於把 2026-09-04 否決嘅整套唯讀角色重新引入。⇒ 0058 直接讀 `public.pos_orders`，零依賴。

### 3.3 「唔可以渲染假零」點落實

契約明文：任何欄位型別唔符 ⇒ Ledger 整包丟棄並顯示「暫時無法取得」。
所以本 route 嘅原則係 **要麼回真資料、要麼唔回 200**：

| 情況 | 回應 | Ledger 見到 |
|---|---|---|
| secret 未設 | `500 server_misconfigured` | 暫時無法取得 |
| 簽名／時戳唔對 | `401 unauthorized` | 暫時無法取得 |
| 參數唔合法 | `400 bad_store_id` / `bad_range` | 暫時無法取得 |
| 查詢過密 | `429 too_many_requests` | 暫時無法取得 |
| **0058 未跑** | `503 rpc_not_deployed` | 暫時無法取得（唔會出 0 元卡） |
| 查詢／驗值失敗 | `503 upstream_unavailable` | 暫時無法取得 |
| 店從未上雲 | `404 store_not_found` | 「本店尚未啟用店內系統」 |
| 正常 | `200` 真數據 | 卡片 |

## 4. 安全性

| 項目 | 做法 |
|---|---|
| Secret | `LEDGER_OFFLINE_REPORT_HMAC_SECRET`，**唔可以 fallback** 落 `LEDGER_WEBHOOK_SECRET`（守衛測試掃死）；未設 ⇒ fail-closed 500 |
| 驗簽 | `HMAC-SHA256(secret, ts + "." + "GET" + "." + pathWithQuery)`；5 分鐘時窗；秒／毫秒都收；**先擋 `/^[0-9a-f]{64}$/i`**（`Buffer.from(hex)` 會靜默截斷壞尾碼）再 `timingSafeEqual` |
| 原字串 | 用 `url.pathname + url.search`，**唔重排 query、唔 decode 再 encode**（`next.config` 冇 rewrite／trailingSlash） |
| 授權 | 🔴 **刻意唔行 `posRouteAuthGuard()`** —— 呼叫方係 Ledger 伺服器，冇 POS 終端憑證。呢個係全專案唯一嘅業務 GET 例外，理由寫喺 route 檔頭（否則下一輪匿名端點審計會當漏網） |
| DB 權限 | 0058 `revoke all … from public, anon, authenticated` + `grant execute … to service_role`。**唔可以**開畀 anon：一次回全期跨店聚合 ＝ 繞過 0041 嘅 72 小時 anon 讀取窗 |
| 函數屬性 | `stable`、`security invoker`（**唔用** definer，唔開後門）、`set search_path = public` |
| 限流 | 每 `storeId` 每分鐘 ≤ 30 次（in-memory Map，Vercel 多實例下 best-effort；放喺打 DB **之前**） |
| 資料面 | 回應只有聚合數字：冇單號、冇顧客、冇菜品明細；`Cache-Control: no-store` |
| Secret 落地 | `.env.example` 明文寫「唔可以加 `NEXT_PUBLIC_` 前綴」；守衛測試斷言冇加 |

## 5. 部署次序（**次序錯會出事**）

1. **商家**喺 Supabase（POS 專案）SQL Editor 貼 `0058_pos_offline_report_rpc.sql`
   （無 transaction、全部 idempotent；**唔好**用 `begin;…commit;` —— 0057 教訓：商家會誤解 commit ＝ git commit）。
2. **Ledger** 產生 `LEDGER_OFFLINE_REPORT_HMAC_SECRET`（≥32 hex）私訊交換（唔進 git／issue）。
3. POS 側喺 **Vercel → Project Settings → Environment Variables** 設 `LEDGER_OFFLINE_REPORT_HMAC_SECRET`（production scope）。
4. push code → 部署（env 改動要**重新部署**才生效）。
5. Ledger UAT 設：`POS_OFFLINE_REPORT_BASE_URL=https://macau-pos-system.vercel.app`、`POS_OFFLINE_REPORT_HMAC_SECRET=<同一把>`、storeId 對照表（只 UAT）。
6. 對數（下一節）。

⚠️ 步驟 1 未完成時 route 已經上線係**安全**嘅：會回 `503 rpc_not_deployed`，Ledger 顯示降級一行，唔會出假數。

## 6. 驗收（照契約 §驗收清單）

| # | 做法 | 期望 |
|---|---|---|
| 1 | 錯 secret／過期時戳打 route | `401` |
| 2 | 缺 `storeId`／`from`／`to`、`from > to`、非 UUID | `400` |
| 3 | 未知 storeId | `404 store_not_found` |
| 4 | `from=2026-01-01&to=2026-09-24` | `clamped=true`、`from=2026-06-27`、`to` 不變 |
| 5 | 正式測試店（建議 `8291f843-9def-4956-9d0b-1cfef2598306`）同區間 | `kpi.revenueAvos` / `orderCount` 同 POS `/reports` 嘅**線下**數一致（09-24 = 27 張 / 184,700 avos） |
| 6 | 有線上單嘅日子 | 帶 `online_order_id` 嘅單**唔計入**（09-24 主店 8 張 / 39,200 avos 要排除） |
| 7 | `generatedAt` | 帶 `Z` 或 `+08:00`；簽名 64 hex |
| 8 | 全部金額 | 整數 avos、非負 |

**本機可跑嘅自動驗收**：

```bash
node --test src/lib/pos/offline-report.test.ts src/lib/pos/offline-report-guard.test.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src/lib/pos/offline-report*.ts src/app/api/integration/ledger/offline-report/route.ts
C:/Users/surface/.workbuddy/binaries/python/envs/default/Scripts/python.exe tools/check-pos-offline-report-sql.py
```

## 7. 已知邊界（誠實記錄）

1. **`store_id` 大小寫**：route 會將 `storeId` 轉小寫，0058 用 `o.store_id = p_store_id` **精確比對**。
   POS 寫入嘅 `store_id` 一律係 Ledger 登入回嘅小寫 UUID（實測兩間店都係小寫），
   若日後真出現大寫 `store_id`，會回 `404`（可接受：寧願唔出數，唔好出錯數）。
2. **唔包**：菜品排行、尖峰時段、出餐時長、低庫存、線上數字 —— 契約範圍外（POS 側亦唔會出）。
3. **`covers` 只計線下**：Pos `/reports` 嘅「當日人流」包含線上單（`footfallTotal`），
   呢張卡係**線下專用**，所以唔包線上，兩邊數字唔預期相等（契約口徑已寫明）。
4. **限流係 best-effort**：Vercel 每個實例各自一個 Map，多實例下實際上限會鬆過 30/min。
   Ledger 有 session cache（一次進頁一次），正常唔會觸及。
5. **`anon` 時間窗**：`tools/_probe-offlinereport2-20260925.cjs` 唯讀探測只睇到約 72 小時，
   更早日期嘅對數要用呢支 API（或商家喺 SQL Editor 跑）—— 呢點已寫入回覆文件。

## 8. 相關

- 契約審視：`docs/integration/pos-offline-report-contract-review-2026-09-25.md`
- 回覆 Ledger：`docs/integration/pos-offline-report-reply-2026-09-25.md`
- 生產對數底稿：`tools/_probe-offlinereport2-20260925.out.txt`
- 口徑源頭：`src/lib/pos/order-event-time.ts`、`src/lib/restaurant-footfall.ts`、`src/lib/refund-net.ts`
