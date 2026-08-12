# 整合文檔索引

> **最後更新**：2026-08-12

本目錄包含 macauPosSystem 與外部系統的所有對接說明。

---

## 文檔列表

| 文檔 | 說明 | 何時閱讀 |
|------|------|----------|
| [main-system-integration.md](./main-system-integration.md) | POS 自有後台 API 對接（bootstrap、sync、device-config） | 接主系統 REST / POS Supabase |
| [ledger-client-api.md](./ledger-client-api.md) | **澳門會員通 Ledger** 直連 Supabase 契約 v2 | 登入、線上訂單、報表、菜單對照 |
| [ledger-client-api-v2-source.md](./ledger-client-api-v2-source.md) | Ledger 官方 v2 契約原文（2026-08-11） | 與 Ledger 團隊對齊時參考 |
| [ecosystem-modules.md](./ecosystem-modules.md) | 整個生態系（Ledger、Android、充值、派送） | 理解跨 repo 關係 |

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

---

## 外部 Repo

- [Macau-Ledger](https://github.com/EricChang1015/Macau-Ledger) — 主系統、Supabase migrations
- [macau-ledger-merchant](https://github.com/EricChang1015/macau-ledger-merchant) — Android 商戶 App
- [topUpAutomation](https://github.com/homeu98-glitch/topUpAutomation) — 充值審核
- [macauMemebershipDeliveryDriver](https://github.com/homeu98-glitch/macauMemebershipDeliveryDriver) — 外賣派單
