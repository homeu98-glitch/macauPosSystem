# Macau POS System — 文檔索引

> **最後更新**：2026-08-12  
> **Repo**：[homeu98-glitch/macauPosSystem](https://github.com/homeu98-glitch/macauPosSystem)  
> **部署**：[macau-pos-system.vercel.app](https://macau-pos-system.vercel.app)

**從這裡開始。** 本文檔目錄是整個 POS 專案的唯一入口，避免在多個 repo、多台電腦之間迷失。

---

## 快速導航

| 你想了解… | 看這份 |
|-----------|--------|
| 整體是什麼、怎麼運作 | [01-overall-system-design.md](./01-overall-system-design.md) |
| 功能與頁面概覽 | [02-system-overview.md](./02-system-overview.md) |
| 程式碼結構、分層 | [03-architecture-and-codebase.md](./03-architecture-and-codebase.md) |
| 資料模型、localStorage | [04-data-model-and-storage.md](./04-data-model-and-storage.md) |
| 各頁面功能清單 | [05-pages-and-features.md](./05-pages-and-features.md) |
| API 路由一覽 | [06-api-reference.md](./06-api-reference.md) |
| 本地開發、環境變數 | [07-development-setup.md](./07-development-setup.md) |
| 部署、Vercel、PWA | [08-deployment-and-env.md](./08-deployment-and-env.md) |
| 與主系統 / Ledger 對接 | [integration/](./integration/) |
| 功能成熟度審查 | [reviews/functional-review.md](./reviews/functional-review.md) |
| Admin 帳戶 SQL | [sql/admin-account-schema.sql](./sql/admin-account-schema.sql) |

---

## 文檔結構

```
docs/
├── README.md                      ← 你正在這裡（索引）
├── 01-overall-system-design.md    ← 總體系統設計（必讀）
├── 02-system-overview.md          ← 功能與業務概覽
├── 03-architecture-and-codebase.md
├── 04-data-model-and-storage.md
├── 05-pages-and-features.md
├── 06-api-reference.md
├── 07-development-setup.md
├── 08-deployment-and-env.md
├── integration/
│   ├── README.md                  ← 整合文檔索引
│   ├── main-system-integration.md ← POS 自有後台 API 對接
│   ├── ledger-client-api.md       ← 澳門會員通 Ledger 直連契約
│   ├── ledger-client-api-v2-source.md ← Ledger 官方 v2 原文備份
│   └── ecosystem-modules.md       ← 整個生態系模組關係
├── reviews/
│   └── functional-review.md       ← 功能成熟度與上線建議
└── sql/
    └── admin-account-schema.sql   ← Admin 帳戶表結構
```

---

## 專案一句話

**澳門餐飲 POS 第一版 MVP**：Next.js PWA，離線優先（localStorage），可選 POS Supabase 雲同步，**必須** Ledger Supabase 登入與線上訂單。

---

## 相關 Repo（生態系）

| 模組 | Repo | 說明 |
|------|------|------|
| 澳門會員通 Web | [EricChang1015/Macau-Ledger](https://github.com/EricChang1015/Macau-Ledger) | 主系統、Supabase migrations 權威 |
| 本 POS | [homeu98-glitch/macauPosSystem](https://github.com/homeu98-glitch/macauPosSystem) | 店內收銀 Web POS |
| 商戶 Android | [EricChang1015/macau-ledger-merchant](https://github.com/EricChang1015/macau-ledger-merchant) | 接單、記帳、打印 |
| 充值審核 | [homeu98-glitch/topUpAutomation](https://github.com/homeu98-glitch/topUpAutomation) | 線上充值審核 |
| 外賣派單 | [homeu98-glitch/macauMemebershipDeliveryDriver](https://github.com/homeu98-glitch/macauMemebershipDeliveryDriver) | 車手接單 |

詳見 [integration/ecosystem-modules.md](./integration/ecosystem-modules.md)。

---

## 本地路徑備忘

| 項目 | 路徑 |
|------|------|
| 本機專案 | `C:\dev\macauPos\macauPosSystem` |
| 環境變數範例 | `.env.example`（Ledger）、`.env.local.example`（POS Supabase / HiveMQ） |
| 核心 POS 元件 | `src/components/pos-app.tsx` |
| Ledger 整合 | `src/lib/ledger/` |

---

## 文檔維護約定

- 新增頁面或 API 時，同步更新 `05-pages-and-features.md` 與 `06-api-reference.md`
- 整合契約變更時，更新 `integration/` 下對應文件
- 重大架構決策寫入 `01-overall-system-design.md`
