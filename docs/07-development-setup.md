# 開發環境設定

> **最後更新**：2026-08-12  
> 本機路徑：`C:\dev\macauPos\macauPosSystem`

---

## 1. 前置需求

| 工具 | 版本建議 | 用途 |
|------|----------|------|
| Node.js | 20 LTS+ | 運行 Next.js |
| npm | 隨 Node | 依賴管理 |
| Git | 任意 | 版本控制（可用 GitHub Desktop） |

驗證：

```powershell
node --version
npm --version
```

---

## 2. 克隆與安裝

```powershell
cd C:\dev\macauPos
git clone https://github.com/homeu98-glitch/macauPosSystem.git
cd macauPosSystem
npm install
```

---

## 3. 環境變數

### 3.1 Ledger（必配 — 登入 + 線上訂單）

複製 `.env.example` → `.env.local`：

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-ledger-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
AUTH_PIN_PEPPER=your-pepper-from-ledger-ops
```

| 變數 | 位置 | 說明 |
|------|------|------|
| `NEXT_PUBLIC_SUPABASE_URL` | 前端 | Ledger Supabase URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 前端 | Ledger anon key |
| `AUTH_PIN_PEPPER` | **僅伺服器** | PIN→密碼 HMAC；向 Ledger 運維索取 |

**勿 commit `.env.local`**

### 3.2 POS Supabase（可選 — 雲同步、Admin、Backoffice）

參考 `.env.local.example`，取消註解並填入：

```env
SUPABASE_URL=https://your-pos-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

無配置時：系統以 mock-data + localStorage 運行（Ledger 登入仍可用）。

### 3.3 HiveMQ（可選 — 尚未接入）

```env
NEXT_PUBLIC_HIVEMQ_WS_URL=wss://...
NEXT_PUBLIC_HIVEMQ_USERNAME=...
NEXT_PUBLIC_HIVEMQ_PASSWORD=...
NEXT_PUBLIC_STORE_ID=macau-store-a
HIVEMQ_HOST=...
HIVEMQ_MQTTS_PORT=8883
```

`hivemq-publisher.ts` 已寫但未在 app 中 import。

---

## 4. 啟動

```powershell
npm run dev
```

打開 [http://localhost:3000/login](http://localhost:3000/login)

| 腳本 | 說明 |
|------|------|
| `npm run dev` | 開發伺服器 |
| `npm run build` | 生產建置 |
| `npm run start` | 生產模式 |
| `npm run lint` | ESLint |

---

## 5. 無 Ledger env 時能做什么

| 功能 | 可用 |
|------|------|
| 登入 | ❌ 503 |
| 主收銀 UI | ⚠️ 需繞過 AuthGuard 或 mock session |
| 線上訂單 | ❌ |
| 設備設定、打印中心 | ✅ localStorage |
| Admin（mock） | ✅ |

**建議**：至少配置 Ledger env 做完整開發。

---

## 6. Supabase 初始化（POS 自有 DB）

1. 建立 Supabase 專案
2. 執行 [sql/admin-account-schema.sql](./sql/admin-account-schema.sql)
3. 依 API Routes 需求建立 `pos_*` 表（見 POS Supabase migrations 或 backoffice-server 引用）
4. 填入 `.env.local` service role

---

## 7. 常用開發路徑

| 任務 | 檔案 |
|------|------|
| 改收銀 UI | `src/components/pos-app.tsx` |
| 改線上單 | `src/components/online-orders.tsx`, `src/lib/ledger/` |
| 改類型 | `src/lib/types.ts` |
| 改 localStorage | `src/lib/storage.ts` |
| 改 mock 資料 | `src/lib/mock-data.ts` |
| 加 API | `src/app/api/` |

---

## 8. Git 工作流

```powershell
git status
git add .
git commit -m "your message"
git push origin main
```

GitHub Desktop 路徑：`C:\dev\macauPos\macauPosSystem`

---

## 9. 疑難排解

| 問題 | 處理 |
|------|------|
| 登入 503 | 檢查 `.env.local` Ledger 三變數 |
| 線上單空白 | 確認 Ledger session + Realtime |
| 白屏 | 看 console；`app-error-boundary` 可清 SW 快取 |
| PWA 舊版 | 清快取 / 更新 `public/sw.js` cache 名 |
| npm 找不到 | 安裝 Node LTS，重開終端 |

---

## 10. 相關文檔

- [08-deployment-and-env.md](./08-deployment-and-env.md)
- [integration/ledger-client-api.md](./integration/ledger-client-api.md)
- [01-overall-system-design.md](./01-overall-system-design.md)
