# 71 · 模板設定未生效 / 儲存失敗 — 排查計劃

> 日期：2026-08-26
> 範圍：`macauPosSystem` web（模板設計介面 + 儲存層）
> 狀態：計劃（先出 Plan，confirm 先落碼）。涵蓋 P1 設定彈返預設、P2 設大但顯示唔變大、加 save 鈕。

## 1. 問題重述

- **P1**：模板設所有字型為「大」，按打印後設定全部彈返原本預設值。
- **P2**：介面字型全設「大」，但實際顯示（預覽 / 出紙）冇變大。
- **加 save 鈕**：現有 auto-save，但用家感覺「冇確實儲存成功」，要一個明確儲存動作 + 回饋。

## 2. 已確認嘅架構事實（查過 source）

- 儲存層：`savePosLocalSettings` / `loadPosLocalSettings`（`storage.ts:439-448`）都經 `storeScopedStorageKey`，無顯式 merchantId → 用 `getActiveMerchantId()`。
- key 規則（`storage.ts:93-97`）：登入 → `macau-pos/stores/{merchantId}/local-settings`；未登入 → `macau-pos/local-settings`（legacy global）。
- `getActiveMerchantId()`（`storage.ts:153-156`）= `authSession.merchantId ?? null`。**即 key 依賴當下 authSession 有冇載好。**
- ⚠️ **`writeJson`（`storage.ts:77-87`）對 `localStorage.setItem` 拋錯 `catch` 後完全 ignore** → 靜默寫失敗，零反饋。呢個係「感覺冇儲存」+「彈返預設」嘅頭號嫌疑。
- `patchBlock`→`updateLocalTemplate`→`savePosLocalSettings` 每次改 size 都即寫（`print-center.tsx`）；`mergeTemplateBlocks` 保留 size（唔會掉，見 docs/70）。
- 打印時 `buildReceiptPrintJobs` 等（`print-jobs.ts:43/90/149`）`loadPosLocalSettings()` 讀返並 `buildSnapshot` 入 PrintJob。

## 3. 假設排序

### P1（設「大」→ 按打印彈返預設）— 頭號嫌疑

- **A. 靜默寫失敗（可能性 高）**：kiosk WebView / 私隱模式 / quota 超 / 部分瀏覽器 `setItem` 拋錯被 ignore → localStorage 根本冇存到「大」。介面靠 React in-memory state 暫時顯「大」，一旦 print-center remount / 跳頁 / reload 再由 localStorage 讀 → 預設。同「感覺冇儲存」完全吻合。
- **B. merchantId scope 翻轉（可能性 中）**：save 時有 authSession（store key）；print 時 authSession 唔同（kiosk 登入唔 set authSession / 切店 / session 未載好）→ 改讀 global 或另一 store key → 該 key 冇存過 → 預設。
- **C. normalize 回預設（可能性 低）**：`normalizePosLocalSettings`（`storage.ts:221`）當 stored `printTemplates.{kind}.blocks` 缺失/畸形 → `mergeTemplateBlocks` 落 defaults。要查 save 落嘅 JSON 結構正唔正。

### P2（設「大」但顯示唔變大）

- **A. 未 rebuild（可能性 高）**：web `SIZE_PX.l` 18→22（`escpos-render.ts:47`）、Companion `l:0x30`、Android `SIZE_BYTE` 都只係 source 改咗，**未打包生效**。預覽仍 18px（只 1.64× s，唔夠「大」感）、出紙仍舊字節 → 看似「冇變大」。先確認有冇 rebuild+push。
- **B. 預覽 state 冇重渲（可能性 低）**：`buildPreviewLines` 讀 current `localSettings`，理應 `patchBlock`→`setLocalSettings` 即時更新；若 `useState` 初始化後冇因 state 變而重渲 → 查有冇 `useMemo` 緩存咗 lines。
- **C. save 失敗延伸（可能性 中）**：若從未 persist（同 P1-A），reload / print 後顯示預設 → 看似「設大但冇效」。

## 4. 可驗證排查步驟（瀏覽器 DevTools Console）

**步驟 0 —— 監聽 setItem 成功/失敗（一次過掛 hook，捕捉靜默失敗）：**
```js
const _set = Storage.prototype.setItem;
Storage.prototype.setItem = function (k, v) {
  try { _set.call(this, k, v); console.log('[setItem OK]', k, String(v).slice(0, 60)); }
  catch (e) { console.error('[setItem FAIL]', k, e && e.message); }
};
```
→ 喺介面將某區塊 size 改「大」。若 Console 出 `[setItem FAIL] macau-pos/stores/.../local-settings` → **確證 P1-A**（靜默寫失敗）。

**步驟 1 —— 鎖定正確 key 同改前後值：**
```js
const s = JSON.parse(localStorage.getItem('macau-pos/auth-session') || 'null');
const mid = s && s.merchantId;
const key = mid ? `macau-pos/stores/${mid}/local-settings` : 'macau-pos/local-settings';
console.log('ACTIVE KEY =', key);
const read = () => (JSON.parse(localStorage.getItem(key) || 'null') || {})
  .printTemplates?.receipt?.blocks?.total?.size;
console.log('改之前 size =', read());
// 喺介面將「總計」區塊設「大」
console.log('改之後 size =', read());   // 期望 "l"
```
→ 若「改之後」都係 `undefined`/`"s"` → 確證 P1-A（冇寫入）。

**步驟 2 —— 按打印後再讀同一 key：**
```js
// 直接打一張單，然後：
console.log('打印後 size =', read());   // 彈返 "s"/undefined → 確證 P1
```

**步驟 3 —— 查 scope 翻轉（P1-B）：**
```js
// 同時睇 global key 有冇值、同 store key 係咪唔同
console.log('GLOBAL =', localStorage.getItem('macau-pos/local-settings'));
console.log('STORE  =', localStorage.getItem(key));
// 若 GLOBAL 有值而 STORE 係 null（或相反）→ 確證 P1-B（save/load 落咗唔同 key）
```

**步驟 4 —— 區分 P2 預覽 vs 出紙：**
- 預覽唔變大：睇 `EscPosPreview` 嘅 `fontSize` → 若 `SIZE_PX.l` 仍 18（未 rebuild web）→ P2-A。
- 出紙唔變大：睇 Companion/APK 有冇 rebuild（舊 `l:0x60` / Android ignore template）→ P2-A。

## 5. 修復方案（待 confirm 先落碼）

### 5.1 加 save 鈕 + 寫入回報（直接解「感覺冇儲存」）
- `print-center.tsx` 設計介面 header（撤銷/重做旁）加「💾 儲存模板」鈕。
- `storage.ts` `writeJson` 改返 `boolean`（setItem 成功 `true` / 失敗 `false`，唔再 ignore）；`savePosLocalSettings` 返 `boolean`。
- 鈕 click：`const ok = savePosLocalSettings(localSettings)`；再 `read-back` 驗證 key 有值 → toast「✅ 已儲存」/「❌ 儲存失敗：<reason>」。
- 保留 auto-save（每次改都寫），但 save 鈕做權威確認 + 出錯即報。

### 5.2 修 scope 穩定（防 P1-B）
- save/load 唔好賴 `authSession` 當下值；改用 `bootstrap.storeId`（或 `loadBootstrapCache()?.storeId`）做 store key，令設計介面同打印讀寫同一 key。

### 5.3 P2 確認 rebuild
- web `next build` + push（SIZE_PX.l=22 生效）；Companion rebuild exe（講新版本號）；Android rebuild APK（P7）。三者都 rebuild 後 P2-A 自然消失。

## 6. 落碼順序（confirm 先）

1. `storage.ts`：`writeJson` 返 boolean + `savePosLocalSettings` 返 boolean（唔再靜默 ignore）。
2. `print-center.tsx`：加「儲存模板」鈕 + read-back 驗證 + toast 成功/失敗。
3. `storage.ts`：save/load 改鎖 `bootstrap.storeId` scope（防 P1-B）。
4. 確認 web/Companion/APK 三者 rebuild（P2-A）。
5. 回歸：console 跑步驟 0-3 驗證 setItem OK、打印後 size 仍 "l"、scope 一致。

## 7. 實作狀態（2026-08-26 confirm 落碼）

用家 confirm「全部 web 改動」+ 報「已 rebuild 但仍冇變大」。

### 7.1 已落碼（web，Vercel push 即生效）
- `storage.ts` `writeJson` → 返 `boolean`（setItem 失敗 `console.error` + `return false`，唔再靜默 ignore）；`writeStoreJson` 跟返 `boolean`。
- `storage.ts` 加 `resolveSettingsStoreScope()`（優先 `authSession.merchantId`，無 session 用 `loadBootstrapCache()?.storeId`）+ `getLocalSettingsKey()`（畀 UI read-back）。`loadPosLocalSettings` / `savePosLocalSettings` 改用佢 → **鎖 scope 防 P1-B**；`savePosLocalSettings` 返 `boolean`。
- `print-center.tsx` 設計介面 header（撤銷/重做旁）加「💾 儲存模板」鈕 → `saveTemplateNow()`：`savePosLocalSettings(localSettings)` 收 boolean；再 `localStorage.getItem(getLocalSettingsKey())` read-back 驗證 → toast「✅ 已儲存模板設定（並已寫入本機）」/「❌ 儲存失敗…」/「⚠️ 已寫入但讀回為空」。auto-save 保留。
- `tsc --noEmit` 零新 error（layout.tsx 誤報照避）。

### 7.2 P2「設大但顯示冇變大」實證結論（重要）
查 source：`patchBlock`→`setLocalSettings`→`buildPreviewLines`→`EscPosPreview` 映射 `fontSize: SIZE_PX[line.size]`，**無 useMemo 緩存**；`buildSnapshot` 忠實帶 `size`。即**現 source 嘅網頁預覽，設「大」(l=22px) 必定即時變大**。
- 推論：用家 live 仲「冇變大」嘅可能：①live build 早過 #3（`SIZE_PX.l` 舊 18，仍較細）；②設定冇 persist（P1-A 靜默寫失敗）→ remount 彈返預設（同一成因當 P2）；③**出紙（紙張）冇變大**＝ Companion #1 `l:0x60` bug / Android #2 未 rebuild（紙張大字依賴 Companion/APK，唔係 web 預覽）。
- 本次 web 改動（save 鈕 + writeJson boolean + scope 鎖）直接令 ①② 可被偵測：save 鈕 toast 即報 write 成功/失敗；若 persist OK，remount 後仍 "l"。③ 要 Companion rebuild exe（報新版本號）+ Android rebuild APK（P7）先解。

### 7.3 待用家 dev box 做（沙盒做唔到）
- web `next build` + push Vercel（令 #3 `SIZE_PX.l=22` + 本輪 save 鈕 live 生效）。
- Companion rebuild exe（含 #1 `l:0x30`）+ 報新版本號（standing instruction）。
- Android rebuild APK（含 #2 `SIZE_BYTE` / `renderTemplateTicket`，P7）。

### 7.4 回歸驗證（live 後）
- 網頁預覽：拖「總計」size 去「大」→ 預覽即變大（確證 ② 唔係 render bug）。
- 撳「💾 儲存模板」→ toast「✅ 已儲存」；reload 後再入設計介面仍 "l"（確證 persist OK，P1-A 排除）。
- 出紙：Companion/APK rebuild 後「大」紙張真雙高雙寬（確證 ③）。
- 若 save 鈕報「❌ 儲存失敗」→ 照 docs/71 §4 步驟 0 捉 `[setItem FAIL]` 根因（私隱/kiosk/quota）。
