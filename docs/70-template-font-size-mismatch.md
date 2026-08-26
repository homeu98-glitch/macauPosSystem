# 70 · 模板「大」字型打印不一致 — 根因分析與排查

> 日期：2026-08-25
> 範圍：跨 3 個 repo —— `macauPosSystem`（web / 預覽 / 組單）、`desktop-companion`（桌面打印代理）、`print-agent-android`（Android APK）
> 狀態：已定位根因；本輪只做分析，未落碼。

## 1. 現象

用家喺「打印中心 → 收據/廚房/標籤模板」將某區塊字型設成「大（l）」並打單，實際出紙字型與模板內預覽唔一致（感覺細咗 / 三級無分別）。用家特別提到模板介面「冇保存按鈕」。

## 2. 用家三個假設嘅對錯判斷

| 假設 | 判斷 | 理由 |
|------|------|------|
| ① 模板未正確保存 | ❌ 排除 | 模板係 auto-save（冇 save 鈕係設計）。`print-center.tsx` 嘅 `patchBlock`→`applyTemplate`→`updateLocalTemplate`→`savePosLocalSettings` 即時寫入 localStorage。讀取側 `storage.ts:199` `mergeTemplateBlocks` 用 `{ ...def[id], ...s }` 完整保留 `size/bold/align/subSize/layout`，唔會掉。 |
| ② 預覽與實際渲染差異 | ✅ 中 | 預覽用 `SIZE_PX`（CSS px 近似），實際打印用 ESC/POS 字節，兩者語意本來就唔 1:1；再加後端字節映射有 bug，差異被放大。 |
| ③ 字型設定未被套用 | ✅ 中 | Companion 路徑：有套用但「大」字節錯（見 §3-A）；Android 路徑：100% 冇套用（見 §3-B）。 |

**結論：web 端 design == preview == 快照 100% 一致，問題 100% 出喺打印後端。**

## 3. 根因

### A. 桌面 Companion 路徑（主要嫌疑）

檔案：`desktop-companion/companion-server.mjs:222`

```js
const SIZE_BYTE = { s: 0x00, m: 0x20, l: 0x60 };
// line 234: push(Buffer.from([0x1b, 0x21, SIZE_BYTE[size] || 0x00])); // ESC ! 字型大小
```

`ESC ! n`（0x1B 0x21 n）標準位元定義：

- bit4 (0x10) = double-height（雙高）
- bit5 (0x20) = double-width（雙寬）
- bit6 (0x40) = **保留位**，多數熱敏機忽略

所以：

- `s = 0x00` → 正常字（正確）
- `m = 0x20` → 雙寬、唔雙高
- `l = 0x60 = 0x20 | 0x40` → 雙寬 + 保留位 → 打印機忽略 0x40，**當成 0x20，同 `m` 完全一樣（只雙寬，永遠唔雙高）**

→ 用家選「大」喺紙上同「中」印出嚟一模一樣，永遠唔會變大。預覽 `SIZE_PX={s:11,m:14,l:18}` 顯示三級遞增，但紙上實際得兩級（s 正常、m==l 雙寬）。呢個就係「不一致」。

註：`companion-server.mjs:221` 註解寫「m=雙高 / l=雙高雙寬（對應 ESC ! n 嘅 bit5/bit6）」係**錯嘅 ESC/POS 語意**——雙高係 bit4(0x10) 唔係 bit5；bit6 係保留位。

**正確映射（建議）：**

```js
const SIZE_BYTE = { s: 0x00, m: 0x10, l: 0x30 };
// l = 0x10 | 0x20 = 雙高 + 雙寬（真正最大）
// m = 0x10 = 雙高（中級）；或 keep m:0x20 雙寬亦可，總之 l 必須係 0x30
```

### B. Android APK 路徑（同樣中招，且更嚴重）

檔案：`print-agent-android/app/src/main/java/com/macau/pos/printagent/net/EscPosRenderer.kt`

`MainActivity.printJob`（`MainActivity.kt:159-163`）按 `kind` 呼叫：

```kotlin
"receipt" -> EscPosRenderer.renderReceiptTicket(...)
"test"    -> EscPosRenderer.renderTestPage(...)
else      -> EscPosRenderer.renderKitchenTicket(...)
```

但 `renderReceiptTicket` / `renderKitchenTicket` / `renderTestPage` **全部係寫死 layout，完全冇讀 `job.template` 嘅 `blocks[].size / bold / align`**。即係喺 Android 上路徑，用家喺模板設嘅字型大小對實際出紙**完全冇影響**，全部用正常字印。

→ 預覽有三級、紙上得一般。呢條路徑仲停留喺舊 `escpos.mjs` 時代，未跟到 web 嘅「模板快照」統一架構（Companion `renderEscPos` 已跟到）。

**修復方向：** 將 `EscPosRenderer` 改成讀 `PrintJobDto.template` 快照、按 `b.size/bold/align/subSize` 發 ESC 字節，算法與 `companion-server.mjs` 嘅 `renderEscPos` 同源（亦要修正 §3-A 嘅 0x60→0x30）。需 rebuild APK（P7 layout 一併補 template 分支）。

## 4. 預覽側 `SIZE_PX`（次要，建議同步）

`src/lib/escpos-render.ts:47`

```ts
export const SIZE_PX: Record<EscPosSize, number> = { s: 11, m: 14, l: 18 };
```

CSS px 近似冇錯，但 `l:18` 相對 `s:11` 只係 ~1.64×，反映唔到真 ESC 雙高雙寬（視覺應 ≈2× 高）。修好後端後，建議預覽調成 `s:11 / m:14 / l:22`（l≈2× s），令「設計介面＝預覽＝實紙」真正貼合。

## 5. 排查方向（用家可自己確認中邊條路徑）

1. **確認有冇存到**：瀏覽器 DevTools Console 執行
   ```js
   JSON.parse(localStorage.getItem('macau-pos/stores/<merchantId>/local-settings')).printTemplates.receipt.blocks.total.size
   ```
   應該係 `"l"`。唔係 → 模板冇存（理論唔會，見 §2 ①）。
2. **確認有冇傳到 print job**：打印中心開張單 → 喺 Console 撈該 PrintJob 嘅 `template.blocks` 入面 `size` 係咪 `"l"`。係 → 表示 web 端冇問題，鍋在後端。
3. **分辨 Companion vs Android**：
   - 設備設置配咗「桌面 Companion URL」（loopback 127.0.0.1:9311）→ 中招 A（字節錯）。
   - 用 Android 裝置 + PosNative APK 打印 → 中招 B（直接 ignore）。
4. **快測**：Companion 路徑將「大」同「中」兩個區塊分別打單，紙上如果一模一樣 → 確證 A。Android 路徑將「大」區塊打單，紙上同「細」一樣大 → 確證 B。

## 6. 修復清單（待 confirm 先落碼）

| # | Repo / 檔案 | 改動 | 重建 |
|---|-------------|------|------|
| 1 | `desktop-companion/companion-server.mjs:222` | `SIZE_BYTE.l` `0x60 → 0x30`（＋可 `m: 0x10` 雙高） | rebuild exe，**要講新版本號** |
| 2 | `print-agent-android/.../EscPosRenderer.kt` | 讀 `job.template` 快照、按 size/bold/align 發 ESC 字節（同源 Companion） | rebuild APK（P7） |
| 3 | `src/lib/escpos-render.ts:47` | `SIZE_PX` `l:18 → 22`（預覽更貼近紙面） | web 重 build + push |

優先級：① 先修 Companion（一行，影響桌面打印最大宗）；② 再修 Android（Renderer 重做，影響移動端）；③ 預覽微調（可同 ① 一齊）。

## 7. 實施狀態

- **#1 Companion 已落碼（2026-08-26）**：`companion-server.mjs:227` `SIZE_BYTE = { s:0x00, m:0x20, l:0x30 }`；同時修正錯嘅 bit5/bit6 註解。語意：s=正常 / m=雙寬(2x1) / l=雙高雙寬(2x2)。**待用家 rebuild exe 並講新版本號**（依規約）方可生效。
- **#2 Android 已落碼（2026-08-26）**：
  - `PrintDtos.kt`：`PrintJobDto` 加 `content: Map<String,String>?` + `template: TemplateDto?`（嵌套 `Block`/`TemplateDto` data class，`fromJson` 解析 `template.blocks` 嘅 size/bold/align/subSize/layout 同 `content`）。
  - `EscPosRenderer.kt`：加 `SIZE_BYTE`（同源 Companion）、`Buf.style/align/reset`、新 `renderTemplateTicket(job, printer)` 模板驅動渲染（同 Companion `renderEscPos` + web `renderEscPosLines` 同源算法），消費 `job.template` 快照真正套用字型設定（修復之前 ignore 字型）。
  - `MainActivity.kt`：`printJob` 改 `when` —— `job.template != null` 時優先 call `renderTemplateTicket`，否則 fallback 舊 receipt/kitchen/test 寫死 layout。
  - **沙盒無 Android SDK，未編譯；待用家 dev box `./gradlew assembleDebug` 確認**。APK 要 rebuild（P7）。
- **#3 web 預覽已落碼（2026-08-26）**：`escpos-render.ts:47` `SIZE_PX.l` `18 → 22`（l≈2× s，貼近紙面雙高雙寬）。`tsc --noEmit` 零新 error（僅 layout.tsx 已知誤報）。web 重 build + push 生效。
- 用家貼出 localStorage `printTemplates.kitchen.blocks` 確認 `size` 值正確持久化（store_name=m / items=m / 其餘=s），假設 ①「未保存」正式排除。

## 8. 驗證清單（用家 rebuild 後）

- [ ] Companion exe 重 build + 講新版本號 → 桌面打印「大」區塊變雙高雙寬（紙上同「中」明顯唔同）。
- [ ] Android APK 重 build → 模板設嘅 size/bold/align 喺 Android 出紙生效（之前完全 ignore）。
- [ ] web 預覽「大」字型約 2×「細」，貼近實紙（設計＝預覽＝實紙 三者一致）。
