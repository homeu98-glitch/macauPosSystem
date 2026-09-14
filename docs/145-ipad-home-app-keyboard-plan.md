# 145 — iPad「加入主頁」(standalone) 撳輸入欄位唔彈系統鍵盤｜診斷 + 修復方案

> 狀態：**方案待批（未改任何代碼）**
> 日期：2026-09-14
> 關聯：`docs/127-login-workbench-permission-plan.md`（`/login` 改版）、`docs/109` §3.4、
> `src/components/ios-focus-helper.tsx`、`src/lib/pos/ios-keyboard.ts`
> 實錄證據：J 提供 22s 屏幕錄影（iPad），逐秒抽幀後判定

---

## 一、症狀（實錄逐格確認）

| 時間 | 畫面 | 觀察 |
|---|---|---|
| t00–t01 | **主頁 App**（全屏、**冇地址欄**）`/login` | 撳輸入欄位，冇任何反應 |
| t03–t04 | **Safari 分頁**（地址欄 = `macau-pos-system.vercel.app`） | 撳「帳號」→ **系統鍵盤正常彈出、打得字** ✅ |
| t08–t13 | Safari 分享 → 「加入主頁」 | 係佢建立主頁 App 嘅過程 |
| t15 | 主頁撳 POS 圖示 | |
| t17–t21 | **主頁 App** 再嚟 | **t21：PIN 欄位有橙色 focus ring ＋ 文字游標，但系統鍵盤完全冇彈** ❌ |

**t21 係關鍵**：焦點（focus ring ＋ caret）**有到**，即係 tap 事件、聚焦、React 渲染全部正常 —— 係**作業系統冇把鍵盤呈現出嚟**。

---

## 二、責任判定：iOS/iPadOS 側，唔係本項目代碼

### 已排除嘅自家成因

| 懷疑點 | 查證結果 |
|---|---|
| viewport 鎖死縮放（`user-scalable=no`）| ❌ 排除。線上 HTML 實抓：`viewport = width=device-width, initial-scale=1, viewport-fit=cover`，**冇** `user-scalable=no`。即之前（2026-09-14）懷疑嘅成因**已修好且已部署**（`HEAD == origin/main`，工作區乾淨） |
| `pointer-events` / z-index 遮擋 | ❌ 排除。焦點有到 = 事件有入到 |
| React remount 令焦點走失 | ❌ 排除。focus ring 同 caret **持續存在**，冇被重繪掉 |
| 有實體鍵盤所以抑制軟鍵盤 | ❌ 排除。同一部機 Safari 彈得出 |
| Service worker 供應舊版 HTML | ❌ 排除。navigate 係 network-first；而且 Safari 亦受同一個 SW 管 |

⇒ **同一部 iPad、同一份部署，唯一差異 = 有無瀏覽器殼。**

### 外部權威來源（Apple/WebKit 已知 bug）

| 來源 | 內容 |
|---|---|
| **WebKit #279904** | iOS 18 起，**已安裝 Web App** focus 到任何 input（含 contenteditable）都唔彈鍵盤。重啟 iOS 可暫時解決。**主要影響「iOS 17 裝、之後升 18」嘅舊安裝** |
| **WebKit #235891** | iPad PWA 連 `<select>` 原生選單、**file picker** 都唔出（焦點有到、原生 UI 唔彈）—— 同一病徵 |
| Apple Dev Forum 700736 | iPad 主頁 App 冇鍵盤；bmw.com、Instagram 同樣中招；**「一個 PWA 中招，全部 PWA 都中招」**；官方 workaround = 重啟 iPad 或直接用 Safari |
| silverbullet 社群 | **iPadOS 26.5** 一樣開唔到 PWA 鍵盤，而**同一部機 iOS 26.5 正常** ⇒ **iPadOS 獨有** |
| MacRumors（2026-08，iOS/iPadOS 27 beta）| 「Safari 冇事、主頁 Web App 唔得」仍然存在 |
| Appfarm 社群（2026-04，iPadOS 26.3.1）| iPad + 實體鍵盤下，撳 input 會出現「準備鍵盤嘅空白」但鍵盤唔出；重啟 iPad 係唯一可靠重置 |

### 已試過無效（唔好再叫人試）

- ❌ **刪主頁圖示 → 重新「加入主頁」**：J 已實試，**無效**（原本對應 #279904「喺新 OS 重裝即正常」嘅假設，對呢部機唔成立）。

### 升級系統可唔可以解決？→ **唔可以當解決方案**

- iPadOS **26.6**（現時最新）更新說明**只有一條 Wi-Fi「私密位址」修正**，冇任何鍵盤／WebKit 相關 fix。
- iPadOS **26.5** 有人實測仍然壞（iPadOS 獨有）。
- 歷史：iOS 15.1 → 15.5 → 18 → iPadOS 26.3.1 → 26.5 一路斷續出現。
- 同族旁證：iPadOS 26.5 更新說明要修「**非英文語言**裝置喺密碼提示唔出鍵盤」——iPadOS 26 本身有一個「鍵盤唔彈」bug 家族。

⇒ **升到最新版本可以順手做（免費、或有幫助），但 POS 係生產系統，唔可以賭 Apple。**

---

## 三、方案（三條路，可並存）

### 方案 A（推薦）：`/login` 支援「螢幕自繪數字鍵盤」

**核心思路**：登入頁本來就係純數字（8 位帳號 + 4 位 PIN）。用螢幕鍵盤收集輸入，
就完全**唔需要系統鍵盤**，同 iPadOS 版本／Apple 幾時修完全脫鈎。

**關鍵設計 —— 唔係「假輸入框」，而係「真 input + `inputMode="none"`」：**

| 模式 | 輸入欄 | 鍵盤 | 適用 |
|---|---|---|---|
| `system`（現狀）| 真 `<input>`，`inputMode="numeric"` | 系統鍵盤 | 手機 Safari、桌面瀏覽器 |
| `keypad`（新增）| **仍然係真 `<input>`**（唔 `readOnly`、唔 `disabled`），加 `inputMode="none"` | **螢幕自繪數字鍵盤** | 主頁 App（standalone）、平板 |

- `inputMode="none"` 係 iOS 支援嘅標準值 → 聚焦時**唔叫系統鍵盤**；
- 但欄位仍然係真 input ⇒ **硬鍵盤、貼上、Tab 鍵、無障礙（VoiceOver）全部照用**；
- 呢個做法同時滿足本項目既有紅線（「手機用真 input、平板走自繪鍵盤」），
  因為分流係**按 variant** 而唔係靠假欄位。

**分流規則（`auto` 模式判定順序）**

1. `display-mode: standalone` 或 `navigator.standalone` → `keypad`
   （**呢個就係今次嘅病理位置**，唔理螢幕幾大）
2. 觸控裝置（`pointer: coarse`）＋ 最短邊 ≥ 600px（平板）→ `keypad`
3. 其餘 → `system`（**維持現狀，零回歸風險**）

**逃生門**（必備，跟 `member-login-sheet.tsx`「一定要有逃生門」嘅既有慣例）：
`keypad` 模式下提供一個「改用系統鍵盤」小按鈕，一撳即切去 `system`。
（用於：iOS 修好之後、外接硬鍵盤、或者螢幕鍵盤唔想用嘅情況。）

**改動範圍（預估）**

| 檔案 | 改動 | 說明 |
|---|---|---|
| `src/components/login-screen.tsx` | 主要 | 加 `variant` 狀態 + 判定、`inputMode` 分流、掛 `NumericKeypad`、逃生門按鈕 |
| `src/components/numeric-keypad.tsx` | 小 | 目前係**淺色 slate 主題**，而登入頁係深色玻璃卡 → 需加 `tone="dark"`（或 `className` 覆蓋）；另加 `disabled` |
| `src/lib/pos/input-variant.ts`（新，可選） | 小 | 抽出「standalone / 平板 / 手機」判定，方便日後其他頁重用 |
| `src/app/manifest.ts` | **唔使改** | 現有設定已經正常產生 standalone App |
| `public/sw.js` | 可選 | 順手擰 `CACHE_NAME`（`macau-pos-v20-7-31` → 新版）方便清舊快取 |

**影響面**

- ✅ 只影響 `/login` 一頁。**唔涉及** DB / API / 列印 / Ledger 契約。
- ✅ **唔使擰 versionCode**：desktop / Android 殼載同一個 Vercel 網址，
  只要 **deploy** 就三邊同時生效（唔關 relay / hub / android / companion 四份版本號事）。
- ✅ `variant = system` 嘅路徑**完全冇改動**，所以手機／桌面零回歸。

**驗證（完成定義）**

1. `tsc --noEmit` 0 error｜`eslint`（改動檔）0 error / 0 warning。
2. **iPad 主頁 App**：撳「帳號」→ 螢幕鍵盤即刻可用、可以完成 8+4 位登入 ✅（原本死局）
3. **iPad 主頁 App**：螢幕鍵盤唔會叫出系統鍵盤（`inputMode="none"` 生效）。
4. **iPhone Safari**：行為同改動前一樣（系統鍵盤）。
5. 兩個欄位仍然係真 `<input>`：可以用外接硬鍵盤輸入、可以貼上。
6. 逃生門按鈕可以即時切去 `system`。
7. 機測機型：**J 部 iPad**（`設定 › 一般 › 關於本機` 記低 iPadOS 版本）＋ 至少一部 iPhone。

**風險 / 注意**

- `inputmode` 唔支援嘅舊環境會退化成「叫系統鍵盤」→ **無害**（因為螢幕鍵盤同時在）。
- 加咗鍵盤後 `/login` 卡片會變高。現時容器已經係 `fixed inset-0 overflow-y-auto`（見
  `login-screen.tsx` 頂部註解），有得滾 → 但要實機確認喺 iPad 橫屏唔會被切。
- 用戶肌肉記憶改變 → 需一句提示文案（例：「請用螢幕數字鍵盤輸入」）。

---

### 方案 B（中長期）：全 app「自由文字輸入」嘅共通對策

⚠️ **登入頁唔係唯一受害者。** 主頁 App 內**任何自由輸入**都會同樣中招：

- 全單備註 / 單品備註（`textarea`，即 `docs/109` §3.4 嗰個位）
- 會員手機號、零售掃碼、折扣、送貨地址…

現時嘅兜底（`IosFocusHelper` ＋ `refocusForIosKeyboard()`）**只解決「捲動揭露」同「已聚焦再撳」**，
**解決唔到「OS 根本冇呈現鍵盤」**。

可考慮（未排期）：

1. **統一觸控輸入元件**：抽出一個 `TouchInput`（真 input + `inputMode` 分流 + 可選自繪鍵盤），
   自由文字欄位一律經佢渲染。
2. **偵測 + 提示 fallback**：focus 後 300ms 若 `visualViewport.height` 冇縮（＝鍵盤明顯冇開），
   顯示一條提示／切去自繪鍵盤。⚠️ 注意 26.3.1 有「viewport 縮咗但鍵盤唔出」嘅報告，
   所以判定**唔可以只靠 visualViewport**。
3. **最暴力但最穩**：iPad 上一律**用 Safari 開**（唔用主頁 App）—— 官方推薦 workaround。

---

### 方案 C（零代碼，即時可用）

| 做法 | 代價 |
|---|---|
| iPad 用 **Safari** 開（唔用主頁 App）| 冇全屏、有地址欄；但**一定得** |
| 用 Safari 書籤 / 主畫面**書籤**（唔要 standalone）| 同上 |
| 外接藍牙 / Smart Keyboard | 要有硬件，而且 #235891 有實體鍵盤都中招 |
| 重啟 iPad | 只係暫時重置，會再中 |

---

## 四、決策矩陣

| | 方案 A 自繪鍵盤 | 方案 B 全 app 對策 | 方案 C 用 Safari |
|---|---|---|---|
| 解決登入死局 | ✅ 徹底 | ✅ | ✅ |
| 解決備註等自由輸入 | ❌ | ✅ | ✅ |
| 受 iPadOS 版本影響 | ❌ 完全免疫 | ❌ 完全免疫 | ❌ |
| 改動量 | 小（1–2 個檔） | 中～大（跨頁） | 0 |
| 用戶體驗 | 平板更好撳 | 需逐頁設計 | 有瀏覽器 UI |
| 建議 | **先做** | 排期 | 過渡 |

**建議次序：C（即刻）→ A（先做，解死局）→ B（排期）。**

---

## 五、待 J 提供 / 待確認

1. **iPadOS 版本 + 機型**（`設定 › 一般 › 關於本機`）。如果係 26.0～26.3，可以順手升 26.6 搏一搏；
   如果已經 26.5 / 26.6，就唔使等。
2. **隔離測試（可選但建議，5 分鐘、零代碼）**：
   iPad Safari 開 `https://www.google.com` → 分享 → 加入主頁 → 開圖示 → 撳搜尋框。
   若**同樣唔彈** ⇒ 100% 確認係 iPadOS 對「主頁 Web App」嘅系統問題，同本項目完全無關，
   亦可以用嚟說服 Apple 或做紀錄。
3. 主頁 App 內除咗登入，**仲有邊啲場景一定要打自由文字**？（決定方案 B 嘅範圍）

---

## 附錄：本次取證方法（可重用）

影片係 HEVC，而環境只有裁剪版 ffmpeg（`--disable-everything`，**冇 image muxer / png encoder**）：

1. 用 `TRAE SOLO/resources/app/bin/ffmpeg.exe` 轉 H.264（hevc decoder + libx264 + mp4 muxer）。
2. Node 內建 `http` 起靜態 server（🔴 **必須實作 Range 206**，否則 `video.currentTime` 永遠 0）＋
   Chrome `--headless=new --remote-debugging-port` ＋ **Node 22 內建 `WebSocket`** 直講 CDP
   （`Page.captureScreenshot`，唔用 canvas `toDataURL()` —— 會被 taint）。
3. 22 格砌成一張 contact sheet 一次過睇，再對關鍵秒數讀全尺寸 PNG。

已存為 skill：`~/.workbuddy/skills/video-frame-forensics`。
