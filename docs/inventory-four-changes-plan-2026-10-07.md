# 庫存模組四項調整：定稿方案（J 已拍板）

> 2026-10-07 ｜ 依 J 決定：①每次同步（另補可擴展方案）②錄入時間 ③相片存在、非必填、新增單據內加「上傳單據照片」按鈕 ④相片存 expenseRecorder

---

## 0. J 的決定與對應

| 項目 | J 決定 | 我的調整 |
|---|---|---|
| 1 | 每次都同步 | ⚠️ **已提供替代方案**（見 §2.2「增量傳票」）—— 因為每次都同步的代價隨資料量**線性惡化** |
| 2 | 用錄入時間（`created_at`） | ✅ 需先修 API（SQL 有拉但回應丟掉） |
| 3 | 相片只是存、非必填，新增單據內加按鈕 | ✅ 失敗不阻擋儲存 |
| 4 | 相片存 **expenseRecorder** | ✅ 已確認 POS 用 **service_role** 直連，可繞過 RLS |

**關鍵技術前提（已核實）**：`src/lib/expense-supabase.ts` 用 **service_role key** 直連
expenseRecorder 專案（`fjvfvpedklhdenavbcjg`），**bypass RLS**。
⇒ 相片存 expenseRecorder **不需要**處理複雜的 Storage RLS policy，這是最大的好消息。

---

## 1. 🔴 先講一個必須面對的問題：你的決定會這樣老化

你選「每次都同步」。我尊重這個決定，但必須讓你看清楚成本曲線（**生產實測基線：31 品項**）：

| 品項數 | 每次進入頁面 | 每日（開 10 次） | 每月 |
|---|---|---|---|
| **31（現況）** | 31 次寫入 | 310 | 9,300 |
| 100 | 100 | 1,000 | 30,000 |
| 300 | 300 | 3,000 | 90,000 |
| 1,000 | 1,000 | 10,000 | **300,000** |

**根因不是同步本身，是 `syncFromReceipts` 的寫入方式**：

```ts
// inventory-products.ts:289-369 —— per-item 迴圈
for (const row of agg.values()) {
  const hit = existingByName.get(row.name.toLowerCase());
  if (hit) {
    await macau.from("inv_products").update({ ... }).eq("id", hit.id);   // ← 每個品項一次往返
  }
}
```

**即使資料完全沒變，也照樣 UPDATE 每一行。** 這是純浪費。

### 1.1 我可以先做「零語意改變」的優化（保留「每次都同步」）

**優化 A：只寫真的有變的行**

```ts
if (hit) {
  // 只在實際有差異時才寫（浮點用 0.005 容差避免四捨五入造成的假變化）
  const changed =
    Math.abs((hit.avg_unit_cost ?? 0) - avg) > 0.005 ||
    (row.last_date ?? null) !== (hit.last_purchase_date ?? null) ||
    (row.last_supplier ?? null) !== (hit.last_supplier ?? null) ||
    (row.category ?? null) !== (hit.category ?? null) ||
    Object.keys(baselinePatch).length > 0;
  if (!changed) { updated++; continue; }   // ← 零寫入
  await macau.from("inv_products").update({ ... }).eq("id", hit.id);
}
```

**效果**：日常（無新收據）從 31 次寫入 → **0 次**。仍然「每次都同步」，但成本塌縮。

**優化 B：批次寫入（品項多時必要）— ⚠️ 有阻礙**

直覺做法是 `upsert(rows, { onConflict: "store_id,name" })` 一次寫多行。
**但已核實（`0013_inv_products.sql:34-35`）唯一索引是函數索引**：

```sql
create unique index inv_products_store_name_uniq
  on inv_products (store_id, lower(name));   -- ← lower(name) 係函數！
```

PostgREST 嘅 `onConflict` **只接受純欄位名**，唔支援函數索引
⇒ 直接用 `onConflict: "store_id,name"` 會回
`there is no unique or exclusion constraint matching the ON CONFLICT specification`。

**三個選項：**

| 選項 | 做法 | 判斷 |
|---|---|---|
| B1. 加普通 unique 約束 | `alter table add constraint ... unique (store_id, name)` | ⚠️ 會改變唯一性語義（變成大小寫敏感）—— 可能產生「可樂」與「可乐」兩筆，**唔建議** |
| B2. 用 RPC 做 DB 側批次 upsert | 寫 plpgsql function，內部處理 `lower(name)` | ✅ 可行但工作量大 |
| B3. **唔做批次，只做優化 A** | 日常（無新收據）= 0 次寫入 | ✅ **建議** |

**⇒ 建議只做優化 A。** 優化 A 已經解決咗 99% 嘅場景（日常開頁面零寫入）。
真正有變動時（新收據進來）多寫幾個品項係**合理成本**，唔值得為此加複雜度。

### 1.2 替代方案：「增量傳票」（如果資料量真的會大增）

如果將來品項過 300，建議改成 **event-driven**：

```
收據寫入時，該張收據影響的品項名單 → 只重算這幾個品項
```

```ts
// /api/inventory/receipts POST 成功後
const touchedNames = items.map(i => i.name.trim());
await syncFromReceipts(macau, store, expense, userId, { onlyNames: touchedNames });
```

- 新增一張收據 ⇒ 只重算那幾個品項，**O(1)** 而非 O(N)
- 仍然保留「進入頁面同步」作為**兜底**（處理漏網：例如直接在 expenseRecorder 改資料）

**成本**：需要 `syncFromReceipts` 加 `onlyNames` 參數，但它仍需讀全部收據來聚合（除非改寫 SQL）。
⇒ 真正的 O(1) 要改成 DB 側聚合 RPC。**建議等品項過 300 再做，現在不急。**

---

## 2. 四項具體做法

### 項目 1：庫存表預設收合

#### 做法

```tsx
// inventory-table.tsx
const [expanded, setExpanded] = useState(false);
const COLLAPSED_LIMIT = 6;

const lowStockItems = products.filter(p => p.reorder_level > 0 && p.current_qty < p.reorder_level);
const normalItems   = products.filter(p => !(p.reorder_level > 0 && p.current_qty < p.reorder_level));

// 🔴 低庫存永遠顯示（唔可以收埋需要行動嘅資訊）
const visible = expanded ? products : [...lowStockItems, ...normalItems.slice(0, COLLAPSED_LIMIT)];
const hiddenCount = products.length - visible.length;
```

UI：
```
┌────────────────────────────────────────────────────┐
│ 庫存表（POS 內建・31 個）        基於 expenseRecorder 收據│
│                              [從收據同步] [＋新增庫存品] │
├────────────────────────────────────────────────────┤
│ ┌────────┐ ┌─────────────┐ ┌──────────┐            │
│ │品項數  │ │庫存總值(成本)│ │低庫存警示 │            │
│ │  31    │ │ MOP 3,570.01│ │    0     │            │
│ └────────┘ └─────────────┘ └──────────┘            │
│                                                     │
│ （低庫存 0 個 ⇒ 無警示區塊）                          │
│                                                     │
│ ── 全部品項（31） ──────────  [展開全部（仲有 25）▾] │
│ ┌──────┐ ┌──────┐ ┌──────┐                         │
│ │(隻)  │ │中盧魚│ │冬瓜  │  ← 只顯示 6 個           │
│ │黃油雞│ │      │ │      │                         │
│ └──────┘ └──────┘ └──────┘                         │
└────────────────────────────────────────────────────┘
```

**注意事項**
1. 🔴 **低庫存品項絕對不可收埋**（收合是減噪音，不是隱藏警示）
2. 展開按鈕要顯示**剩餘數量**（「仲有 25 個」），否則商家不知值不值得展開
3. **同步後保持展開狀態**（若展開中，reload 不應彈回收合）
4. `embedded` 模式（設置 panel 內）用同一套邏輯，避免兩處行為不一致

#### 影響範圍

| 檔案 | 改動 |
|---|---|
| `src/components/inventory/inventory-table.tsx` | `expanded` state、分組、展開器 |
| `src/lib/inventory-products.ts` | 加 `listProductsSummary()`（可選，見下） |
| `src/app/api/inventory/products/route.ts` | 加 `?fields=summary`（可選） |
| `src/app/api/inventory/products/[id]/route.ts` | 🔴 **需新增 GET**（目前只有 PATCH+DELETE） |
| 守衛測試 | 低庫存不可收埋、展開器顯示剩餘數 |

**關於 API 欄位精簡**：31 行 = 12.6 KB，**不算嚴重**。
若要省，注意 🔴 編輯 modal 需要 `note` ⇒ 必須先補 `GET /api/inventory/products/[id]`，
否則會**靜默清空商家備註**。**建議先只做前端收合**（第 1 層），欄位精簡延後。

---

### 項目 2：每次進入頁面自動同步

#### 做法

```tsx
// inventory-table.tsx
const [syncing, setSyncing] = useState(false);
const didAutoSync = useRef(false);   // 🔴 同一 mount 只做一次

useEffect(() => {
  if (!merchantId || !account || didAutoSync.current) return;
  didAutoSync.current = true;
  void (async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/inventory/products/sync-from-receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ store: merchantId, account, mode: "auto" }),
      });
      const json = await res.json();
      // 🔴 靜默：只有真的有變化才提示
      if (json.ok && (json.summary?.created > 0 || json.summary?.updated > 0)) {
        setSyncMsg(`已自動同步：新增 ${json.summary.created}、更新 ${json.summary.updated}`);
      }
      void loadProducts();
    } catch { /* 離線時靜默失敗，唔阻 UI */ }
    finally { setSyncing(false); }
  })();
}, [merchantId, account]);   // 🔴 唔可以包 loadProducts（無限迴圈）
```

**觸發時機（明確）**

| 時機 | 觸發 | 理由 |
|---|---|---|
| 首次進入庫存頁 | ✅ | 你要求 |
| 切到「品項分析」分頁 | ✅ | 分析最需要新資料 |
| 新增／編輯／刪除收據後 | ✅ | **資料真正變化** |
| 手動按「從收據同步」 | ✅ | 永遠保留 |
| 頁面 reload | ✅ | 新 mount |

#### 🔴 注意事項

1. **`useEffect` deps 不可包 `loadProducts`** → 無限同步迴圈（用 `useRef` 擋）
2. **靜默原則**：沒變化時不彈提示（否則每次進頁面都跳「同步完成：新增 0 個」）
3. **離線要靜默降級**（POS 支援離線模式，不可彈錯擋住 UI）
4. **`updated` 數字要靠 §1.1 優化 A 才有意義** —— 否則永遠顯示「更新 31 個」，商家會以為有問題
5. ⚠️ **並發**：兩部 iPad 同時同步可能撞 duplicate key。現有邏輯會降級成 update（`inventory-products.ts:335`），但要**寫測試證明不會產生重複品項**
6. ✅ **基準價安全**：只在 NULL 時寫入，重複同步不會覆寫

#### 影響範圍

| 檔案 | 改動 |
|---|---|
| `src/components/inventory/inventory-table.tsx` | mount 自動同步 + `syncing` indicator |
| `src/lib/inventory-products.ts` | **優化 A：只寫有變的行**（必要，否則每次 31 次白寫） |
| `src/app/api/inventory/products/sync-from-receipts/route.ts` | 接 `mode` 參數 |
| `src/app/api/inventory/receipts/route.ts` | 寫入後觸發（fire-and-forget，**不可 await**） |

---

### 項目 3：收據時間顯示到秒（用錄入時間）

#### 現況（已實測）

**兩個發現：**
1. `receipts.receipt_date` 是 **`date` 型別** ⇒ 本身沒有時分秒
2. 🔴 **API 回應沒有 `created_at`**（實測 10 個欄位）：

```
id, total_amount, receipt_date, merchant_id, merchant_name,
payment_method, payment_status, category, raw_ocr_data, items
```

`receipts/route.ts:116` 的 SQL **有** `select("..., created_at")`，但 L201-212 組裝 `enriched` 時**丟掉了**。

#### 做法（三處改動）

```ts
// 1) receipts/route.ts —— 補回 created_at
const enriched = statReceipts.map((sr) => {
  const raw = (receipts ?? []).find((r) => r.id === sr.id);
  return {
    ...原有,
    created_at: typeof raw?.created_at === "string" ? raw.created_at : null,
  };
});
```

```ts
// 2) src/lib/inventory-stats.ts —— 純函式（可測）
/**
 * 收據時間戳：日期 + 錄入時間到秒。
 * 🔴 receipt_date 係 date 型別冇時分秒 ⇒ 時分秒一定黎自 created_at（錄入時間）。
 * 🔴 一定要用 Asia/Macau；用 toISOString() 會令澳門凌晨 0–8 點顯示成前一日。
 */
export function formatReceiptStamp(receiptDate: string, createdAt: string | null): string {
  const d = (receiptDate || "").replace(/-/g, "/");
  if (!createdAt) return d || "—";
  const t = new Date(createdAt);
  if (Number.isNaN(t.getTime())) return d || "—";
  const mo = new Date(t.toLocaleString("en-US", { timeZone: "Asia/Macau" }));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d} ${pad(mo.getHours())}:${pad(mo.getMinutes())}:${pad(mo.getSeconds())}`;
}
```

```tsx
// 3) inventory-view.tsx —— Receipt type 加 created_at，取代 {r.receipt_date}
<div className="mt-0.5 text-xs text-slate-500">
  {formatReceiptStamp(r.receipt_date, r.created_at)}
  {lineNo ? ` ・ #${lineNo}` : ""} ・ {r.items.length} 項
</div>
```

顯示：`2026/10/07 14:32:05`

#### 注意事項

1. 🔴 **時區必須 `Asia/Macau`**（`toISOString()` 會少 8 小時）
2. `created_at` 可能 null（舊資料）⇒ fallback 只出日期，**不可出 `Invalid Date`**
3. ⚠️ **收據 modal 內的 `<input type="date">` 保持 `YYYY-MM-DD`**，不可跟顯示格式改（否則 date input 失效）
4. ⚠️ **排序邏輯不可由 `receipt_date` 改成 `created_at`**（會改變商家預期的次序）
5. ℹ️ 建議 UI 標明這是錄入時間（例如小字），因為它 ≠ 單據時間

#### 影響範圍

| 檔案 | 改動 |
|---|---|
| `src/lib/inventory-stats.ts` | 加 `formatReceiptStamp()` |
| `src/lib/inventory-stats.test.ts` | 加測試（含時區邊界） |
| `src/app/api/inventory/receipts/route.ts` | `enriched` 補 `created_at` |
| `src/components/inventory/inventory-view.tsx` | type + 顯示 |

---

### 項目 4A：品類必填

#### 做法

```tsx
// inventory-view.tsx save()
if (!form.merchant_id && !form.merchant_name.trim()) return setErr("請選擇或輸入供應商");
if (!form.date) return setErr("請選擇收據日期");
if (!form.category.trim()) return setErr("請選擇或填寫品類");   // ← 新增
```

配套（缺一不可）：
1. Label 加紅色 `*`，`品類` 改成 `品類 *`
2. **移除「不指定」chip**（既然必填，不該有這個選項）
3. **清單為空時引導**：若 `categoryOptions.length === 0`，除了手動輸入，加一句
   「可到『設置 → 品類』建立常用清單」
4. 🔴 **編輯既有收據**：舊收據 `category` 可能為空 ⇒ 開 modal 即「未填」。
   要在 modal 頂加提示：「此收據未填品類，請補選後儲存」

#### Server 端驗證（🔴 需先確認呼叫端）

```ts
// receipts/route.ts POST
if (body.raw ? ... : !body.category?.trim()) {
  return NextResponse.json({ ok: false, error: "缺少 category" }, { status: 400 });
}
```

⚠️ **加驗證前必須 grep 全部呼叫端**。若插件／批量匯入也在 POST，會令那邊 400。
建議：**只對 `input_method: "pos_manual"` 強制**，其他來源保持寬鬆。

#### 附帶好處

`syncFromReceipts` 會用 `r.raw_ocr_data.category` 覆蓋 `inv_products.category`
⇒ 收據必填品類後，**庫存品分類會自動變準**。

#### 影響範圍

| 檔案 | 改動 |
|---|---|
| `src/components/inventory/inventory-view.tsx` | 驗證 + label + 移除「不指定」 |
| `src/app/api/inventory/receipts/route.ts` | server 驗證（限 `pos_manual`） |
| 守衛測試 | 必填驗證存在 |

---

### 項目 4B：拍照／上傳單據（存 expenseRecorder）

#### 4B.1 架構（已依你的決定調整）

```
┌─ iPad 前端 ─────────────────────────────────────┐
│ 新增收據 modal                                  │
│  ┌──────────────────────────────────────────┐  │
│  │ [📷 上傳單據照片]  ← 新增按鈕（非必填）    │  │
│  │ ┌────┐ ┌────┐                            │  │
│  │ │縮圖│ │縮圖│  ← 已選相片預覽，可刪除      │  │
│  │ └────┘ └────┘                            │  │
│  └──────────────────────────────────────────┘  │
│  1. <input type="file" accept="image/*">        │
│  2. canvas 壓縮（max 1600px, q0.8）              │
│  3. POST /api/inventory/receipt-photos          │
└─────────────────────────────────────────────────┘
                    ↓ service_role（bypass RLS）
┌─ POS 後端 ──────────────────────────────────────┐
│ POST /api/inventory/receipt-photos              │
│  · expense.storage.from("receipt-photos")       │
│      .upload(path, buffer)                      │
│  · path: {userId}/{yyyy-mm}/{uuid}.jpg          │
│  · 回 { ok, path }                              │
└─────────────────────────────────────────────────┘
                    ↓
┌─ expenseRecorder DB ────────────────────────────┐
│ receipts.raw_ocr_data = {                       │
│   receipt_number, category, payment_method,     │
│   payment_status, input_method,                 │
│   photo_paths: ["...uuid.jpg"]   ← 新增         │
│ }                                               │
│ ✅ raw_ocr_data 已係 JSONB ⇒ 零 migration！      │
└─────────────────────────────────────────────────┘
```

#### 4B.2 🔴 為什麼存 expenseRecorder 是好選擇

已核實 `expense-supabase.ts` 用 **service_role key**（`bypass RLS`）：
- ✅ **不需要**寫複雜的 Storage RLS policy（這是原本最大的風險）
- ✅ 相片與收據同一個專案 ⇒ 不會有跨專案孤兒檔案
- ✅ `raw_ocr_data` 是現成 JSONB ⇒ **零 migration**

⚠️ 但仍要處理：
- **Bucket 要存在**（見 4B.3）
- Bucket 若設為 private，顯示時要用 `createSignedUrl()`（service_role 可簽）

#### 4B.3 Bucket 建立

Supabase Dashboard 手動建立（或 SQL）：

```sql
-- 在 expenseRecorder 專案執行
insert into storage.buckets (id, name, public)
values ('receipt-photos', 'receipt-photos', false)   -- private
on conflict (id) do nothing;
```

**建議 private**：收據相片含供應商、金額，不應公開。
顯示時用 `createSignedUrl(path, 3600)`（service_role 簽，1 小時有效）。

#### 4B.4 前端關鍵實作

> ⚠️ 本節保留**設計原意**；實際落地版本見 §6「P3 實作記錄」——裡面有幾個
> 第一版設計被實測推翻的地方（`sr-only`、`maxEdge 1600`、獨立說明行）。

**① 輸入（不加 `capture`）**

```tsx
<input
  ref={photoInputRef}
  type="file"
  accept="image/*"
  multiple
  className="sr-only"
  onChange={handlePhotos}
/>
<button type="button" onClick={() => photoInputRef.current?.click()}
  className="min-h-[48px] rounded-xl bg-slate-100 px-4 py-3 text-base font-medium text-slate-700">
  📷 上傳單據照片
</button>
```

⚠️ **不要加 `capture="environment"`** —— iOS 會直接開相機、跳過「選相片」。
不加的話，iOS 會彈「拍照 / 相片圖庫 / 瀏覽」三選單，符合你「拍照或上傳」的需求。

🔴🔴 **但 `className="sr-only"` 唔可以用**（實測 2026-10-07）：本專案從未用過
`sr-only`，Tailwind v4 JIT 只為「實際出現過」的 class 生成 CSS ⇒ dev server
產出的 CSS **完全冇 `.sr-only`** ⇒ 原生 file input 原樣顯示（連
「未選擇任何檔案」都出埋）。✅ 改用 inline `style`（詳見 §6.4）。

**② 壓縮（必要，不是優化）**

```ts
/**
 * 縮到最長邊 1600px、JPEG q0.8。
 * iPad 原相 3–8 MB ⇒ ~300 KB。單據文字仍清晰可讀。
 */
export async function compressImage(file: File, maxEdge = 1600, quality = 0.8): Promise<Blob> {
  const bitmap = await createImageBitmap(file);   // 🔴 自動套用 EXIF 方向
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b!), "image/jpeg", quality));
}
```

**③ 失敗不阻擋儲存（你的要求）**

```ts
// 儲存收據時：先把已上傳成功的 photo_paths 帶上；
// 若有相片上傳失敗，只警告，不阻止儲存
if (failedPhotoCount > 0) {
  setWarn(`有 ${failedPhotoCount} 張相片上傳失敗，收據仍會儲存。`);
}
```

#### 4B.5 影響範圍

| 檔案 | 改動 |
|---|---|
| `src/app/api/inventory/receipt-photos/route.ts` | **新增**：上傳端點（service_role） |
| `src/lib/image-compress.ts` | **新增**：純前端壓縮（可測） |
| `src/components/inventory/inventory-view.tsx` | 「上傳單據照片」按鈕 + 縮圖預覽 |
| `src/app/api/inventory/receipts/route.ts` | 接 `photo_paths` 寫入 `raw_ocr_data` |
| `src/lib/inventory-stats.ts` | `StatReceipt` 加 `photo_paths?: string[]`（可選） |
| 守衛測試 | 上傳端點存在、壓縮函式、必填非阻擋 |
| Supabase（expense 專案） | 建 bucket `receipt-photos`（private） |

#### 4B.6 🔴 注意事項

1. **相片上傳失敗時，收據仍要存**（你的明確要求）—— 不可因相片失敗而讓商家填的一堆品項白費
2. **上傳進度必須可見**：3 MB 相片上餐廳 WiFi 需 5–15 秒。無進度商家會重複按 ⇒ 產生重複相片
3. **`.click()` 需在 user gesture 內**：`photoInputRef.current?.click()` 必須在按鈕 onClick 直接呼叫，不可包在 async 之後（iOS 會封鎖）
4. **HEIC 問題**：iPhone/iPad 預設 HEIC。`<input>` 上傳時 Safari 會自動轉 JPEG，且 canvas 壓縮保證輸出 JPEG ⇒ 雙重保險
5. **EXIF 方向**：`createImageBitmap` 會自動套用（正確）。若要支援更舊 iOS 的 `new Image()` fallback，要手動處理方向
6. **容量規劃**：300 KB × 每日 20 張 = 6 MB/日 = **~180 MB/月**。expenseRecorder 免費方案 1 GB ⇒ 約 5–6 個月要留意
7. **`raw_ocr_data` 已被 PATCH 用 merge 方式寫入（已核實，好消息）**：
   `receipts/[id]/route.ts:57-59` 係
   `update.raw_ocr_data = { ...(cur?.raw_ocr_data ?? {}), ...raw }` ——
   頂層 merge ⇒ 只要編輯 payload **唔包含** `photo_paths`，相片路徑就會保留。

   ⚠️ **但呢個係雙面刃**，要寫清楚語意：
   | 前端行為 | `photo_paths` 結果 | 判斷 |
   |---|---|---|
   | 完全唔送 `photo_paths` | 保留原有 | ✅ 正確（唔想改相片） |
   | 送 `photo_paths: []` | **覆蓋成空** | ✅ 正確（商家主動刪光相片） |
   | 送新陣列 | 覆蓋 | ✅ 正確（加了新相片） |

   ⇒ PATCH route 要加：`if (body.photo_paths !== undefined) raw.photo_paths = body.photo_paths;`
   **用 `!== undefined` 判斷**（唔可以用 `if (body.photo_paths)` —— 空陣列係 falsy，
   會令「刪光相片」呢個動作靜默失效）。

8. **刪除收據時要一併刪相片**（否則 Storage 累積孤兒檔案）

---

## 3. 建議實施順序

| 批次 | 內容 | 風險 | 狀態 |
|---|---|---|---|
| **P1** | 項目 3（時間格式）＋ 項目 1（前端收合）＋ 項目 4A（品類必填） | 低 | ✅ **已完成**（commit `bae01f6`） |
| **P2** | 項目 2（自動同步）＋ **優化 A（只寫有變的行）** | 中 | ✅ **已完成**（見 §5） |
| **P3** | 項目 4B（拍照上傳） | 中高 | ✅ **已完成**（見 §6） |

**每批之間跑全套測試**（P1 後基線：**1907 tests** ⇒ P2 後：**1947 tests / 0 fail**
⇒ P3 後：**2196 tests / 0 fail**）。

> ✅ **2026-10-07 已清零**：P3 完成時全庫仍有 4 個 fail，追查後發現**兩個係既有真 bug
> ＋ 兩個係測試寫得太死**（P3 本身無關）。詳見 §7。

---

## 5. P2 實作記錄（2026-10-07）

### 5.1 優化 A：只寫有變的行

**新增** `src/lib/inventory-sync-diff.ts`（零 import 純函式，可被 `node --test` 直接測）：

| 匯出 | 作用 |
|---|---|
| `hasMaterialChange(target, current, hasBaselinePatch)` | 逐欄比對，有實質差異才回 `true` |
| `shouldWriteBaseline(currentBaseline, candidate)` | 基準價只喺 NULL 時鎖一次 |
| `syncSummaryText({created, updated, skipped_unchanged})` | 砌提示；**無變化回 `null`**（靜默原則） |
| `COST_EPSILON = 0.005` | 浮點容差 |

**`inventory-products.ts` 改動**：
- update 分支加 `hasMaterialChange` 短路 ⇒ 冇變化 `skippedUnchanged += 1; continue;`（**零寫入**）
- `SyncSummary` 加 `skipped_unchanged`
- 🔴 **順手修一個潛伏 bug**：duplicate-key fallback 路徑原本用
  `Number(dupRows?.baseline_unit_cost) > 0` 判斷「有冇基準」——
  `Number(null) === 0`、`Number(undefined) === NaN`，而且**基準價可以係 0**（免費贈品）
  ⇒ 會誤判成「未有基準」而反覆覆寫，令基準價飄移。
  改用同主路徑一致嘅 `shouldWriteBaseline()`。

**效果**：日常（冇新收據）由 N 次寫入 → **0 次**。1,000 品項時每月省 30 萬次寫入。

### 5.2 項目 2：進入頁面自動同步

**觸發點（三處）**：

| 位置 | 做法 |
|---|---|
| 庫存表 mount | `didAutoSync` ref 擋，`deps = [merchantId, account]` |
| 品項分析 mount | 同上 |
| 收據新增／編輯／刪除後 | `syncProductsAfterReceiptWrite()` —— **fire-and-forget**，有變化才 `setProductsVersion` 重載 |

**🔴 靜默原則（關鍵）**：
- 自動同步：冇變化**唔出提示**、失敗**唔彈紅字**（POS 支援離線，唔可以擋 UI）
- 手動按掣：永遠有完整回饋（「同步完成：新增 0 個，更新 0 個（略過 34 個無變化…）」）
- 為何重要：加咗優化 A 之後 `updated` 係**真正寫入數**，
  冇變化時顯示「更新 31 個」會令商家以為系統壞咗

**`mode` 參數**：只係 log 標籤，**唔做任何行為分支** ——
保證「手動同步嘅結果永遠同自動一樣」。

### 5.3 驗證

| 項目 | 結果 |
|---|---|
| `inventory-sync-diff.test.ts` | 22 pass（容差邊界、null/空字串等價、基準價 0） |
| `inventory-p2-guard.test.ts` | 18 pass（源碼掃描守衛） |
| 全量 `node --test src/lib/**/*.test.ts` | **1947 pass / 0 fail** |
| `tsc --noEmit` | 0 error |
| ESLint（5 個改動檔） | 0 訊息 |
| 真實 Chrome headless | **14 pass / 0 fail** |

**實測 sync 呼叫序列：`auto, auto, manual, auto`**
= 進庫存頁 1 次 + 重載後 1 次 + 手動 1 次 + 切分析頁 1 次 ⇒ **完全冇迴圈**。

截圖：`docs/mockups/p2-verify-2026-10-07/`（4 張）。

### 5.4 ⚠️ 驗證踩過嘅坑

**守衛測試唔可以「`indexOf` + 固定窗口」**：
`stripComments()` 會把 `//` 註解換成 **200 個空白**，
所以由 marker 往後切 400–500 字，真實斷言目標可能落在被清空嘅註解區**之外** ⇒
報一個完全唔存在嘅假 failure。✅ 正解：用括號追蹤搵返 effect 邊界
（見 `effectDepsAfter()`），或者把窗口放寬到 1200 字。


---

## 6. P3 實作記錄（2026-10-07）

### 6.1 交付清單

| 檔案 | 狀態 | 內容 |
|---|---|---|
| `src/lib/image-compress-plan.ts` | **新增** | 壓縮**決策邏輯**（零 import，可 `node --test`）。`MAX_UPLOAD_BYTES=200*1024`、`MAX_EDGE=1600`、`QUALITY_LADDER=[0.82,0.72,0.62,0.5]`、`EDGE_LADDER=[1600,1280,1024,800]`、`buildCompressPlan`、`fitWithin`（**永不放大**）、`isWithinLimit`（**嚴格 `<`**）、`humanSize` |
| `src/lib/image-compress-plan.test.ts` | **新增** | 30 條 |
| `src/lib/image-compress.ts` | **新增** | 瀏覽器端機械壓縮。`createImageBitmap`（自動 EXIF）→ fallback `<img>`+`createObjectURL`；`renderJpeg` 先填白底再 `drawImage`（PNG 透明 → 白）；**走完梯級仍超標就回 `ok:false`，永不回原檔** |
| `src/app/api/inventory/receipt-photos/route.ts` | **新增** | `POST`（multipart，server 端**再驗** 200KB／MIME；超標 413、類型 415、缺 bucket 503 `code:BUCKET_MISSING`）；`DELETE`（只刪 `${userId}/` 前綴，**移除失敗只 warn、永遠回 ok**） |
| `src/app/api/inventory/receipt-photos/url/route.ts` | **新增** | `GET` → `{urls:{path:signedUrl},expiresIn:3600}`。用 `createSignedUrl`（bucket 係 private），**逐條簽**（唔用 batch，免一錯全滅） |
| `src/lib/expense-inventory.ts` | 改 | `InventoryReceiptInput.photo_paths?`；新增 `sanitizePhotoPaths()`（trim／濾空／濾 `/` 開頭／濾 `..`／去重，**永遠回新陣列**，令 `[]` 保持語意） |
| `src/app/api/inventory/receipts/route.ts` | 改 | GET 的 `enriched` 帶 `photo_paths`；POST 寫入 `raw_ocr_data.photo_paths` |
| `src/app/api/inventory/receipts/[id]/route.ts` | 改 | PATCH `if (body.photo_paths !== undefined)`（**唔用 truthiness**）；DELETE 先讀出路徑 → 刪 items → 刪 row → 成功後才刪 Storage 相片，回 `{ok, photosDeleted}` |
| `src/components/inventory/inventory-view.tsx` | 改 | 見 6.3 |
| `src/lib/inventory-p3-photo-guard.test.ts` | **新增** | 39 條原始碼掃描守衛 |

**Supabase 一次性設定**（expenseRecorder 專案，`fjvfvpedklhdenavbcjg`）：
```sql
insert into storage.buckets (id, name, public)
values ('receipt-photos', 'receipt-photos', false)   -- private
on conflict (id) do nothing;
```
⚠️ 因為 route 用 `getExpenseSupabaseClient()`（**service_role**）⇒ 繞過 RLS ⇒
**唔需要寫任何 Storage RLS policy**。

### 6.2 三態契約（本批最易踩嘅陷阱）

| 前端送 | 結果 | 判斷 |
|---|---|---|
| 唔送 `photo_paths` | 保留原有 | ✅ 唔想動相片 |
| 送 `photo_paths: []` | **清空** | ✅ 商家刪光相片 |
| 送新陣列 | 覆蓋 | ✅ 加／減相片 |

🔴 一定要寫成 `if (body.photo_paths !== undefined)`。
寫 `if (body.photo_paths)` 會令「**刪光相片**」靜默失效（空陣列係 falsy）。
→ 2 條守衛測試專門盯呢一點。

### 6.3 前端要點

- `useSignedPhotoUrls(account, paths)`：deps 用**join 出嚟嘅字串**，
  唔可以用 `paths`（每次 render identity 都變 ⇒ 無限重簽）。
- 縮圖用 **單行橫向捲動**（`flex-nowrap overflow-x-auto`）：高度**永遠一行**，
  唔受張數影響。用 `flex-wrap` 的話第 4–5 張就會把下面嘅品項／合計推出可視區。
- 收據卡片只顯示 `📷 N` badge，**唔喺列表度簽縮圖**（否則一頁簽 N 條 URL）。
- 儲存流程：**先上傳相片** → `photoPaths = [...form.photo_paths, ...upload.paths]`
  → 永遠送 `photo_paths`。`failed > 0` ⇒ `window.alert("收據已儲存，但有 N 張相片上傳失敗…")`。
  **收據永遠照存**（J 明確要求）。

### 6.4 🔴 兩個實測推翻設計嘅坑

**① `sr-only` 完全冇效（最陰險）**

本專案**從未**用過 `sr-only`。Tailwind v4 係 JIT，**只為實際出現過嘅 class 生成 CSS**
⇒ 檢查 dev server 產出嘅 CSS：`sr-only found: false`
⇒ 個原生 file input **原樣顯示**（連「未選擇任何檔案」都出埋），
但**代碼睇落完全正確**。✅ 改用 inline style：

```jsx
style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1,
         overflow: "hidden", clip: "rect(0,0,0,0)", whiteSpace: "nowrap", border: 0 }}
```

⚠️ **我當時嘅測試係「錯」嘅**：只 assert `className.includes("sr-only")` ⇒ 綠燈但功能爆。
→ 已改成**量實際 bounding box**（`visW<=2 && visH<=2`）+ assert 唔可以出現「未選擇任何檔案」。

**② modal 高度係硬約束：所有說明文字必須併入標題行**

收據 modal = `max-h-[92vh] overflow-y-auto`，上面已有供應商／品類／日期／付款方式／付款狀態五區。
第一版寫咗三段獨立說明（移除提示／虛線框含義／200KB）＝ **+48px**，
令相片縮圖 bottom **922px** > 面板 bottom **864px** ⇒ **整行被裁切**。

✅ 最終做法（零額外高度）：
- 「付款狀態」提示 → 移到 label 同一行（`flex-wrap items-baseline justify-between`）
- 「單據照片」提示 → 同樣併入 label 行：
  - 冇相：`自動壓縮至 200KB 以下`
  - 有相：`共 N 張・虛線＝未上傳`
- 縮圖由 `h-14 w-14` 收窄到 **`h-12 w-12`**

實測（1280×900，最差情況）：縮圖 bottom **892**、面板 bottom **864** ⇒
越界 **28px**（48px 高縮圖見到 20px）。已收窄至接受範圍。

### 6.5 驗證

| 項目 | 結果 |
|---|---|
| `node --test "src/**/*.test.ts"` | **2195 tests / 2191 pass / 4 fail**（4 個係既有，見 §3 註） |
| `tsc --noEmit` | **0 error** |
| ESLint（16 個 P3 檔案） | **0 error / 0 warning** |
| 真實 Chrome headless（2 情境） | **24 / 24 PASS** |

實機驗證涵蓋：
- 上傳掣 ≥40px（實測 52px）、`accept=image/*`、`multiple`、
  **冇 `capture`**（保住 iOS「選相片」）、file input **實際 1×1**、
  冇原生「未選擇任何檔案」文案
- 揀相 → 壓縮 → 待上傳縮圖（虛線框）+ 大小標示 + ✕ 移除
- 已存相片 → **signed URL** 縮圖 ×2 + ✕ 移除
- **儲存 payload 只帶剩下的 1 條**（`["66123456/2026-10/def.jpg"]`）
  ⇒ 證明「`[]` 清空」同「部分移除」都正確（唔係 `undefined`、亦唔係 2）
- 兩個情境都 **0 個真實 page error**（已濾 mock env 噪音）

截圖：`docs/mockups/p3-photo-verify-2026-10-07/`（4 張）。

### 6.6 ⚠️ 尚未做（部署前必做）

**Bucket 未建立。** 到生產環境要**先**在 expenseRecorder 專案執行 §6.1 嘅 SQL，
否則上傳會回 `503 { code:"BUCKET_MISSING" }`。
（端點已設計成優雅降級：收據照存，只係冇相片。）


---

## 7. 清零既有 4 個 fail（2026-10-07 · J 指示）

J 指示：「4 個既有 fail 修掉再一起上」。

先用 `git stash -u` 暫存全部 P3 改動、重跑 `main` 確認：**4 個 fail 確實係既有**。
追查後分成兩類 —— **2 個係真 bug、2 個係測試寫得太死**。

### 7.1 🔴🔴 真 bug：duplicate-key 補插路徑會靜默清空商家資料

**位置**：`src/lib/inventory-products.ts` 嘅 `duplicate key|unique constraint` 分支。

**病徵**：呢條路徑原本只 `select("id, baseline_unit_cost")`，然後直接寫
`last_purchase_date: row.last_date` / `last_supplier: row.last_supplier` / `category: row.category`
—— **冇**主路徑嗰個 `?? 現有值` 降級。

而 `row.last_date` / `row.last_supplier` / `row.category` 係可以係 **`null`**
（該品項今次掃到嘅收據冇日期／供應商／品類）。

⇒ 一旦走 duplicate-key 補插（兩部機同時新建同名品項、或同步撞名），
會把商家已經填好嘅 `last_supplier` / `category` **靜默清空成 `null`** —— **資料無聲損失**。

**為何之前冇人發現**：主路徑（`hit` 存在）行為正確，而 duplicate-key 只在併發／撞名時才走，
平常測試路徑踩唔到。呢個正是 P2 文件自己寫過嘅警語（「兩行一定要同 update payload 對齊」）的漏網之魚。

**修法**：
```ts
.select("id, baseline_unit_cost, last_purchase_date, last_supplier, category")  // 補齊三欄
...
const dupNextLastDate =
  row.last_date ?? (dupRows?.last_purchase_date as string | null | undefined) ?? null;
const dupNextLastSupplier = row.last_supplier ?? (dupRows?.last_supplier ...) ?? null;
const dupNextCategory = row.category ?? (dupRows?.category ...) ?? null;
```

**回歸守衛**（`inventory-contract-guard.test.ts`）：
「🔴 duplicate-key 路徑唔可以用 null 覆蓋既有嘅日期／供應商／品類」——
① select 必須包含三個欄位；② update payload 唔可以直接寫 `col: row.x`；
③ 至少 3 個 `row.x ??` 降級。

✅ **已驗證守衛有效**：把修正暫時還原成舊寫法，守衛即刻報
`🔴 duplicate-key 分支要 select last_purchase_date（…會用 null 覆蓋商家資料）`。

### 7.2 測試寫得太死（守「代碼字串」而非「行為」）

| # | 測試 | 問題 | 修法 |
|---|---|---|---|
| 1 | `InventoryTable 嘅寫入要通知外層（onMutated）` | 斷言「**剛好 4 個** `onMutated?.()`」，但 `runSync` 嘅 `silent ? : ` 兩分支各要 notify ⇒ 實際 5 個 | 改守「覆蓋範圍」：≥4 個，而且 `runSync` / `doDelete` 各自一定要有、`runSync` 兩分支都要有、兩個 modal `onSaved` 都要有 |
| 2 | `duplicate-key …（用 hasBase 判斷）` | 斷言字串 `/hasBase/` —— 實作已改用共用 helper `shouldWriteBaseline()` + `writeBaseline` 變數 | 改守「兩條路徑都要經 `shouldWriteBaseline()`」＋「唔可以再用 `Number(x) > 0`」 |
| 3 | `🔴 syncFromReceipts 只喺 baseline 係 NULL 時先寫入` | 斷言 `hit.baseline_unit_cost !== null && …` 逐字；實作已變 `shouldWriteBaseline(hit?.baseline_unit_cost, …)`（有 `?.`）；另外 `const baselinePatch =` 實際有型別標註 `const baselinePatch: Record<string, unknown> =` | 改守行為：必須經 `shouldWriteBaseline(hit?.…)`；`baselinePatch` 用 `[:=]` 容忍型別標註 |
| 4 | `🔴 一鍵同步要打同一支 sync API` | 斷言整句 `body: JSON.stringify({ store: merchantId, account })` —— P2 加咗 `mode` 就爆，但 `store`/`account` 一直齊、**契約冇壞** | 改為逐個必要欄位檢查（`store: merchantId`、`account`），唔理次序／額外欄位 |

**⭐ 通則**：
> 守衛測試要守「**行為不變量**」（缺咗會出咩事），唔係「某一行代碼長點樣」。
> 寫死一整句代碼 ⇒ 任何無害重構都會爆，而**真正壞掉時反而可能唔爆**。

### 7.3 新工具：`functionBody(src, fnName)`

呢輪為守衛測試加咗一個抽函式體嘅 helper（`inventory-contract-guard.test.ts`）。

**為何需要**：唔可以「搵第一個 `{`」—— 好多寫法嘅**參數**本身就係 destructure／型別字面量：
```ts
const runSync = useCallback(async ({ mode, silent }: { mode: "auto" | "manual"; silent: boolean }) => {
```
第一個 `{` 會命中 `{ mode, silent }` ⇒ 只拿到參數，唔係函式體。

✅ **策略**：由宣告處往後，逐個 `{` 試配對（跳過字串／模板），**取內容最長者**
—— 參數／型別一定短過真正嘅函式體。搵到 >100 字嘅候選就收工。

**踩過嘅坑**：
1. 🔴 **檔案係 CRLF**：`stripComments()` 用 `^[ \t]*//.*$` 多行模式對唔上 `\r\n`
   ⇒ 要**先 `replace(/\r\n/g, "\n")`**。
2. 🔴 唔可以「搵到候選就 `break`」用「>40 字」門檻 —— `{ mode, silent }: { mode: "auto" | "manual"; silent: boolean }`
   本身就 **44 字**，會誤中參數。用「最長者勝」+ 較高門檻。

### 7.4 驗證

| 項目 | 結果 |
|---|---|
| `node --test "src/**/*.test.ts"` | **2196 tests / 298 suites / 0 fail** ✅ |
| `tsc --noEmit` | **0 error** |
| ESLint（`inventory-products.ts` + 守衛測試） | **0 error / 0 warning** |
| 回歸守衛有效性 | 暫時還原 bug ⇒ 守衛**即刻報錯**（已實測） |


---

## 4. 仍需你確認的事項

1. **§1.1 優化 A（只寫有變的行）** 是我為了讓「每次都同步」可持續而必須加的前置優化。
   它**不改變任何語意**（結果完全一樣，只是不做無謂寫入）。**我打算一併做** —— 如不同意請講。
2. **相片 bucket 建議設為 private**（用 signed URL 顯示）。如你希望直接可讀取（簡化），要講。
3. **舊收據沒品類**：品類改成必填後，編輯舊收據會被擋，需補選。這是預期行為？
4. **刪除收據時一併刪相片** —— 確認要做（否則 Storage 會累積垃圾）。

---

## 8. 追加修復：門店層設定（品類／單位）真正同步到雲端（2026-10-07）

### 8.1 症狀（J 實案）

喺**另一台電腦**新增品類 → 本機／其他裝置永遠睇唔到
（庫存 → 設置 → 品類顯示「0 個」），但**成功提示照出**
（`await onSaveCategories(...)` 唔會拋錯），所以商家以為「已保存」。

「再加一次」解決唔到 —— 因為問題唔係「未保存」，而係**從來冇出過呢部機**。

### 8.2 三個病灶（唔修齊就等於冇修）

| # | 病灶 | 位置 | 症狀 |
|---|---|---|---|
| 1 | 只寫 localStorage，全 repo 冇任何一行推雲 | `inventory-view.tsx` `patchLocalSettings()` | 雲端永遠冇品類 |
| 2 | 拉雲端嘅閘係**死條件** | `device-settings.tsx` `needLocalSettings` | 永遠唔採用雲端 `local_settings` |
| 3 | 病灶 2 嘅閘只覆蓋**全新裝置** | 同上 | 已用過嘅第二台機永遠唔拉 |

**病灶 1**：`saveCategories`／`saveUnits`／`saveSupplierOrder`／`saveCategoryOrder`／`saveUnitOrder`
全部經 `patchLocalSettings()`，而佢只有 `savePosLocalSettings(merged)`。
✅ 修：寫完本機即刻 `POST /api/pos/device-config`。三個必要細節：
- 帶 `posDeviceAuthHeadersFresh()`（該端點有鑑權閘）。
- **推前 `stripReopenTempTables(merged.floors)`** —— 唔剝會令返結暫存枱永久升級做真實枱
  （`lib/pos/table-scope.ts` 鐵律表）。`device-settings` 兩處推雲都做咗，口徑一致。
- body 係 `{ ...deviceConfig, storeId, updatedAt, localSettings }`：
  該端點係 `upsert(..., { onConflict: "device_id" })`，
  **只送 `{ storeId, localSettings }` 會令 `device_id` 變 null 而炸**。
- 失敗只 `console.warn`，**唔 rollback、唔 throw**（本機已寫入＝資料唔會丟；
  商家下次喺「設備設定」按保存會全量重推）。

**病灶 2**：`loadPosLocalSettings()` **永遠**回 normalized 物件
（key 唔存在就回 `defaultPosLocalSettings`）⇒ `!cachedLocalSettings` **恆為 false**
⇒ `if (needLocalSettings && payload.localSettings)` 永不執行。
`storage.ts` 本來就有 `hasPosLocalSettings()`（raw key 探測）專為分辨而寫，但冇用到。
✅ 改用 `!hasPosLocalSettings()`；補 default 嘅 guard（原本 `&& !loadPosLocalSettings()` 亦係死條件）同步改用。
🔴 Guard **唔可以**改用 `adoptedFromDb` flag：若雲端只有 deviceConfig、`localSettings` 係 null，
就補唔到 default ⇒ `needLocalSettings` 永遠 true ⇒ **每次 render 重複打 API**。

**病灶 3**：`!hasPosLocalSettings()` 對「用過嘅第二台機」永遠 false
⇒ 推咗上雲都照樣顯示「0 個」。
✅ 庫存頁加一次性雲端補值 effect，兩條安全規則：
- **逐欄「只補空」**（本地 `length === 0` 且雲端非空才補）⇒ **絕不可能**令商家已見到嘅資料消失。
- **本地齊全時完全唔發請求** ⇒ 正常裝置零額外 egress。
- 另：用 `useRef` 一次性 guard；刻意**唔經** `patchLocalSettings()`、唔回寫雲端（避免兩台互推）；
  失敗（離線／401）靜默保持本機值。

### 8.3 守衛測試（8 條，全部做過反證）

`inventory-contract-guard.test.ts` 新增 describe「門店層設定（品類／單位）：改動要推雲，雲端設定要拉得返」。

| 反證（故意改壞） | 紅燈結果 |
|---|---|
| 推雲 URL 改成 no-op | 只有 test 1 紅 ✅ |
| gate 改返 `!cachedLocalSettings` | 只有 test 5 紅 ✅ |
| 補值 URL 改壞 + 移除寫入本機 | 只有 test 7、8 紅 ✅ |

⇒ 守衛精準、唔會互相掩蓋。

🔴 `functionBody(VIEW, "patchLocalSettings")` 抽函式體 —— 註解已被 `stripComments()` 剝走，
所以斷言 `/api/pos/device-config` 只會命中真代碼（呢份文件／該測試檔自身都提過呢個字串）。

### 8.4 驗證

| 項目 | 結果 |
|---|---|
| `node --test "src/**/*.test.ts"` | **2230 tests / 300 suites / 0 fail** ✅ |
| `tsc --noEmit` | **0 error** |
| ESLint（7 個改動檔） | **0 error**（11 個 warning 全部係既有風格問題） |
| 反證 | 8 條守衛全部做過「改壞→紅燈→還原」 |

### 8.5 附帶一併提交（crash 前未提交嘅工作）

`git status` 揭發工作區有**上一回合 crash 前未提交**嘅「單位」主檔改動：
`types.ts`／`mock-data.ts`／`storage.ts`／`inventory-settings-panel.tsx`（+ 部分 view／test）。
已同 J 申報並一併提交（見 `.workbuddy/memory/2026-10-07.md` 該節）。

🔴 **流程教訓**：唔可以見到「最近一次 push 後以為乾淨」就當作冇嘢，
開工前一定要 `git status --short`；唔屬於自己今次改嘅檔案**先問清楚**再決定是否一併提交。
