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

---

## 8. 根本原因（2026-08-25 深入排查）：「Toast ✅ 但 reload / 打印彈返預設」

> 用家報：撳 save 鈕 toast「✅ 已儲存」正常；但頁面 reload、或切去 pos-app 打印後，字型設定彈返預設；紙張從未印出大字體。

### 8.1 已排除嘅舊假設
- **P1-B scope 翻轉**：`resolveSettingsStoreScope()`（storage.ts:166-171）save/load 兩邊都行，authSession 喺 localStorage 持久化 → save 同 reload 讀同一 key，**唔係**呢個成因。
- **normalize 掉 size**：`mergeTemplateBlocks`（storage.ts:219-231）係 `{ ...def[id], ...s }` → **saved 優先**，size 唔會被 defaults 蓋走。
- **寫失敗**：save 鈕 read-back `localStorage.getItem(getLocalSettingsKey())` 非 null → 確實寫入咗本機（key 有嘢）。

### 8.2 真正 root cause —— pos-app 嘅後台 backfill 把本地模板覆寫成預設

**觸發鏈：**
1. 用家喺 print-center 設「大」→ `updateLocalTemplate` auto-save + 「💾 儲存模板」鈕 → `savePosLocalSettings` 寫入 localStorage（key 有 "l"）。預覽即變大，toast ✅。
2. print-center **只寫 localStorage，從未 POST 去後台**（對比 device-settings 會 POST）。所以 `pos_device_configs.local_settings` 入面嘅 `printTemplates` 永遠係 bootstrap 落嘅**預設**，後台冇用家嘅「大」設計。
3. 用家切去 pos-app / reload → pos-app 喺 mount 跑 `/api/pos/state` backfill（`pos-app.tsx` 約 575-650，`loadRuntimeState`）。
4. 後台 `/api/pos/state` 回 `localSettings: normalizePosLocalSettings(deviceConfigRow?.local_settings ?? defaultPosLocalSettings)`（`state/route.ts:99`）→ **server 預設 printTemplates**。
5. pos-app 收到 `payload.localSettings` → **直接 `savePosLocalSettings(merged)` 覆寫本機**（pos-app.tsx:632-642）：
   ```ts
   if (payload.localSettings) {
     const localFloors = loadPosLocalSettings().floors;
     const merged: PosLocalSettings = {
       ...payload.localSettings,        // ← server 版（printTemplates = 預設 "m"/"s"）
       floors: localFloors?.length ? localFloors : payload.localSettings.floors,
     };
     savePosLocalSettings(merged);      // ← 本地「大」設計被 server 預設蓋走！
   }
   ```
6. 之後 reload / 打印 → `loadPosLocalSettings()` 讀到嘅係 server 預設 → 彈返預設。紙張亦因 snapshot 已係預設而印細字。

**結論：設定「被覆寫/重置」嘅位置 = `pos-app.tsx:632-642` 嘅 sync merge。** 每次 mount / backfill / realtime 收 `localSettings` 都會用 server 預設蓋本地設計。原因係 print-center 嘅模板設計係 client-only（架構留咗 Ledger push seam），server 永遠係預設，於是 sync 變成「每逢同步就重置」。

### 8.3 紙張從未大字體（獨立、疊加嘅第二成因）
即使本地 localStorage 真係 "l"（例如未觸發 backfill 嘅瞬間打印），出紙大字體仲要倚靠：
- Companion exe 嘅 `SIZE_BYTE.l = 0x30`（#1，已 source 改，待 rebuild + 報版本號）；
- Android APK 嘅 `SIZE_BYTE` / `renderTemplateTicket`（#2，P7，待 rebuild）；
- web `SIZE_PX.l = 22`（#3，已 source 改，待 `next build` + push Vercel live）。
三者任缺一则紙張印唔出大字。呢層與 8.2 嘅 localStorage revert 係兩件事，要分開解。

### 8.4 具體修復方向（待 confirm 落碼）
**A. 停 sync 覆寫（核心修，1 個檔）：** `pos-app.tsx:632-642` 嘅 merge 唔可以讓 server `localSettings` 蓋走 client-authoritative 欄位。模板設計係本地真源，應保留本地 `printTemplates`：
   ```ts
   if (payload.localSettings) {
     const local = loadPosLocalSettings();              // 本地（含用家「大」設計）
     const merged: PosLocalSettings = {
       ...payload.localSettings,                          // server 全局設定優先
       floors: local.floors?.length ? local.floors : payload.localSettings.floors,
       printTemplates: local.printTemplates,              // ← 保留本地模板設計，唔畀 server 預設蓋
       // 若 specTemplates 都係 client-only，一併保留：specTemplates: local.specTemplates,
     };
     savePosLocalSettings(merged);
   }
   ```
   或者更穩陣：用 `deepMergeLocalSettings(local, server)` 只對「server 真管嘅欄位」(paymentMethods / onlineOrderSettings / menuPrinterOverrides / reopenReasons …) 取 server，其餘留本地。
**B. （可選，跨終端同步才需要）** 把 print-center 嘅「💾 儲存模板」同時 POST `/api/pos/device-config` 把 `printTemplates` 推去後台（補返而家漏咗嘅 push seam）。呢層係 feature，唔係修 bug，先擱。
**C. 紙張層**：Companion rebuild（報版本）+ Android rebuild + web `next build` push，令 #1/#2/#3 生效。

### 8.6 實施狀態（2026-08-27 已落碼）
- `pos-app.tsx:632-642` sync merge 改為保留本地 `printTemplates`：`const local = loadPosLocalSettings(); const merged = { ...payload.localSettings, floors: local.floors?.length ? local.floors : payload.localSettings.floors, printTemplates: local.printTemplates }; savePosLocalSettings(merged);`。
- 效果：每逢 mount / backfill / realtime 收 `localSettings` 唔會再用 server 預設蓋走本地模板設計 → reload / 打印後字型設定保持（唔會彈返預設）。
- `tsc --noEmit` 零新 error（僅 layout.tsx 已知誤報 `LayoutProps`）。web-only，Vercel push 即生效，唔使 rebuild exe / apk。
- 注意：本修只解「localStorage revert」；**紙張大字體**仍要 Companion #1 `l:0x30` rebuild + Android #2 rebuild + web #3 `SIZE_PX.l=22` push 三者齊全（詳 §8.3）。

### 8.5 快速確證（用家可自己驗）
1. print-center 設「大」→ save → DevTools Console `localStorage.getItem('macau-pos/stores/<merchantId>/local-settings')` → 見 `"size":"l"` 確認寫入。
2. 唔 reload，直接切去 pos-app 收銀介面（觸發 backfill）→ 再 `getItem` 同一 key → 變返預設 `"size":"m"/"s"` → 確證 8.2 係元凶。
3. 修 A 後重做一次 → key 保持 "l" → revert 消失。

---

## 10. 第二個紙張成因（2026-08-25 落碼）：中文（Kanji）唔受 ESC ! n 倍大影響

> 用家報（turn 4-5）：介面已將「所有內容」字體設大，但實際出紙**只有數字變大，中文字全部冇變大**。
> 確認：呢個係**紙張（ESC/POS）層嘅 font 問題**，唔係 web 預覽 bug。

### 10.1 Root cause —— 熱敏機有兩套獨立字庫

熱敏印機同時有：
- **Alphanumeric / Latin 字庫**（英數、數字、符號）→ 受 `ESC ! n`（0x1B 0x21 n）控制。
  - `SIZE_BYTE = { s:0x00, m:0x20, l:0x30 }`（bit5=雙寬，bit4=雙高；見 §2/#1）。
- **Kanji / CJK 字庫**（中日韓，中文經 GB18030/GBK/Big5 多字節入機）→ 受 `FS ! n`（0x1C 0x21 n）控制，**唔受 `ESC ! n` 影響**。
  - `FS ! n` 嘅 bit 位同 `ESC ! n` **唔同**：`KANJI_SIZE_BYTE = { s:0x00(正常), m:0x01(雙寬), l:0x03(雙高雙寬) }`。（⚠️ 標準規格；**商頌 POS-80 實機唔認 `FS ! n`**，要 `FS &` 入 Kanji mode + `GS ! n` 倍大，見 §11，KANJI_SIZE_BYTE 改 0x20/0x30。）

中文文字以多字節（GB18030 等）送落印機 → 印機自動路由去 Kanji 字庫 → `ESC ! n` 只切咗 Latin 字庫嘅大小，**Kanji 字庫維持預設 1x1**。結果同一行：數字（Latin）變大、中文（Kanji）唔變 → 正正係用家見到嘅「只有數字變大」。

### 10.2 三層 symptom 拆解（重要，唔好同 §8 撈亂）

- **預覽（web）**：`EscPosPreview` 每行 `fontSize: SIZE_PX[line.size]` 係整行 uniform 套 CSS px，**無分 Latin/Kanji** → 預覽設「大」整行（含中文）必變大。所以用家預覽「中文有變大」係正常。
- **介面設「大字體」但預覽只數字變大（turn 3）**：查 `escpos-template.ts` `KITCHEN_BLOCK_DEFAULTS` → 用家當時只將 `order_no / table_name / time` 等**數值區塊**設大，中文字區塊（store_name / order_type / order_note / footer / items 名）仍 "s" → **per-block size 設定問題，唔係 font bug**。解：將所有區塊 size 設一致，或加「全部套用大字」批次鈕（未做）。
- **介面全部設大、預覽中文有變大、但出紙中文仍唔變大（turn 4-5）**：呢個先係 §10 嘅 ESC/POS font 問題 → 要 `FS ! n` 先解。

### 10.3 修復（已落碼，Companion + Android）

**A. desktop-companion/companion-server.mjs（模板路徑 `textLine`，約 247-254）：**
```js
const KANJI_SIZE_BYTE = { s: 0x00, m: 0x01, l: 0x03 };
const hasCJK = (s) => /[\u3400-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/.test(s || "");
const textLine = (text, size, bold, align) => {
  setAlign(align);
  setStyle(size, bold);                      // ESC ! n（Latin 倍大）
  if (hasCJK(text)) push(Buffer.from([0x1c, 0x21, KANJI_SIZE_BYTE[size] || 0x00])); // FS ! n（Kanji 倍大）
  push(encodeText(text, charset));
  push(Buffer.from([0x0a]));
};
```
`node --check companion-server.mjs` ✅ 通過。

**B. print-agent-android/.../net/EscPosRenderer.kt（`Buf` 類）：**
```kotlin
private const val FS = 0x1C
private val KANJI_SIZE_BYTE = mapOf("s" to 0x00, "m" to 0x01, "l" to 0x03)
private fun hasCJK(s: String): Boolean { /* 同 Companion 範圍 */ }

private class Buf(private val cs: Charset) {
    private var curSize: String = "s"        // 記低當前 ESC ! n 檔畀 FS ! n 用
    fun str(s: String) = apply {
        if (hasCJK(s)) cmd(FS, 0x21, KANJI_SIZE_BYTE[curSize] ?: 0x00)
        out.write(encode(s, cs))
    }
    fun line(s: String = "") = apply {
        if (hasCJK(s)) cmd(FS, 0x21, KANJI_SIZE_BYTE[curSize] ?: 0x00)
        out.write(encode(s, cs)); out.write(LF)
    }
    fun style(size: String, bold: Boolean) = apply {
        curSize = size                        // 模板路徑先 call style 再 call line → curSize 同步
        cmd(ESC, 0x21, SIZE_BYTE[size] ?: 0x00)
        cmd(ESC, 0x45, if (bold) 1 else 0)
    }
}
```
順序（ESC ! n → FS ! n → text）同 Companion 一致。`Buf.str/line` 亦被 legacy 路徑（`renderKitchenTicket` 等）直接 call，但佢哋從未 call `style` → `curSize` 留 "s" → `FS ! n 0x00`（正常 Kanji，no-op），安全。

### 10.4 決定略過嘅路徑

Companion **legacy fallback `line(text,{bold,center})`**（無 size 參數，固定預設字）冇加 `FS ! n`：因佢只處理「無 template 快照」舊 job，永遠單一預設字，加咗都只會 send `FS ! n 0x00`（no-op），對用家「設大字」症狀無幫助 → 略過。模板驅動路徑已全面覆蓋。

### 10.5 已知風險（唔係 bug，係硬件限制）

部分廉價熱敏機嘅 Kanji 字庫固定 24×24，會 ignore `FS ! n` → 改咗 code 都唔會倍大中文。本修對多數機（支援 `FS ! n` Kanji 縮放）有效，對呢類死字庫機無效。若用家機型屬此類，需換機或接受中文固定大小（數字仍可倍大）。

### 10.6 部署（standing）

- **Companion**：`npm run dist` rebuild exe（含 `KANJI_SIZE_BYTE` + `textLine` 修正）+ **報新版本號**（用家 standing instruction：每次 desktop app 更新要主動報版本）。
- **Android**：`./gradlew assembleDebug` rebuild APK（含 `FS` 常數 + `Buf` 修正；沙盒無 Android SDK，待用家 dev box）。
- **web**：`SIZE_PX.l=22` 早已 source 改，Vercel push 即生效；預覽層冇受 §10 影響（CSS uniform），唔使改。

---

## 11. 第三層成因（2026-08-27）：商頌 POS-80 唔認 FS ! n（要 FS & 入 Kanji mode）

> 用家 confirm：① 中文區塊已全設「大」（Layer 1 排除）；② Companion/APK 已 rebuild 含 FS ! n（Layer 2 排除）。但中文仍唔變大 → 確證 Layer 3（印機 firmware 唔買 FS ! n 帳）。

### 11.1 Root cause
- 兩個 renderer 從未 send 任何「字集切換」指令：無 `FS &`（0x1C 0x26 入 Kanji mode）/ `FS .`（0x1C 0x2E 出）、無 `ESC t`（0x1B 0x74 code page）、無 `ESC ( C` 揀中文 font。
- 商頌 POS-80 中文印到（細）係靠開機預設 auto-detect multibyte → 用預設 Kanji 字庫 render；`FS ! n` 只對「已入 Kanji mode（FS &）嘅 Kanji 字型」生效，無顯式 FS & 時變 no-op。
- 推論：ESC ! n 生效（數字變大）證印機正常處理 ESC/POS 字型指令；只係中文路徑（Kanji font）未 engage → 加 `FS &`/`FS .` 包裝就係最可能的修。

### 11.2 修正（已落碼，CONFIRMED 實機 V5/V6）
- **指令順序（Companion + Android 完全一致）**：當行含 CJK →
  `FS &`(0x1C 0x26) 入 Kanji mode → `GS ! n`(0x1D 0x21, KANJI_SIZE_BYTE[size]) 倍大中文 → 送 bytes → `FS .`(0x1C 0x2E) 出 Kanji mode。
- **KANJI_SIZE_BYTE = { s:0x00, m:0x20, l:0x30 }**（= GS ! n bit，同 ESC ! n 位元；"大"→ l → 0x30 = V5）。
- Companion `companion-server.mjs` `textLine`（227-258）：`KANJI_SIZE_BYTE` 改 0x20/0x30；`push([0x1d,0x21,...])`(GS ! n) + `FS &`/`FS .` wrap。`node --check` ✅。
- Android `EscPosRenderer.kt` `Buf.str/line`（66-81）：`KANJI_SIZE_BYTE` map 改 0x20/0x30；`cmd(FS,0x26)` → `cmd(GS,0x21,KANJI_SIZE_BYTE[curSize])` → bytes → `cmd(FS,0x2e)`（`FS`/`GS` 常數 0x1C/0x1D 已存在）。curSize 由 `style()` 同步；legacy 路徑唔 call style → curSize="s" → GS ! n 0x00，包住 FS &/FS . 都只係入出 mode 唔倍大，安全。
- **版本**：Companion bump `0.1.13 → 0.1.14`（0.1.13 係 FS ! n 嘗試，用家 rebuild 後實測 V1-V4 都唔得，故再升一版落 GS ! n，standing instruction：更新 desktop app 要報版本）。

### 11.3 對照測試腳本（已完成使命，留底備查）
`desktop-companion/test-kanji-size.mjs` 印 V1–V6 六 variant，用家報 **V5/V6 PASS** → 鎖定 `FS & + GS ! n`。
- V1 = ESC!n only（中文唔變，現象重現）；V2 = FS!n 無 FS&（no-op）；V3 = FS&+FS!n(0x03)（no-op）；V4 = FS&+FS!n(0x30)（no-op）；V5 = FS&+GS!n(0x30) ✅；V6 = FS&+GS!n(0x03) ✅（對照組，證指令被收）。
- 若日後換機再遇「中文唔變大」，可再跑此腳本對照；但已鎖定商頌 POS-80 用 V5 邏輯（即現 renderer）。
- 用法：`node test-kanji-size.mjs <printer-ip> [port=9100]`（GB18030 經 iconv-lite encode；port 可帶 `[port=9100]` 括號）。

### 11.4 部署（standing）
- **Companion**：`npm run dist` → 出 **0.1.14**（含 FS & + GS ! n 修正，KANJI_SIZE_BYTE 0x20/0x30）。用家必須 rebuild 新 exe（0.1.13 含舊 FS ! n 仍唔得）。
- **Android**：`./gradlew assembleDebug`（沙盒無 SDK，待用家 dev box；EscPosRenderer.kt 已落 GS ! n）。
- **web**：預覽層 CSS uniform 無受影響（§10.2 已述）；`SIZE_PX.l=22` 早已 source 改，Vercel push 即生效。
- 回歸：rebuild 後設「大」打印 → 數字 + 中文同時變大 = 修復完成。
