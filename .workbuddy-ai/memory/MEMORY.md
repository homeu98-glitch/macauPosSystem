# Macau POS System — 專案記憶

## 結構概要

`macauPosSystem` 澳門 Web POS。前台 v0.1 已上線生產（macau-pos-system.vercel.app）。

技術：Next.js 16.3 App Router + React 19 + TypeScript 5 + Tailwind 4 + Supabase 雙寫（Ledger 必配 / POS 可選）+ PWA + LocalStorage 離線優先 + 本地 print-bridge。

## 關鍵目錄

- `src/app/` — 路由（餐飲 v1 + salon v1+）
- `src/components/` — pos-app.tsx 是核心、print-center、online-orders、device-settings
- `src/lib/types.ts` — **只讀權威**，所有類型定義
- `src/lib/storage.ts` — localStorage 包裝
- `src/lib/ledger/` — Ledger Supabase 整合
- `src/lib/print-bridge/` — 列印橋接
- `docs/` — 編號文檔（01 全局設計...25 review）

## 業務定位

- 目標客群：澳門餐飲（飲品、炸雞、輕堂食）+ 美容院（v1+）
- 與 [Macau-Ledger](https://github.com/EricChang1015/Macau-Ledger) 共用 Supabase Auth + 線上訂單 Realtime
- 不做：藍牙打印、大中餐酒樓複雜工位、平台託管金流

## Salon 縱向擴展（2026-08-14 啟動）

詳細見 `docs/26-beauty-salon-vertical.md`。核心：

- **行業分流**：store.industry = `restaurant | salon`
- **不動餐飲**：salon 模組全部新建（`src/app/salon/`、`src/components/salon/`、`src/lib/salon/`）
- **共用基建**：auth、storage 框架、sync-queue、print-bridge、backoffice、admin
- **核心差別**：預約 vs 點單、staff label-only 不登入、Ledger 餘額替代次卡、無庫存無退款
- **Ledger 主導**：線上預約渠道、會員餘額、會員積分、定金扣款
- **6 個 phase 約 9–10 週**：P1 分流骨架（1.5w）→ P2 預約+walk-in（2w）→ P3 服務執行+列印（2w）→ P4 客戶檔案+積分（1w）→ P5 結帳+小費+定金（2w）→ P6 報表+硬化（1.5w）

## 重要約定

- 餐飲用 `macau-pos/*` localStorage 鍵；salon 用 `macau-pos-salon/*`
- PrintJob 模型共用；列印分區前綴區分行業
- Ledger 介面層不可繞過（不走 Vercel HTTP，已 410）
- 不引入新依賴；沿用 React 19 + Next.js 16 + Supabase JS

## 用戶偏好

- 語言：繁體中文（廣東話風味）
- 工作流：先討論確定方向 → 寫正式文檔 → 上 GitHub
- 偏好「不動現有」增量擴展
- 重要決定會要求整理成文檔存檔（防遺忘 + 對接用）
