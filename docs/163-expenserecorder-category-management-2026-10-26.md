# expenseRecorder 品類清單管理（截圖實案：誤入品類刪唔走）

> **日期**：2026-10-26 · **狀態**：📋 改動指引（expenseRecorder 部機跟做；本 repo 無該源碼）
> **觸發實案**：J 截圖 expenseRecorder 收據表單嘅「請選擇品類」下拉，入面有明顯誤入值
> （「1」「一」「'」「/」「|」）同簡體殘留（「鱼」「鸡」），喺設定內改唔走。

---

## 0. 一句話講晒

expenseRecorder 個品類下拉**唔係**讀 MACAU-POS 嘅設置清單（`pos_device_configs.local_settings.invCategories`
存喺 POS Supabase，expenseRecorder 讀唔到）——佢係自己嗰邊衍生／累積出嚟嘅清單，
所以 POS 設置點刪都唔會影響佢。根治要喺 expenseRecorder 加「可管理清單 ＋ 設置 UI」，
並清理已污染嘅舊值。

## 1. 兩邊現況

| App | 品類清單來源 | 管理入口 |
|---|---|---|
| MACAU-POS | `PosLocalSettings.invCategories`（本機 localStorage＋`pos_device_configs.local_settings` 雲端同步，只補空唔覆寫） | ✅ 已有：庫存 → 設置 → 品類（新增／改名／刪除／排序，`inventory-settings-panel.tsx` L381-427） |
| expenseRecorder | ❓ 要先確認：多數係「歷史收據 `raw_ocr_data->>'category'` distinct」或自己累積嘅清單 | ❌ 冇（截圖實案） |

⚠️ 判斷依據：截圖係 native `<select>`（POS 品類係 chip 排列、冇 select）；清單入面
傳統中文（海鮮／肉／菜／雜貨／石油氣）同 POS 清單吻合，而簡體（鱼／鸡）同符號垃圾
（1／'／／／|）係手動輸入累積 ⇒ 符合「distinct 歷史數據」或「自動把手動輸入加落清單」。

## 2. expenseRecorder 要做嘅改動（嗰部機）

1. **確認清單來源**（第一步，決定後續）：
   ```bash
   grep -rn "category" app/ lib/ --include="*.ts*" | grep -iE "distinct|select|options|categories"
   ```
   - 如果係 `select distinct category from receipts`／`raw_ocr_data->>'category'` 去重 ⇒ 做第 2 步；
   - 如果有自己嘅 categories 表／設定 ⇒ 直接跳第 3 步。
2. **停止「數據即清單」**：品類下拉改讀一份**受管理清單**（建議 `shop_category_settings`
   表，key = `shop_users.id`；或復用該 app 現有 settings 機制）。歷史 distinct 值只做
   **一次性 seed**（匯入去重後俾商家刪）。
3. **設置 UI**：品類管理（新增／改名／刪除／排序），對齊 POS `inventory-settings-panel.tsx`
   嘅互動（刪除要確認；改名唔追溯舊收據——同 POS 口徑一致）。
4. **手動輸入唔再自動加落清單**（或者加咗都要喺設置睇到＋刪到）——「1」「'」「/」「|」
   就係誤觸後永久留底嘅後果。
5. **清理已污染值**：seed 完受管理清單之後，將「1」「一」「'」「/」「|」等垃圾由清單剷走；
   舊收據嘅 `raw_ocr_data.category` **唔好改**（歷史數據），報表分組照舊。

## 3. 兩邊清單要不要互通？

短期**唔建議**強行互通（POS 嘅 `invCategories` 喺 POS Supabase，expenseRecorder 要跨 project
讀，鉴權同 RLS 都要開新通道）。兩邊各自管理、介面同名同序已經夠用；日後若 J 想一邊改兩邊生，
先考慮 expenseRecorder 開 API 由 POS 推送（到時再設計，唔好今次夾硬做）。

## 4. 過渡期（未改 expenseRecorder 之前）J 可以即刻做

- **POS 呢邊**：庫存 → 設置 → 品類，逐個刪（舊收據不受影響，只影響之後開單嘅選項）。
- **expenseRecorder 嗰邊**：未有 UI，唯有暫時**避用手動輸入**、只用清單內已有值；
  等第 2 節改動上線先正式清理。

## 5. 驗收清單（expenseRecorder 改完後）

- [ ] 下拉清單只出受管理品類，垃圾值（1／一／'／／／|／鱼／鸡）唔再出現
- [ ] 設置頁可以刪除／改名／新增品類，即時反映喺收據表單
- [ ] 手動輸入新品類後，可以喺設置搵到並刪得走
- [ ] 舊收據品類顯示／報表分組不受刪除影響
