# 頁面與功能清單

> **最後更新**：2026-08-12

---

## 路由總表

| 路由 | 元件 | 需登入 | 資料來源 |
|------|------|--------|----------|
| `/login` | `login-screen.tsx` | 否 | `/api/ledger/login` |
| `/` | `pos-app.tsx` | 是 | localStorage + API |
| `/settings` | `device-settings.tsx` | 是 | localStorage + API |
| `/orders` | `online-orders.tsx` | 是 | Ledger Supabase |
| `/prints` | `print-center.tsx` | 是 | localStorage |
| `/members` | `members-page.tsx` | 是 | localStorage + API |
| `/soldout` | `soldout-page.tsx` | 是 | localStorage |
| `/shift` | `shift-page.tsx` | 是 | localStorage |
| `/reports` | `reports-dashboard.tsx` | 是 | Ledger RPC |
| `/admin` | `admin-accounts-page.tsx` | 是 | API / mock |
| `/backoffice` | `backoffice-shell.tsx` + 子頁 | 是 | API / mock |
| `/backoffice/stores` | `backoffice-stores-page.tsx` | 是 | API |
| `/backoffice/stores/[storeId]` | `backoffice-store-detail-page.tsx` | 是 | API |
| `/backoffice/accounts` | `backoffice-accounts-page.tsx` | 是 | API |
| `/backoffice/sync` | `backoffice-sync-page.tsx` | 是 | API |

---

## `/` 主收銀台

**元件**：`pos-app.tsx`

| 功能 | 說明 |
|------|------|
| 模式切換 | 堂食 `dinein` / 快餐 `quick` |
| 桌台選擇 | 樓層、桌號（堂食） |
| 點菜 | 分類、菜品、規格、數量、備註 |
| 送廚 | 生成 PrintJob + QueueEvent |
| 加菜 / 改量 | 已開單訂單修改 |
| 結帳 | 支付方式、會員券、餘額抵扣 |
| 同步狀態 | 離線標記、隊列待傳數 |
| 提示音 | 新單、取消（public/sounds/） |

---

## `/settings` 設備設定

**元件**：`device-settings.tsx`

| 區塊 | 功能 |
|------|------|
| 本機資料 | 終端名、storeId |
| 打印機 | 新增/編輯 USB/LAN 打印機 |
| 打印分區 | zone / receipt / label 角色 |
| 菜品打印 | 菜品 → 分區映射 |
| 規格模板 | 可複用規格組 |
| 常用備註 | 預設備註詞 |
| 菜單維護 | 本地菜品編輯（覆蓋） |
| 桌台 / 樓層 | 堂食布局 |
| 支付方式 | 自由文字列表 |
| 線上訂單 | 自動接單開關 |
| 測試打印 | 發送 TEST_PRINT 事件 |
| 保存 | 本機 + 可選同步後台 |

---

## `/orders` 線上訂單

**元件**：`online-orders.tsx`  
**整合**：Ledger Realtime + RPC（**不用** `/api/online-orders`）

| 功能 | RPC / 行為 |
|------|------------|
| 列表 | Realtime + `list_merchant_orders` |
| 接單（餘額） | `accept_order_with_deduct` |
| 接單（到店付） | `accept_order_in_store` |
| 改狀態 | `update_order_status` |
| 標記已付 | `set_order_paid_in_store` |
| 排桌 | 堂食單 → 轉本地 PosOrder |
| 取消 / 完成 | status RPC |
| 提示音 | 新單、外送新單 |

Tab：待接、製作中、待取餐、已完成、已取消

---

## `/prints` 打印中心

**元件**：`print-center.tsx`

| 功能 | 說明 |
|------|------|
| 狀態篩選 | 已發送 / 待補傳 / 失敗 |
| 預覽 | 廚房單、收據、標籤內容 |
| 重打 | 重新入隊 |
| 分區 | 按打印機、分區過濾 |

---

## `/members` 會員

**元件**：`members-page.tsx`

| 功能 | 說明 |
|------|------|
| 查詢 | 電話 / 姓名 |
| 餘額 | 顯示、充值 |
| 券 | 可用券列表、抵扣 |

資料：localStorage + 可選 `POST/GET /api/members`

---

## `/soldout` 沽清

**元件**：`soldout-page.tsx`

- 按菜品設置售罄 / 恢復
- 可選數量限制
- `POST /api/inventory/soldout`（stub，待接主系統）

---

## `/shift` 班次

**元件**：`shift-page.tsx`

| 功能 | 說明 |
|------|------|
| 開班 | 記錄開始時間、初始現金 |
| 交班 | 統計、關閉班次 |
| 歷史 | shift-history 查閱 |

---

## `/reports` 報表

**元件**：`reports-dashboard.tsx`

- Ledger `get_merchant_report_summary` RPC
- 區間營業額、訂單數摘要
- 僅含**會員通線上**訂單（不含店內 POS 單）

---

## `/admin` Admin 帳戶

**元件**：`admin-accounts-page.tsx`

| 功能 | 需 Supabase |
|------|-------------|
| 新增帳戶 | service role |
| 改 PIN / 角色 | service role |
| 刪除 | service role |
| 綁定門店、權限組 | service role |
| active / deactivate | service role |

未配置時：localStorage mock 帳戶

---

## `/backoffice` 營運後台

**布局**：`backoffice-shell.tsx`

| 子路由 | 功能 |
|--------|------|
| `/backoffice` | 總覽 dashboard |
| `/backoffice/stores` | 門店列表、啟停 |
| `/backoffice/stores/[id]` | 門店詳情、設備、同步 |
| `/backoffice/accounts` | 帳戶管理 |
| `/backoffice/sync` | 同步任務日誌 |

---

## PWA

| 項目 | 說明 |
|------|------|
| Manifest | `src/app/manifest.ts` |
| SW | `public/sw.js` |
| 安裝 | `pwa-install-button` 於登入頁 |
| 離線 | 快取 app shell；API 不走快取 |

---

## 側欄導航

**元件**：`app-sidebar.tsx`

收銀台、線上訂單、打印、會員、沽清、班次、報表、設定、Admin、Backoffice
