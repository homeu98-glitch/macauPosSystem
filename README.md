# Macau POS System

澳門餐飲 + 美容院（salon）Web POS — 前台收銀、打印、線上訂單、離線同步，美容院預約看板、服務執行與會員忠誠度；打印經 Android Native Print Agent 直打 LAN `:9100` ESC/POS。

| 項目 | 連結 |
|------|------|
| **生產環境** | [macau-pos-system.vercel.app](https://macau-pos-system.vercel.app) |
| **Repo** | [github.com/homeu98-glitch/macauPosSystem](https://github.com/homeu98-glitch/macauPosSystem) |
| **本機路徑** | `C:\dev\macauPos\macauPosSystem` |
| **📚 完整文檔** | **[docs/README.md](./docs/README.md)** ← 從這裡開始 |

---

## 快速開始

```bash
npm install
npm run dev
```

打開 [http://localhost:3000/login](http://localhost:3000/login)

環境變數：複製 `.env.example` → `.env.local`（Ledger 必配）。詳見 [docs/07-development-setup.md](./docs/07-development-setup.md)。

---

## 核心能力

- 堂食 / 快餐收銀（先落單送廚，後收錢）
- Ledger 線上訂單（Realtime + RPC）
- 打印分區、收據、標籤配置
- 離線隊列 + 可選 POS Supabase 雲同步
- PWA 可安裝至平板
- 美容院（salon）縱向擴展：預約看板、服務執行、客戶檔案、會員忠誠度（推薦 / 生日優惠 / 積分）
- Android Native Print Agent（`print-agent-android`）：POS 喺 WebView 外殼跑，經 `PosNative` bridge 直打 `:9100` ESC/POS

---

## 文檔目錄（摘要）

| 文檔 | 說明 |
|------|------|
| [docs/README.md](./docs/README.md) | **文檔索引（必讀）** |
| [01-overall-system-design.md](./docs/01-overall-system-design.md) | 總體系統設計 |
| [02-system-overview.md](./docs/02-system-overview.md) | 功能概覽 |
| [integration/](./docs/integration/) | Ledger + 主系統對接 |
| [reviews/functional-review.md](./docs/reviews/functional-review.md) | 功能成熟度 |

---

## 驗證

```bash
npm run lint
npm run build
```

---

## 業務邊界（v1）

- 打印：經 Android Native Print Agent（`print-agent-android`）直打 LAN `:9100` ESC/POS；無藍牙、無 Cloudflare Tunnel / 自簽證書
- 會員權威在 Ledger；POS 做店內查詢與抵扣
- 線上訂單：**禁止 polling**，用 Supabase Realtime
- 收銀規則由主系統下發，POS 只讀快取

完整說明見 [docs/01-overall-system-design.md](./docs/01-overall-system-design.md)。
