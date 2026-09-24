# 149・庫存：供應商 duplicate key／下拉選單／品項欄位 0 寬／報表口徑（2026-09-25）

四個問題一併處理（用戶回報 + 程式碼實證）。**已實作、未部署。**

## 0 背景：兩張表嘅關係

- `merchants` / `receipts` / `receipt_items` 喺 **expenseRecorder 專案**（`fjvfvpedklhdenavbcjg`），
  POS 經 `EXPENSE_SUPABASE_SERVICE_ROLE_KEY` 直連（`src/lib/expense-supabase.ts`）。
- `inv_products` / `inv_stock_movements` 喺 **POS 自己 DB**，靠 `sync-from-receipts` 由收據種子建立。

## 1 供應商新增 duplicate key

`POST /api/inventory/merchants` 係 `upsert(..., { onConflict: "user_id, name" })`。

- 若約束真係 `(user_id, name)` → 會合併，**唔會**報 23505。
- 既然報咗 `duplicate key value violates unique constraint …` ⇒ `merchants` 一定有
  **第二條 unique 冇被 onConflict 覆蓋**（最常見係 `name` 全表／跨店唯一）。

確診（二選一）：
1. 錯誤訊息入面個 constraint 名；
2. 喺 expenseRecorder SQL Editor 跑：
   ```sql
   select conname, pg_get_constraintdef(oid)
   from pg_constraint
   where conrelid = 'public.merchants'::regclass;
   ```

**處理**：`merchants/route.ts` POST 捕捉 `23505` / `42P10`：
- 本店已存在同名 → `409 ALREADY_EXISTS` + 回傳既有 supplier（前端 highlight）；
- 本店冇、撞跨店唯一 → `409 NAME_TAKEN`（**唔回傳 id**：唔可以畀本店掛起第二間店嘅 supplier）。
- `expense-inventory.ts resolveMerchantId()` 同步改：撞 key 時若本店已有同名就**复用**
  （唔好搞到成張收據存唔到）；本店冇先至 409。

## 2 供應商改下拉選單

- 新增 `GET /api/inventory/merchants?account=`（以 `user_id` 做店別 scope，讀全量）。
- `inventory-view.tsx` 收據 modal：`<input list>` + `datalist` → `<select>`（＋「手動輸入 / 新增供應商」）。
- payload 改送 `merchant_id`（`resolveMerchantId` 本來就優先認 id）⇒ **唔行 upsert ⇒ 唔會撞 unique**。
- 頁面嘅供應商清單亦改由 GET 讀全量（以前係由 range 過濾後嘅收據反推 ⇒ 冇收據嘅供應商永遠唔見、
  換 range 又會消失，係「新增咗但睇唔到」嘅根因）。
- 提示由頁面最頂搬到**供應商區入面**（綠＝成功／amber＝警告），撞「已存在」時 highlight 返嗰個。

## 3 品項欄位打唔到名（UI bug，已實證）

`inventory-view.tsx` 品項 row 以前係：

```tsx
<div className="flex items-end gap-2">
  <div className="min-w-0 flex-1"><input className={fieldCls} …/></div>
  <input className={`${fieldCls} w-28`} …/>
  <input className={`${fieldCls} w-20`} …/>
```

`fieldCls` 本身含 `w-full`；同一元素同時有 `w-full` 同 `w-28`，邊個生效取決於
**Tailwind 產生 CSS 嘅先後**，唔係 attribute 順序。本專案實測（Tailwind v4）：

```
idx w-20 = 4641 < idx w-28 = 4693 < idx w-full = 4745   ⇒ w-full 勝出
```

⇒ 單價／數量 flex-basis = 100% ⇒ `flex-1`（basis 0）嘅品名欄 shrink 分唔到、grow 冇剩餘空間
⇒ **實際寬度 0** ⇒ 睇唔到、撳唔到、打唔到字。

**處理**：改用 grid 固定軌寬（每格入面 `w-full` = 軌寬，唔會互相搶位）：

```tsx
<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2
                sm:grid-cols-[minmax(0,1fr)_7rem_5rem_auto]">
```

窄螢幕：品名 `col-span-2` 佔一整行，單價／數量／刪除第二行（點擊目標仍 ≥ 40px）。

守衛：`src/components/inventory/inventory-item-row-guard.test.ts`
（禁 `${…Cls} w-<number>`、要求 grid 軌寬／aria-label／select+merchant_id／merchants GET）。

## 4 庫存對報表嘅影響（口徑標示）

- `restaurant-daily-report.tsx` 毛利估算 = 營業額 − `purchase.sel.paid`
  （進貨 = **當日已付款收據總額**，係現金流口徑，**唔係 COGS**）。
- `shift-page.tsx` 交班記錄寫入 `purchase {paid, unpaid}`。
- 低庫存卡讀 `inv_products.current_qty ≤ reorder_level`；全 repo **冇落單扣庫存**，
  `current_qty` 只由「sync 種子＝累計採購量」＋人手盤點改動 ⇒ 盤點前基本唔會觸發。
- 🔴 舊寫法 `cogs = purchase.sel?.paid ?? 0`：admin 模式／`matched:false`／`schemaReady:false`／
  503 一律當 0 ⇒ **毛利＝營業額（毛利率 100%）**，報表講大話。

**處理**：加 `purchaseUnavailable` 旗標（admin、`matched:false`、`schemaReady:false`、null 一律為 true），
UI 顯示「注意：進貨數據未能讀取，未扣成本（＝營業額），僅供參考」，並停用同比 delta；
正常時亦標明「系統估算：營業額 − 進貨成本（當日已付收據）」。頁尾說明補上「落單暫不扣庫存」。

## 驗證

- `tsc --noEmit` 綠；eslint 0 error（restaurant-daily-report 剩 4 個既有 warning）。
- `node --test` 全綠（含新增 9 條守衛）。
- 未做瀏覽器驗證（庫存頁需要 POS 登入 + `EXPENSE_SUPABASE_*`，本機冇 env）。

## 上線前要確認

1. expenseRecorder 嘅 `merchants` unique 約束究竟係乜（見 §1 SQL）；
2. Vercel 有冇設 `EXPENSE_SUPABASE_URL` / `EXPENSE_SUPABASE_SERVICE_ROLE_KEY`
   （冇嘅話全個庫存頁 = 空，報表會顯示「進貨數據未能讀取」而唔再假扮 100% 毛利）。
