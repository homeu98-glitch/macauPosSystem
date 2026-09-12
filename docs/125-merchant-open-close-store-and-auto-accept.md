# 125. 開關店（開啟／關閉接單）＋ 自動接單 —— Ledger RPC 直連

> **狀態**：2026-09-12 已實作（POS 側）。上游契約白名單**待補 v3.5**。
> **背景來源**：Ledger 側對「POS 可唔可以自己開關店」嘅回覆（Android 商戶 App 用嗰支 RPC）。
> **相關**：`docs/92`（自動接單雙向同步 —— 出站 HTTP 部分**已被本文件取代**）、`docs/113`（坑總表）、
> `docs/integration/ledger-client-api.md`（契約 v3.4）。

---

## 1. 三個「關」要分清

| 開關 | 誰能改 | 效果 |
|------|--------|------|
| **`merchant_enabled`** | 店員／店主 | **POS 要控嘅就係呢個**。關咗之後會員通唔可以落新單 |
| `open_now`（接單時段） | 僅店主改 `hours_enabled` / `business_hours` | 時段外標「休息中」；POS **唔可以**用改時段嚟當開關店 |
| `admin_enabled` | 僅 Admin | 平台核可。POS 改唔到 |

會員通真正接得到單，四個條件同時成立：

```text
merchants.status = active
AND admin_enabled = true
AND merchant_enabled = true
AND open_now（時段；hours_enabled = false 則全天）
```

`merchant_enabled = false` 時，`auto_accept` 就算仍係 true 都**唔會**自動接（`create_order` 會擋）。

---

## 2. 資料流（三層，權威只有一層）

```
收銀撳掣
  └─(店員 JWT 直連)→ RPC  merchant_set_order_enabled / merchant_set_auto_accept   ← 權威
        └─ 回傳整份 order config
             ├─→ UI 直接用回傳值更新（唔使再 GET）
             └─→ POST /api/online-order-settings（**純鏡像**）
                   └─→ pos_online_order_settings（POS 自有 Supabase）
                         └─→ 0019 Realtime publication → 其他收銀機即時跟住變
```

| 層 | 角色 | 文件／表 |
|---|---|---|
| Ledger | **真源** | `merchants.merchant_enabled` / `auto_accept` |
| POS DB | 鏡像（跨機廣播） | `pos_online_order_settings`（0019 ＋ **0036** 加 `merchant_enabled`） |
| localStorage | 離線快取（只 `autoAccept`） | `PosLocalSettings.onlineOrderSettings` |

### 2.1 「跨機即時」係有前提嘅 —— 唔可以當佢必然成立

最後一層（Realtime 廣播）用 `getPosSupabaseClient()`，而佢**未設**
`NEXT_PUBLIC_POS_SUPABASE_URL` / `_ANON_KEY` 時會**退回 Ledger 專案**
（`.env.example` B-2 嘅向後兼容）。Ledger 專案冇 `pos_online_order_settings`
→ channel 照樣 `SUBSCRIBED` 但**永遠收唔到事件**，而 Supabase **唔會報錯**
（同 `docs/reviews/qr-self-order-audit-2026-09-10.md` 附錄 B.6 同一個坑）。

所以 code 唔會假定「即時」：

- `subscribeRealtime()` 先用**零網絡成本**嘅 `getPosRealtimeConfig()?.source !== "pos"` 把關；
- 唔通就**唔訂**（省 channel / `eventsPerSecond` quota）＋ dev `console.warn`；
- state 出 `crossTerminalSync: "instant" | "on-enter"` → 設備設定顯示實話；
- 就算係 `on-enter`，值仍然會收斂（`visibilitychange` 補拉 ＋ 入頁重拉），只係慢啲。

⚠️ `NEXT_PUBLIC_*` 係 **build-time inline** → 設完**必須重新部署**。

---

## 3. RPC 契約

```sql
get_merchant_order_config (p_merchant_id uuid) → jsonb
merchant_set_order_enabled(p_merchant_id uuid, p_merchant_enabled boolean) → jsonb
merchant_set_auto_accept  (p_merchant_id uuid, p_auto_accept boolean)      → jsonb
```

| 項目 | 說明 |
|---|---|
| 授權 | `is_merchant_staff`（店員 JWT）。顧客 JWT → `not authorized` |
| 副作用 | **只改自己一欄** ＋ `updated_at`，唔碰時段／付款／盒費 |
| 回傳 | 完整 order config（三支一致）→ UI 直接用，唔使再打 GET |
| 已知失敗 | 兩種線上付款都關住 → `at least one payment method required` |
| 對照 | Android `merchant_set_order_enabled`，migration `20260702100000` |

**禁止**：`merchant_update_order_config` / `merchant_update_order_basics`（整包覆寫）；
`create_order` 等 Ledger Vercel 路徑；顧客 JWT 開關店。**禁 polling**。

---

## 4. 檔案清單

| 檔案 | 動作 |
|---|---|
| `src/lib/ledger/order-config-parse.ts` | 新增 —— **零依賴**防禦性解析（缺欄 → `null`、`"false"` 唔當 truthy） |
| `src/lib/ledger/order-config-parse.test.ts` | 新增 —— `npm run test` 覆蓋解析／blocker／付款判斷 |
| `src/lib/ledger/order-config.ts` | 新增 —— RPC 層（`unavailable` / `unauthorized` / `error` 三分類） |
| `src/lib/pos/use-merchant-order-config.ts` | 新增 —— module store：RPC 真源 ＋ 鏡像 ＋ Realtime ＋ 離線快取 |
| `src/lib/pos/use-online-order-settings.ts` | 改 —— 降級做薄殼（舊 API 不變，內部轉新 store） |
| `src/components/merchant-open-pill.tsx` | 新增 —— 共用主開關（內含**關店二次確認**） |
| `src/components/merchant-order-config-section.tsx` | 新增 —— 設備設定 section（狀態 ＋ 阻礙原因 ＋ 重新整理） |
| `src/components/online-orders.tsx` | 改 —— 標題列加主開關；店關咗灰掉自動接單 |
| `src/components/quick-mode-orders-bar.tsx` | 改 —— 同上（快餐標題列） |
| `src/components/device-settings.tsx` | 改 —— 新增「線上接單」tab（`online-orders`） |
| `src/app/api/online-order-settings/route.ts` | 改 —— **唔再出站推 Ledger**；接收部分欄位做鏡像；0036 未跑時降級 |
| `src/lib/ledger/auto-accept-sync.ts` | 改 —— 標記**已退役**（冇 caller） |
| `supabase/migrations/0036_pos_online_order_settings_merchant_enabled.sql` | 新增 |
| `src/lib/ledger/order-actions.ts` | 改 —— `mapRpcErrorMessage()` 補開店失敗文案 |

---

## 5. 驗收

1. **開關店（POS → Ledger）**：店員帳號 → 撳「營業中」變「已暫停」→
   `merchants.merchant_enabled = false`；會員通即刻落唔到新單。
2. **唔會誤傷**：切完之後 `business_hours` / `hours_enabled` / 付款方式 / 盒費**一字不變**。
3. **回傳即狀態**：撳完**唔應該**見到第二次 RPC／GET（network 只有一次 RPC ＋ 一次鏡像 POST）。
4. **跨機（POS ↔ POS）**：A 機關店 → B 機開住訂單頁 → 3 秒內掣變「已暫停」（Realtime）。
   ⚠️ 前提：Vercel 有設 `NEXT_PUBLIC_POS_SUPABASE_URL` / `_ANON_KEY` 並已重新部署
   （否則只會係 `on-enter` —— 設備設定會出灰底說明，dev console 有 warn）。
5. **離線／未接**：唔登入 Ledger 或 RPC 未上線 → 顯示「未接通」並停用，**唔可以**顯示成營業／已暫停。
6. **`admin_enabled = false` / `suspended`**：開關仍可撳，但設備設定要列出「而家接唔到單」嘅原因。
7. **關店二次確認**：撳關 → 彈確認；取消 → 值不變（network 冇 RPC）。
8. **自動接單**：店關咗嘅時候掣灰掉；**唔會**寫 `auto_accept = false`；開返店原設定仍在。
9. **`npm run typecheck` / `npm run test`** 全綠。
10. **0036 未跑**：`pos_online_order_settings` 讀寫降級成功（唔 500），`auto_accept` 照樣可以讀寫。

---

## 6. 待辦（要交畀 Ledger / 平台）

1. **契約白名單**：`docs/integration/ledger-client-api.md` §5.5 補 v3.5 ——
   `get_merchant_order_config` / `merchant_set_order_enabled` / `merchant_set_auto_accept`。
   現時 DB 已 `GRANT EXECUTE` 畀 `authenticated`，但白名單係**整合契約義務**，唔補就等於「能打但唔准打」。
2. **推播**：Ledger 仍冇 MQTT／webhook → POS 只可以靠「進頁／回前景重拉 ＋ 自身鏡像廣播」。
   若 Ledger 日後肯加 `merchant_enabled` 變更通知（webhook／Realtime publication），
   可刪走 `visibilitychange` 補拉。
3. **清理**：確認 Ledger 側唔再需要 `/api/integration/pos/auto-accept` 之後，
   可以連 `LEDGER_INTEGRATION_BASE_URL` 一齊清走（現時 `auto-accept-sync.ts` 只剩註釋同 dead code）。
