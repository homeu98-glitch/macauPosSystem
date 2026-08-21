# 41 · Kiosk 客人自點 P1 實作記錄

> 狀態：代碼完成（2026-08-20），待 dev box `npm run build` + 掃碼驗證 QR。
> 適用：餐飲（restaurant）。設計見 `docs/40-customer-self-order-kiosk.md`。

## 實作範圍（P1 證明流程）

### 已完成

1. **類型與設定**（`src/lib/types.ts` / `bootstrap-normalizer.ts` / `storage.ts` / `mock-data.ts`）
   - `MenuItem.customerOrderable?: boolean`（預設 `true`，normalize 時 `?? true`）
   - `PosLocalSettings.kioskKitchenMode: "auto" | "dine_in_confirm"`（預設 `"auto"`）
   - `normalizePosLocalSettings` 合併 `kioskKitchenMode`

2. **Kiosk 落單建構 / 推 Realtime / resume**（`src/lib/kiosk-order.ts`）
   - `buildKioskOrder`：建 `PosOrder`（堂食 + `dine_in_confirm` → `draft`；`auto` / 快餐 → `sent_to_kitchen`；快餐 `tableId="counter"` + 自取／外賣）
   - `buildKioskKitchenPrintJobs`：按 `printerGroup` 分區出廚房單（print agent 靠 `printerGroup` 搵真機，唔使 device config）
   - `submitKioskOrder`：推 `ORDER_CREATED` + `PRINT_JOB_CREATED` 去 `/api/pos/sync`（server service_role 寫入，**禁寫本地 localStorage**）；resume 時用 `ORDER_UPDATED` 重用同一 `order.id`
   - `fetchUnsettledKioskOrder`：按 `tableId` / `lastOrderId` resume 未結單
   - `loadKioskDeviceBinding` / `saveKioskDeviceBinding`：設備綁店（存部機 localStorage）

3. **收銀側 pos_orders Realtime 訂閱（即時見單）**
   - `src/lib/pos/supabase-client.ts`：POS 項目瀏覽器端 anon client（reuse `NEXT_PUBLIC_SUPABASE_*`）
   - `src/lib/pos/pos-order-mapper.ts`：`pos_orders` / `pos_print_jobs` / `pos_soldout` row → 領域物件
   - `src/lib/pos/use-pos-realtime.ts`：訂閱三張表（mirror `use-ledger-orders-realtime.ts`）
   - `src/components/pos-app.tsx`：接 `usePosRealtime` → `mergeOrderLists` 合併入 `orders`；`onPrintJobUpsert` 合併入 `printJobs`；堂食 `draft` 到達彈「X 枱已落單請確認」toast

4. **客人向 Kiosk 介面**（`src/app/order/page.tsx`）
   - 讀 `loadBootstrapCache() ?? mockBootstrap`（menu）；過濾 `customerOrderable !== false && !soldout`
   - 分類 + 公開菜 + 規格彈窗 + 購物車 + 落單 + 確認頁（單號／取餐號＋「請往收銀付款」）
   - 堂食（`?tableId=`）/ 快餐（自取／外賣）雙模式；`zh-HK` / `pt` / `en` 切換
   - 「設定」掣：綁 storeId + 語言（admin 密碼登入留後續）
   - 售罄 Realtime 訂閱（用 `usePosRealtime` 的 `onSoldoutUpsert`）

5. **「客人可點」toggle**（`src/components/device-settings.tsx`）：menu 編輯器每項加 checkbox，寫 `item.customerOrderable`（存 bootstrap）

6. **QR 生成工具**（`src/app/kiosk-qr/page.tsx` + `src/lib/qrcode.ts`）：按枱輸出 `/order?tableId=`，自帶 QR（byte mode, EC L, v1-5）+ 複製網址。**⚠️ QR encoder 自寫、未掃碼驗證**，部署前請實掃；掃唔到就用複製網址。

7. **SQL migration**（`supabase/migrations/0010_kiosk_realtime.sql`）：`pos_orders` / `pos_print_jobs` / `pos_soldout` 加入 `supabase_realtime` publication；建 `pos_soldout` 表；RLS 允許 anon `select`（落單內容無客人 PII）。多租戶隔離註解在 migration 內。

### 待驗證 / 後續

- **build**：sandbox 無 `node_modules`，未跑 `tsc` / `next build`。請喺 dev box `npm install && npm run lint && npm run build`。
- **QR 掃碼**：自寫 encoder 需實掃確認（見上）。
- **soldout 員工 toggle UI**：P1 只做 Kiosk 訂閱 + SQL 表；員工側「標售罄」寫 `pos_soldout` 的 UI 留 P2（可加喺 device-settings + `/api/pos/soldout`）。
- **admin 綁店密碼**：P1 只做 storeId + 語言綁定，無密碼閘；後續接 backoffice auth。
- **P2/P3**：固定平板硬化、線上付款（見 docs/40）。

## 資料流確認

```
客人掃枱 QR → /order?tableId=A01
  → 讀 menu（customerOrderable && !soldout）→ 落單
  → submitKioskOrder → POST /api/pos/sync（ORDER_CREATED + PRINT_JOB_CREATED，service_role 寫入）
  → 收銀 usePosRealtime 即時見單（merge 入 orders）+ flushPendingPrintJobs 出廚房單
  → 收銀結帳（P1 員工做，唔集成付款）
```

## 與「唔引入新依賴」約定

- 全程 reuse `@supabase/supabase-js`（已有）、React 19、Next 16。
- QR 用自寫 `src/lib/qrcode.ts`，**無**新增 npm 依賴。
