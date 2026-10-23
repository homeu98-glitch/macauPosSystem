# 161 · 登入流程 v2 —— 裝置憑證唔可以係「店主 session 嘅副本」

> 日期：2026-10-23
> 狀態：**已實作**（J 選 B）· 待跑 migration `0075`
> 前置：docs/160 §10（裝置授權）、§11（三步登入）

---

## 1. J 實測撞到嘅事

操作次序：

1. 店主登入一次 ✅
2. 店員去 `/operator` 打卡 ✅
3. 按「登出」
4. 返到登入頁 → 揀「小紅」→ 打 PIN → ❌ **「呢部機嘅登入憑證已過期，請店主重新登入一次。」**

J 嘅結論（原文）：「沒了店主的 account 不能登入這個部份很奇怪」。

**J 講得對。** 呢個係設計缺陷，唔係 bug 修一修就得。

---

## 2. 根因

### 2.1 憑證係咩

`pos_bound_devices.refresh_token_enc` 存嘅係**店主登入時嗰個 Ledger session 嘅 refresh token**（AES-256-GCM 加密）。

店員登入時 `mintSessionFromBoundDevice()` 用佢去 `refreshSession()` 換一對新 token。

### 2.2 為何登出就死

`src/lib/ledger/session.ts:180`

```ts
await client.auth.signOut({ scope: "local" });
```

Supabase GoTrue 嘅 `scope: "local"` = **撤銷當前 session 嘅 refresh token**（server 端刪走嗰行）。
而裝置憑證存嘅正正就係同一個 token ⇒ **店主一登出，裝置憑證即刻變廢票**。

### 2.3 仲有第二個更隱蔽嘅成因

`src/lib/ledger/supabase-client.ts:52` 開咗 `autoRefreshToken: true`。
SDK 會自己喺背景輪換 refresh token，但**唔會經** `resolveLedgerSession()` ⇒
`syncDeviceBindingRefreshToken()` 冇機會執行 ⇒ DB 嗰份變成舊票。
下一次用舊票 refresh → Supabase 判定「token 重用」→ **成條 family 撤銷**。

### 2.4 結論

> **唔需要先斷定係 2.2 抑或 2.3。兩個成因都源自同一個設計缺陷：**
> **裝置憑證同店主嘅瀏覽器 session 共用同一條 refresh token family。**

只要共用，就一定會死喺三件事之一：登出撤銷、輪換競爭、token 過期。

---

## 3. 三個方案

| | 方案 | 做法 | 優點 | 缺點 | 判斷 |
|---|---|---|---|---|---|
| **A** | 現況：存 refresh token | 裝置存加密 refresh token | 唔使存 PIN | 同店主 session 共用 family；登出／輪換／過期都會死 | ❌ 今次就係死喺呢度 |
| **B** | **存加密 PIN** | 裝置存店主 PIN（AES-GCM）；店員登入時**即場** `signInWithPassword` 換一個**全新獨立** session | 每次獨立 session；登出、輪換、過期全部唔影響；改動細 | PIN 以密文存 DB；店主改 PIN 要重新初始化 | ✅ **推薦** |
| **C** | 分身帳號（J 提議） | 店員多一組 `A`+電話 / PIN | 店員唔使知店舖 8 位帳號 | **解決唔到核心問題**（見 §6）；多一層帳號要維護 | ⚠️ 可做但唔必要 |

### 3.1 為何 B 唔使再怕 refresh token

```
店員打 PIN
  → server 解密裝置內嘅店主 PIN
  → deriveLedgerAuthPassword(phone, pin, pepper)
  → signInWithPassword()          ← 每次都係一個全新 session
  → 回 access + refresh token
```

- 冇「共用 family」呢回事；
- 店主登出 = 撤銷**佢自己**嗰個 session，同裝置憑證無關；
- SDK 背景輪換只影響**當前** session，唔會令 DB 嗰份變廢票（因為 DB 根本唔存 token）；
- `syncDeviceBindingRefreshToken()`、輪換 PATCH、`updateBoundDeviceToken()` 全部可以拆走 —— **memory 記住嘅「第一號陷阱」整類消失**。

### 3.2 安全取捨（要老實講）

| 風險 | 評估 |
|---|---|
| PIN 以密文存 DB | 攻擊者要**同時**取得 DB + `resolvePosTokenSecret()`。而有 secret 嘅人本身已經可以偽造 `pv1` / `sv1` ⇒ 邊際風險有限 |
| 4 位 PIN 被爆破 | 同 Ledger 登入一樣受 rate limit（現有 10/min/IP）；裝置 secret 係 32 bytes 高熵值，冇 secret 問唔到 server |
| PIN 幾時離開 server | **永遠唔會**。只喺 server 內部解密後直接用，唔會經任何 response 出街 |
| 店主改 PIN | 舊 PIN 失效 ⇒ 店員登入會 `invalid_credentials` ⇒ **明確**提示「請店主重新登入一次以更新裝置憑證」，同時清走 binding（唔可以靜靜失敗） |

---

## 4. 目標流程

### 4.1 首次（裝置未初始化）

```
登入頁：帳號（8 位）+ PIN
  → POST /api/ledger/login（店主）
  → 成功後自動：bindThisDevice(storeId, 加密 PIN)
  → 入工作台
```

### 4.2 之後（裝置已初始化）

```
登入頁：直接顯示身份卡（唔再問 8 位帳號 —— 部機已經知係邊間店）
  → 揀「店主 / 小紅 / 阿明」
  → 打自己嘅 PIN
  → 入工作台（用該身份嘅權限）
```

### 4.3 登出

```
登出 = 只清本地 session + 寫 device-signed-out 標記
     裝置憑證**唔動**
  → 下一個人（店主或店員）照樣喺身份卡揀自己 → 打 PIN → 入
```

### 4.4 撤銷裝置

店主喺「員工權限 › 裝置」撤銷 → `revoked_at` 有值 → 呢部機返到「未初始化」，要店主重新登入。

---

## 5. 一併要改嘅三樣

### 5.1 移除「裝置授權」面板

J：「這個裝置授權的功能不需要，應該要店主登入的時候就會做了。」

- 店主登入自動初始化（**已經係咁**，`login-screen.tsx` `loginAsOwner()`）
- 面板整個移除
- ⚠️ 但**保留一個撤銷入口**（員工權限頁底部細字連結）。完全冇撤銷 = 部機賣咗／俾人搬走都仲有憑證。如果 J 連呢個都唔要，要明確講。

### 5.2 登入頁唔再問 8 位帳號（裝置已初始化時）

而家嘅三步（帳號 → 身份 → PIN）喺已初始化嘅機上面，第一步係多餘嘅 ——
部機已經知 `storeId`，直接列身份卡就得。

| 情況 | 第一步 |
|---|---|
| 未初始化 | 帳號 + PIN（店主） |
| 已初始化 | **直接身份卡** |

### 5.3 「按上一頁返到店主權限」

成因：bfcache 還原舊 DOM，React state 冇重新驗。

修法：`AuthGuard` 加

```ts
window.addEventListener("pageshow", (e) => {
  if (e.persisted) window.location.reload();
});
```

角色唔匹配（頁面要求 admin，當前係 cashier）→ 直接 redirect，唔好 render 一半。

---

## 6. 對 J 提議嘅「分身帳號（A + 電話 + PIN）」嘅評估

> 「開多一個店員，店員會多了一層 username 和 password… A 開頭… 為了不跟 ledger 那邊撞」

### 6.1 解決唔到嘅嘢

店員用 `A65273599` + PIN 登入之後，**仍然要有 Ledger token** 才用得會員／加值／報表
（`ensureLedgerSession()` 約 10 個 call site 依賴 `ledgerAccessToken`）。

Ledger 只認**店主嘅 Auth 帳號**。所以無論登入名係 `65273599` 抑或 `A65273599`，
server 背後一樣要有一份店主憑證去換 token ⇒ **核心問題原封不動**。

### 6.2 已經有嘅嘢

`pos_staff` 已經有「工號 + 4 位 PIN」，做嘅事同 `A` + 電話 + PIN 一模一樣。
再加一層 = 兩組 identifier 要維護、要重置、要防撞。

### 6.3 但 J 嘅直覺有一樣係對嘅

> 「店員唔應該要知店舖帳號」

呢點**完全正確**，而達成方法唔需要新帳號 ——
裝置已初始化就直接列身份卡（§5.2），店員連帳號都唔使打。

### 6.4 結論

**唔建議做。** 如果將來要「一個店員跨幾間分店用同一組帳密」，先值得考慮
（但屆時應該用 `pos_staff` 加 `store_id` 多對多，唔係新帳號體系）。

---

## 7. 改動清單

| 檔案 | 改動 |
|---|---|
| `supabase/migrations/0075_pos_device_pin.sql` | `pos_bound_devices` 加 `owner_pin_enc text`、`owner_account text`；`refresh_token_enc` 保留但唔再用（唔好即刻 drop，留返 rollback） |
| `src/lib/pos/device-binding-crypto.ts` | 重用 `encryptWithKey` / `decryptWithKey`，唔使改 |
| `src/lib/pos/device-binding-server.ts` | `upsertBoundDevice` 收 PIN；`verifyBoundDevice` 回 `{ pin, account }` |
| `src/lib/pos/device-session.server.ts` | `refreshSession()` → `signInWithPassword()`；拆走 `updateBoundDeviceToken` 路徑 |
| `src/lib/ledger/session.ts` | 拆走 `syncDeviceBindingRefreshToken()` 呼叫 |
| `src/components/login-screen.tsx` | 已初始化 → 直接身份卡；`known` / `account` 由 `/api/pos/login/identities` 支援「唔帶帳號」模式 |
| `src/app/api/pos/login/identities/route.ts` | 支援 `{ deviceId, secret }` 而唔係 `{ account }`（裝置模式） |
| `src/components/staff-permission-panel.tsx` | 移除裝置授權面板，改成底部細字「撤銷呢部機」 |
| `src/components/auth-guard.tsx` | `pageshow` revalidate |

---

## 8. 驗收

- [ ] 店主登入 → 登出 → **店員**揀身份 + PIN → 入得（今次死嘅位）
- [ ] 店員登入 → 登出 → 店主揀身份 + PIN → 入得
- [ ] 連續登出／登入 10 次，唔會出現「憑證已過期」
- [ ] 擺過夜（>12 小時）再開機，店員照樣入得
- [ ] 店主改 Ledger PIN → 店員登入見到「請店主重新登入一次」，唔係白畫面
- [ ] 撤銷裝置 → 店員登入見到「呢部機未初始化」
- [ ] 店員登入狀態下按瀏覽器上一頁，唔會見到店主權限
- [ ] 店員登入後會員／加值／報表照常（`ledgerAccessToken` 真係有效）

---

## 9. 未做（今次）

- 一個店員跨多間分店
- 店員離線簽到
- server 逐操作驗 `sv1`（docs/160 §8 Phase 2）

---

## 10. 實作記錄（同上面計劃嘅差異）

| 計劃 | 實際 | 原因 |
|---|---|---|
| 客戶端 POST `/api/pos/device/bind` 授權 | **喺 `/api/ledger/login` 成功嗰一刻直接寫**，回 `deviceBinding.secret` | 嗰度係唯一同時知道「storeId + 已驗證 PIN」嘅地方；少一次 round-trip、少一次 PIN 傳輸 |
| `/api/pos/device/bind` POST | **已刪**（只剩 GET / DELETE） | 同上 |
| `/api/pos/device/session` PATCH | **已刪** | 冇 token 要保鮮 |
| `syncDeviceBindingRefreshToken()` | **已刪** | 同上 |
| 撤銷入口 | 保留，但收成員工權限頁底部**細字連結** | 冇撤銷 = 部機賣咗都仲有憑證 |

### 10.1 🔑 Secret 重用規則（實作時發現嘅坑）

`upsertBoundDevice()` 每次店主登入都會跑。如果每次都發新 secret，
而某次 response 冇寫入 localStorage（私隱模式／斷線），部機就即刻變「未初始化」。
但如果**無條件重用**，客戶端清過 cache 之後就永遠收唔返有效 secret（永久壞，只能人手撤銷）。

⇒ 規則：**客戶端出示得到現有 secret（hash 對得中）就重用，出示唔到就發新嘅。**

### 10.2 裝置模式點樣「唔使打 8 位帳號」

| 端點 | 新增入參 | 用途 |
|---|---|---|
| `POST /api/pos/login/identities` | `{deviceId, deviceSecret}` | 用 `device_id` 索引反查 store_id（唔需要 storeId 前綴） |
| `POST /api/pos/login/identity` | 同上（`account` 變可選） | 店員登入 |
| `POST /api/ledger/login` | 同上 | 店主登入（**仍然要自己 PIN**，secret 唔可以代替 PIN） |

### 10.3 驗證

- `tsc --noEmit` 0 error（除既有 `layout.tsx LayoutProps` 誤報）
- `node --test` **2651 pass / 0 fail**
- `eslint` 改動檔案 0 error
- `next build` 成功

### 10.4 上線步驟

1. 跑 `supabase/migrations/0075_pos_device_pin.sql`（POS Supabase SQL Editor）
2. 店主喺每部機**重新登入一次**（舊 row 冇 PIN 密文 ⇒ 會當「未初始化」）
3. 之後店員就可以直接揀身份 + PIN 開機
