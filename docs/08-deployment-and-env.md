# 部署與環境變數

> **最後更新**：2026-08-12

---

## 部署概覽

| 項目 | 值 |
|------|-----|
| 平台 | Vercel |
| 生產 URL | [macau-pos-system.vercel.app](https://macau-pos-system.vercel.app) |
| Repo | [homeu98-glitch/macauPosSystem](https://github.com/homeu98-glitch/macauPosSystem) |
| 分支 | `main` → auto deploy |

---

## Vercel 環境變數

在 Vercel Project Settings → Environment Variables 設定：

### Production / Preview 必配（Ledger）

| 變數 | Environment |
|------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Production, Preview |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Production, Preview |
| `AUTH_PIN_PEPPER` | Production, Preview（Encrypted） |

### 可選（POS Supabase）

| 變數 | 說明 |
|------|------|
| `SUPABASE_URL` | POS 專案 URL |
| `SUPABASE_ANON_KEY` | Anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin / sync API |

### 可選（HiveMQ — 未接入）

`NEXT_PUBLIC_HIVEMQ_*`, `HIVEMQ_*`

---

## 建置

```bash
npm run build
npm run start   # 本地驗證生產建置
```

CI 建議：

```bash
npm run lint
npm run build
```

---

## PWA 部署注意

| 項目 | 說明 |
|------|------|
| Manifest | `src/app/manifest.ts` → `/manifest.webmanifest` |
| Service Worker | `public/sw.js`，快取名 `macau-pos-v20-7-31` |
| start_url | `/login` |
| 更新 SW | 修改 `CACHE_NAME` 強制客戶端更新 |
| API | SW **不**快取 `/api/*` |

門店平板建議：Chrome →「安裝應用」→ 全屏 POS 模式。

---

## 雙 Supabase 部署矩陣

| 場景 | Ledger env | POS env | 行為 |
|------|------------|---------|------|
| 完整生產 | ✅ | ✅ | 登入 + 線上單 + 雲同步 + Admin |
| 僅 Ledger | ✅ | ❌ | 登入 + 線上單；店內 data 僅 localStorage |
| 無 env | ❌ | ❌ | 僅靜態 UI mock（不可用於門店） |

---

## 安全檢查清單

- [ ] `AUTH_PIN_PEPPER` 未設 `NEXT_PUBLIC_` 前綴
- [ ] `SUPABASE_SERVICE_ROLE_KEY` 僅 Vercel server env
- [ ] `.env.local` 在 `.gitignore`
- [ ] Ledger pepper 與 Macau-Ledger 部署一致

---

## 域名與 HTTPS

Vercel 自動 HTTPS。自訂域名在 Vercel Domains 設定。

PWA 安裝要求 HTTPS（localhost 除外）。

---

## 回滾

Vercel Deployments → 選擇上一成功部署 → Promote to Production。

---

## 監控建議

- Vercel Analytics / Logs
- Supabase Dashboard（Ledger + POS）— API 用量、Realtime 連線
- 門店端：打印隊列積壓、sync-queue 長度

---

## 相關文檔

- [07-development-setup.md](./07-development-setup.md)
- [integration/ledger-client-api.md](./integration/ledger-client-api.md) §環境變數
- [01-overall-system-design.md](./01-overall-system-design.md) §安全邊界
