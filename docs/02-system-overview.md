# 系統功能概覽

> **最後更新**：2026-08-12  
> 詳細架構見 [01-overall-system-design.md](./01-overall-system-design.md)

---

## 目標

面向**飲品店、快餐店、輕堂食**，覆蓋門店日常高頻流程：

- 堂食點單、加菜、結帳、完成
- 快餐點單、收銀、出單、取餐完成
- 線上訂單接單、取消、製作中、完成（Ledger）
- 打印機、分區、收據機、標籤機配置
- 常用備註、規格模板、菜品打印分區
- 會員餘額與券、沽清、班次、報表

---

## 頁面結構

| 路由 | 名稱 | 主要功能 |
|------|------|----------|
| `/login` | 登入 | Ledger 8 位電話 + 4 位 PIN |
| `/` | 主收銀台 | 堂食 / 快餐、桌台、加菜、送廚、結帳 |
| `/settings` | 設備設定 | 打印機、分區、菜單、桌台、支付、備註 |
| `/orders` | 線上訂單 | Ledger Realtime 接單、取消、完成、排桌 |
| `/prints` | 打印中心 | 已發送 / 待補傳 / 失敗、預覽、重打 |
| `/soldout` | 沽清 | 菜品售罄管理 |
| `/members` | 會員 | 餘額、券查詢與充值 |
| `/shift` | 班次 | 開班、交班、歷史 |
| `/reports` | 報表 | 營業摘要（Ledger RPC） |
| `/admin` | Admin 帳戶 | 帳戶 CRUD、門店綁定、權限組 |
| `/backoffice` | 營運後台 | 門店總覽、同步監控、帳戶管理 |

---

## 核心資料

### localStorage 鍵（離線優先）

| 鍵 | 內容 |
|----|------|
| `macau-pos/bootstrap` | 菜單、桌台、規則 |
| `macau-pos/device-config` | 終端與打印機 |
| `macau-pos/local-settings` | 樓層、支付、打印模板、備註 |
| `macau-pos/orders` | 店內訂單 |
| `macau-pos/print-jobs` | 打印任務 |
| `macau-pos/sync-queue` | 待同步事件 |
| `macau-pos/members` | 會員資料 |
| `macau-pos/auth-session` | Ledger 登入 session |
| `macau-pos/shift` / `shift-history` | 班次 |
| `macau-pos/sold-out` | 沽清狀態 |
| `macau-pos/offline-mode` | 離線標記 |

完整清單見 [04-data-model-and-storage.md](./04-data-model-and-storage.md)。

### 關鍵業務物件

| 類型 | 說明 |
|------|------|
| `PosBootstrap` | 店鋪、菜單、桌台、規則、打印分區 |
| `PosLocalSettings` | 本地支付、打印分區、規格模板、備註 |
| `PosOrder` | 堂食 / 快餐訂單 |
| `PrintJob` | 廚房單、收據、標籤 |
| `QueueEvent` | 離線同步事件 |

---

## 打印模型

| 角色 | 說明 |
|------|------|
| `zone` | 分區出單（廚房、水吧、甜品） |
| `receipt` | 收據機（每台收銀一台） |
| `label` | 標籤機（可按分區） |

菜品綁定**打印分區**，不直接綁打印機——換機不用逐個改菜。

---

## 推薦業務流程

### 快餐

1. 點餐 → 2. 自動切收銀 → 3. 結帳後下單 → 4. 打印收據  
5. 待取餐 → 6. 標記完成

### 堂食

1. 選桌 → 2. 點單下單 → 3. 加菜改單 → 4. 結帳 → 5. 完成

### 線上訂單

- **堂食線上單**：接單 → 排桌 → 轉入堂食流程
- **自取 / 自送 / 車手**：卡片直接接單、取消、完成

---

## 已知邊界

- 藍牙打印未接入
- 打印驅動需本地橋接服務
- 規格模板為門店本地維護，非總部模板中心
- 大型中餐 / 複雜廚房聯動不在 v1 範圍

---

## 下一步

- localStorage 隊列 → IndexedDB
- 打印模板預覽與版式
- 退款、退菜、交班核銷
- 真實 LAN 打印適配層

見 [reviews/functional-review.md](./reviews/functional-review.md)。
