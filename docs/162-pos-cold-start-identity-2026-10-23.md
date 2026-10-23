# 162 · 冷啟要重新認人 —— 關掉瀏覽器再開，唔可以沿用上一個帳號

> 日期：2026-10-23
> 狀態：**已實作**
> 前置：docs/161（裝置憑證改存 PIN 密文）

---

## 1. J 實測撞到嘅事

> 「我剛剛關掉了 website，然後再進去這個網頁，就直接登入到了這張圖的頁面，
> 又變回了店主的權限了。」

截圖：`老饕牛肉麵【示範】· 帳號 60000002 · 管理員` → 直接入到「請選擇要進入嘅工作台」。

**問題本質**：店員接手部機，唔需要任何 PIN 就有**店主權限**。

---

## 2. 根因

`authSession` 存喺 **`localStorage`**（`src/lib/storage.ts`）。
呢個係刻意嘅取捨 —— POS 要離線優先、PWA 重開要保住資料。

代價：**關 tab 唔會清 session**。而 `AuthGuard` 嘅判斷只有「有冇 session」，
所以再開瀏覽器 = 沿用上一個用機嘅人。

呢個唔係「登入狀態保持」咁簡單 —— 喺 POS 場景係**權限漏洞**：
店主開完單走開，店員一開機就係店主身份（可以退款、改設定、看報表）。

---

## 3. 解法：分「冷啟」同「分頁內重整」

唔可以簡單噉「每次 reload 都要 PIN」—— POS 會 reload（網絡重連、OS 殺 tab、
PWA 更新），每次都問會煩到冇人用。亦唔可以改 `localStorage` → `sessionStorage`
存 authSession（離線資料會冇咗）。

⇒ 加一個**只存在於分頁**嘅「已解鎖」標記：

| 儲存 | 壽命 | 用途 |
|---|---|---|
| `localStorage` `authSession` | 直到登出 | 離線資料、PWA 重開 |
| **`sessionStorage` 解鎖標記** | **分頁／App 關閉即消失** | 分「冷啟」同「分頁內重整」 |

規則：

```
App 啟動
  ├─ 有 session？
  │    ├─ 冇 → /login
  │    └─ 有 → sessionStorage 有「已解鎖」標記？
  │            ├─ 有（分頁內重整／跳頁）→ 照用，唔問 PIN
  │            └─ 冇（冷啟）→ 清 session → /login 揀身份 + PIN
  └─ admin session（adminSessionToken）→ 唔受此限（後台有自己登入頁）
```

標記幾時寫：登入成功（`finishLogin()`）、裝置還原成功、後台登入成功。
標記幾時清：登出、冷啟被攔。

---

## 4. 順帶移除：`AuthGuard` 嘅自動裝置還原

舊版冷啟會自動用裝置憑證換一個 `device:` session 再跳 `/operator`。
同新規則衝突（等於繞過「認人」），而且同登入頁嘅身份卡功能重複。

⇒ 冷啟一律去 `/login`：

```
/login（裝置已初始化）
  → 身份卡：店主 / 小紅 / 阿明
  → 打自己 PIN
  → 入工作台（該身份權限）
```

`/operator` 保留「換班」用途，佢自己仍然會試裝置還原。

---

## 5. 改動

| 檔案 | 改動 |
|---|---|
| `src/lib/pos/terminal-lock.ts` | **新增**：`markTerminalUnlocked()` / `isTerminalUnlocked()` / `clearTerminalUnlocked()`（sessionStorage） |
| `src/components/auth-guard.tsx` | 加冷啟閘；移除自動裝置還原同 `restoring` 畫面 |
| `src/components/login-screen.tsx` | `finishLogin()` 寫標記；裝置模式查身份失敗時落 `identity` 步而唔係帳號步 |
| `src/lib/pos/device-binding.ts` | `restoreDeviceSession()` 成功寫標記 |
| `src/lib/ledger/session.ts` | `signOutLedgerSession()` 清標記 |
| `src/app/admin/page.tsx` | 後台登入寫標記 |

---

## 6. 驗收

- [ ] 關掉瀏覽器 → 再開 → **見到身份卡**（唔會直接入台）
- [ ] 揀店員 + PIN → 入台，權限係店員
- [ ] 分頁內按 F5 → 唔會再問 PIN
- [ ] 分頁內跳頁（`/` → `/settings` → 返回）→ 唔會再問
- [ ] 登出 → 就算唔關 tab，再開 `/` 都要重新揀身份
- [ ] 後台 `/admin` 登入 → 跳頁唔會被打斷
- [ ] `/operator` 冷啟照樣可以用裝置還原（換班流程）

---

## 7. 未做（建議下一輪）

**閒置自動鎖屏**：N 分鐘冇操作 → 回身份卡。
呢個補嘅係「同一個分頁之內」嘅接手問題（店員 A 行開、B 坐低按兩下就係 A 嘅權限）。
今次只解決「關掉再開」，同分頁內接手仍然要靠人手登出。
