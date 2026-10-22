# 整合文檔索引

> **最後更新**：2026-10-11

本目錄包含 macauPosSystem 與外部系統的所有對接說明。

---

## 文檔列表

| 文檔 | 說明 | 何時閱讀 |
|------|------|----------|
| [main-system-integration.md](./main-system-integration.md) | POS 自有後台 API 對接（bootstrap、sync、device-config） | 接主系統 REST / POS Supabase |
| [ledger-client-api.md](./ledger-client-api.md) | **澳門會員通 Ledger** 直連 Supabase 契約 v2 | 登入、線上訂單、報表、菜單對照 |
| [ledger-client-api-v2-source.md](./ledger-client-api-v2-source.md) | Ledger 官方 v2 契約原文（2026-08-11） | 與 Ledger 團隊對齊時參考 |
| [ecosystem-modules.md](./ecosystem-modules.md) | 整個生態系（Ledger、Android、充值、派送） | 理解跨 repo 關係 |
| [pos-member-system-requirements.md](./pos-member-system-requirements.md) | **POS → Ledger 會員對接需求書**（待 Ledger 回覆契約） | 會員查詢、新增、扣點、券 |
| [pos-offline-report-api.md](./pos-offline-report-api.md) | **Ledger → POS 線下營業摘要契約 v1**（2026-09-24 原件歸檔） | 實作 `offline-report` route 前必讀 |
| [pos-offline-report-contract-review-2026-09-25.md](./pos-offline-report-contract-review-2026-09-25.md) | 契約審視：5 處口徑出入、實作方案、生產對數底稿 | 想知道「點解唔可以照契約字面做」 |
| [pos-offline-report-reply-2026-09-25.md](./pos-offline-report-reply-2026-09-25.md) | 回覆 Ledger：要佢哋改嘅 5 處、實際 payload、三條待回問題 | 同 Ledger 對契約 |
| [pos-offline-report-reply-2026-09-25.md](./pos-offline-report-reply-2026-09-25.md) | 回覆 Ledger：要佢哋改嘅 5 處、實際 payload、三條待回問題 | 同 Ledger 對契約 |
| [pos-offline-report-v1-addendum-2026-09-26.md](./pos-offline-report-v1-addendum-2026-09-26.md) | **v1 增補**：加 `orders[]`（訂單明細）+ `dishes[]`（菜品排名）；caps 標頭、截斷、口徑 | 2026-09-26 之後嘅整合（可直接轉貼） |
| [pos-offline-report-channel-addendum-2026-10-07.md](./pos-offline-report-channel-addendum-2026-10-07.md) | 🔴 **渠道增補 v2（最新）**：菜品分渠道、訂單來源、支付方式分項、渠道 KPI。**舊欄一個數字都唔改** | **要畀 Ledger 嘅就係呢份**（可直接轉貼） |
| [ledger-purchase-report-api.md](./ledger-purchase-report-api.md) | 🆕 **Ledger → expenseRecorder 買貨報表契約 v1**：買貨單據、品項、供應商、幣別拆分。**定稿，可直接轉貼** | **要畀 Ledger 嘅就係呢份**（2026-10-11） |
| [expense-account-auto-provision-2026-10-21.md](./expense-account-auto-provision-2026-10-21.md) | ✅ **庫存帳戶自動開通方案（login 觸發版，2026-10-22 已實作）**：POS 登入成功時若 expenseRecorder 冇該 account 對應 `shop_users`，即 resolve-or-create（帳號＋PIN 跟 macau-ledger 互用，絕不動現有戶口） | 實行／review 庫存自動開通前必讀 |

> 📦 **畀 Ledger 嘅 offline-report 交付包**（三份一齊）：
> ① [`pos-offline-report-api.md`](./pos-offline-report-api.md)（v1 主契約）
> ② [`pos-offline-report-v1-addendum-2026-09-26.md`](./pos-offline-report-v1-addendum-2026-09-26.md)（09-26 增補）
> ③ [`pos-offline-report-channel-addendum-2026-10-07.md`](./pos-offline-report-channel-addendum-2026-10-07.md)（10-07 渠道增補，**重點**）

> 📦 **畀 Ledger 嘅 purchase-report 交付包**（兩條 API 服務不同系統，要分清）：
> ① **銷售（線下營業）** → POS 系統，用上面嗰個 offline-report 包
> ② **買貨（庫存）** → expenseRecorder 系統，用 [`ledger-purchase-report-api.md`](./ledger-purchase-report-api.md)（單一文件，已含全部）
>
> ⚠️ 唔好混淆：買貨數據**唔喺 POS**（POS 只有銷售），亦唔喺 Ledger；
> 買貨單據真源喺 expenseRecorder（`receipts` / `receipt_items`）。

---

## 兩條整合路徑

```
┌─────────────────────────────────────────────────────────────┐
│  路徑 A：Ledger Supabase（必配）                             │
│  登入、線上訂單 RPC、Realtime、報表                          │
│  → ledger-client-api.md                                     │
│  env: NEXT_PUBLIC_SUPABASE_*, AUTH_PIN_PEPPER               │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  路徑 B：POS 自有後台 / Supabase（可選）                     │
│  bootstrap、店內訂單 sync、device-config、admin              │
│  → main-system-integration.md                               │
│  env: SUPABASE_URL, SERVICE_ROLE_KEY                        │
└─────────────────────────────────────────────────────────────┘
```

**禁止**：請求 `macau-ledger.vercel.app/*`（Ledger HTTP API）

---

## 快速決策

| 需求 | 用哪條路 |
|------|----------|
| 商戶登入 POS | Ledger → `/api/ledger/login` |
| 接線上訂單 | Ledger RPC + Realtime |
| Ledger 線上報表 | `get_merchant_report_summary`（報表頁） |
| Ledger 線上菜單對照 | `list_merchant_order_menu`（設置 → 菜單 → 參考匯入） |
| 店內堂食單上雲 | POS `/api/pos/sync` |
| 店內堂食菜單 | `/api/pos/bootstrap` 或設置頁本地維護（**非** Ledger 全量匯入） |
| 打印配置回寫 | `/api/pos/device-config` |
| 了解充值/派送 | ecosystem-modules.md |
| 會員／錢包／優惠券對接 | pos-member-system-requirements.md → 待 Ledger 回覆 |
| **查看買貨／庫存分析** | **expenseRecorder** `purchase-report` API → ledger-purchase-report-api.md |

---

## 外部 Repo

| Repo | 角色 | Supabase 專案 |
| --- | --- | --- |
| [Macau-Ledger](https://github.com/EricChang1015/Macau-Ledger) | 主系統、會員/錢包 | Ledger（`zymdemjflsckicwcinxl`） |
| **expenseRecorder**（本機 `C:\dev\macauPos\expenseRecorder`） | **買貨／庫存真源**、OCR 收據 | `fjvfvpedklhdenavbcjg` |
| macauPosSystem（本 repo） | POS／銷售／庫存主檔 | `iyrywzormzisyppkokbi` |
| [macau-ledger-merchant](https://github.com/EricChang1015/macau-ledger-merchant) | Android 商戶 App | — |
| [topUpAutomation](https://github.com/homeu98-glitch/topUpAutomation) | 充值審核 | — |
| [macauMemebershipDeliveryDriver](https://github.com/homeu98-glitch/macauMemebershipDeliveryDriver) | 外賣派單 | — |

⚠️ **收支分離**：銷售（營業額）真源喺 **POS**；買貨（成本）真源喺 **expenseRecorder**。
兩者係**唔同**嘅 Supabase 專案，唔好互相假設資料喺同一個庫。
