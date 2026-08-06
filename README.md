# Macau POS System

這個 repo 是澳門餐飲 POS 第一版 MVP。現階段聚焦在三件事：

- 前台收銀、快餐、堂食、線上訂單
- 打印機、收據、標籤與設備設定
- 離線隊列與後台同步骨架

目前按以下業務邊界設計：

- 訂單流程：`先落單送廚房，後收錢`
- 會員：第一版暫不接入，由主系統繼續管理
- 打印：只做 `USB / LAN`，不做藍牙
- 收銀規則：由主系統下發，POS 只讀與快取
- 打印機設定：在 POS 收銀台設定，再回寫後台

## 技術方向

- `Next.js App Router`
- `TypeScript`
- 本地快取：`localStorage`
- POS 前台與設備設定頁為 client component
- 後台接口先用 mock route 佔位，方便之後接主系統 API

## 目前頁面

- `/`
  - 收銀台主頁
  - 桌號切換
  - 加菜、改數量、備註
  - 送廚房單
  - 結帳
  - 同步事件與打印任務狀態

- `/settings`
  - 本機設備資料
  - 打印機綁定
  - 打印分區、收據機、標籤機
  - 菜品打印設置
  - 規格模板
  - 常用備註
  - LAN / USB 設定
  - 測試打印
  - 保存本機 / 同步後台

- `/orders`
  - 線上訂單
  - 接單 / 取消 / 製作中 / 已完成
  - 堂食單安排桌台

- `/prints`
  - 打印中心
  - 已發送 / 待補傳 / 失敗
  - 預覽與重打

## 目前 mock API

- `GET /api/pos/bootstrap`
  - 模擬主系統下發 POS 基礎設定
  - 包括門店、菜單、桌號、收銀規則

- `POST /api/pos/device-config`
  - 模擬設備設定回寫
  - 可用於設備設定同步與測試打印事件

- `POST /api/pos/sync`
  - 模擬同步隊列補傳
  - 用來驗證本地待同步資料的上傳流程

## 本地資料

目前透過 `localStorage` 保存以下資料：

- `macau-pos/bootstrap`
- `macau-pos/device-config`
- `macau-pos/orders`
- `macau-pos/print-jobs`
- `macau-pos/sync-queue`

## 後續要對接主系統的接口

第一批建議對接以下接口：

- `GET /pos/bootstrap`
- `GET /pos/config?since_version=...`
- `POST /pos/orders`
- `POST /pos/payments`
- `POST /pos/device-config`
- `POST /pos/sync/batch`

## 開發

先安裝依賴後啟動：

```bash
npm run dev
```

打開 [http://localhost:3000](http://localhost:3000)。

## 文檔

- `docs/system-overview.md`
- `docs/integration-guide.md`
- `docs/pos-functional-review.md`

## 驗證

```bash
npm run lint
npm run build
```

## 下一步建議

下一輪實作建議：

- 把 mock bootstrap 改成真實主系統 API
- 把同步隊列改成 `IndexedDB`
- 加入真正的 LAN 打印適配層
- 接後台訂單與付款回寫
- 補齊堂食訂單模型，例如退菜、加菜、重印

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
