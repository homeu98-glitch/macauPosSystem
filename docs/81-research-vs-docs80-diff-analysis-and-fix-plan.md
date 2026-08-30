# 81 · 第三方研究 vs docs/80 差異分析 + 修正計劃

> **觸發**：用家提供第三方多模型研究文檔（`SUMMARY.md` + `round-research-preview-vs-paper.md`，
> 蓋章 GPT-4.6 Luna-Max APPROVE_WITH_CONDITIONS），要求對比 docs/80 結論、找差異、說原因、出計劃。
> ~~**約束**：先出計劃，唔好郁手做。~~ → **用家 2026-08-30 批准，已執行。**

---

## §1 · 差異總覽（research vs docs/80）

| # | 維度 | docs/80 結論 | 第三方研究結論 | 誰對 |
|---|------|-------------|--------------|------|
| **D1** | **出問題嘅列印通道** | B1（APK 丟 template）係「揀大出細」主因；APK 係主力甚至唯一通道 | Windows Desktop Companion → USB RAW ESC/POS → POS-80 先係出事嗰張紙；APK 唔關事 | **研究對**（裝置管理員截圖證實 Windows USB） |
| **D2** | **現場實際字節** | §4.2 範例寫 `ESC! 0x60` + `GS! 0x11` | 實際 Companion source 係 `ESC! 0x30` + `GS! 0x30`（`SIZE_BYTE.l=0x30`、`KANJI_SIZE_BYTE.l=0x30`） | **研究對**（直接讀咗 `companion-server.mjs` source） |
| **D3** | **GS! 參數語意** | 用標準 Epson nibble 語意示範（`0x11` = 2×2） | 指出 source 用 `0x30` 塞入 `GS!` 係 **ESC bit 語意誤用**；標準 `GS!` 2×2 應係 `0x11`，`0x30` 喺真 Epson 語意 = 寬×4 高×1 | **研究更深入**（H3 假設，需 A/B 驗證但邏輯正確） |
| **D4** | **B1 相關性** | B1 係「設定無效」唯一主因，擺喺 §1 表第一行 | B1 對呢張 Windows 紙 **完全唔相干**（「不要把 docs/80 的 B1 套到這張 Windows 紙」） | **研究對**（B1 只影響 APK 通道，Windows 通道唔經 native.ts） |
| **D5** | **三份文件一致性** | docs/80 §4.2 範例 `0x60`/`0x11` vs docs/70 已改 `l=0x30` vs docs/71 實機鎖定 `GS!0x30` —— **互相打架** | 明確指出呢個矛盾，要求「以 dump 為準」統一真相表 | **研究對**（docs/80 範例確實同 source 唔脗合） |
| **D6** | **主因鏈順序** | B1（template drop）> B2（相乘）> B3（行距） | 相乘（H1）> 行距（H2，相乘嘅放大器）> GS nibble（H3）> 觸發（H9，桌台/時間設 l） | **研究更準確**（B1 唔喺呢條路就唔排第一） |
| **D7** | **預覽 vs 出紙本質** | 暫未深入探討 | H4 明確指出：CSS 相對行高 + 抗鋸齒 vs ESC/POS 點陣固定行距，預覽永遠「好看一檔」，唔能用預覽保證紙面 | **研究更全面**（架構落差唔係 bug 但解釋落差） |

---

## §2 · 造成差異嘅可能原因

### 2.1 docs/80 寫嗰陣冇 access 到 Companion source

docs/80 嘅調查起點係 **web repo**（`macauPosSystem`）。`companion-server.mjs` 喺 **另一個 repo**（`C:\dev\desktop-companion\`）。

- B1 嘅發現過程：由 print-center UI → localStorage → `native.ts` → 發現 payload 丟 template → 確認 APK 通道冇快照。
- 但用家張紙係 **Windows 瀏覽器開 Vercel POS → Companion** 嘅路。呢條路 `dispatch.ts` 行嘅係 Companion 分支（`localhost:9311`），**唔經 `native.ts`** → B1 嘅 payload 丟失根本冇發生。
- docs/80 將 B1 擺第一，係因為調查時跟住 `native.ts` 條路走，冇跳返去睇 Companion 條路嘅 source。

### 2.2 docs/80 範例字節係理論值，唔係 source 實際值

- docs/80 §4.2 寫 `ESC! 0x60` + `GS! 0x11`：`0x60` 係 **docs/55 舊值**（docs/70 已改 `0x30` 但 docs/80 範例未同步更新）；`0x11` 係 **標準 Epson `GS!` nibble**（理論正確但 source 冇用）。
- 實際 source（`companion-server.mjs:244,248`）：`SIZE_BYTE.l = 0x30`、`KANJI_SIZE_BYTE.l = 0x30` —— 兩個都係 `0x30`。
- 即係 docs/80 嘅範例係「我覺得應該係呢組字節」，唔係「source 真係發呢組」。研究直接讀 source 先發現呢個落差。

### 2.3 docs/71 V5「PASS」嘅校準不足

- docs/71 §11 V5 = `FS& + GS!0x30` 報 PASS；V6 = `FS& + GS!0x03` 都報 PASS。
- 但 V5 用 `0x30`（ESC bit 語意）、V6 用 `0x03`（標準 nibble 語意 = 寬×1 高×4）—— 兩個值嘅倍率語意完全唔同，卻都「PASS」。
- 說明 V5/V6 嘅校準只睇咗「中文有冇變大」，冇量測字元格子數 → 冇區分到 `0x30` 同 `0x11` 嘅差別。
- 研究嘅 H3 正正指出呢個盲點。

### 2.4 docs/80 B2 方向正確但落地唔準

- B2 嘅核心判斷——「`ESC!` 同 `GS!` 同時發會相乘」——係 **正確嘅**，研究 H1 都確認。
- 但 docs/80 將 B2 標為「APK 側要改（§4.2）」，而實際 source 嘅 Companion 通道都有同樣嘅雙發問題（`setStyle` 發 `ESC!`，`textLine` 喺 CJK 行再發 `GS!`）。
- 研究 P0 明確指出要改嘅係 `companion-server.mjs` 嘅 `setStyle`/`textLine`，唔係得 APK。

---

## §3 · 修正計劃（分 P0–P3，按優先序）

> **核心原則**（研究 §6 挑戰）：先消相乘，再調 `ESC 3`；順序顛倒會把 `ESC 3` 調到魔術數，掩蓋根因。

### P0-A · 互斥放大（解相乘主因）

**落點**：`C:\dev\desktop-companion\companion-server.mjs` — `setStyle()` + `textLine()`

**現狀**（source 確認）：
```
setStyle(size, bold)     → emit ESC ! SIZE_BYTE[size]    （管 ASCII）
textLine(text, ...)      → if hasCJK: emit GS ! KANJI_SIZE_BYTE[size]  （管 ASCII + Kanji）
                           ↑ 兩者喺 CJK 行同時發 → 相乘
```

**目標**：按 `kanjiEnlarge` 設定二選一：

| `kanjiEnlarge` | setStyle 行為 | textLine CJK 行為 |
|----------------|-------------|-----------------|
| `"GS!"`（商頌 POS-80，預設） | `ESC ! 0x00`（淨保留粗體 bit） | `GS ! n`（唯一放大來源） |
| `"FS!"`（標準 ESC/POS 機） | `ESC ! SIZE_BYTE[size]` | `FS ! FS_SIZE_BYTE[size]`（補充中文） |

**實作手法**：`setStyle` 收一個 flag（或 `textLine` 先判 `kanjiEnlarge` 決定 `ESC!` 係咪帶放大 bit），確保同一行唔同時出 `ESC!` 放大 + `GS!` 放大。

### P0-B · `GS_SIZE_BYTE` 改標準 nibble（解 H3）

**落點**：同上 + `test-kanji-size.mjs`

**現狀**：`KANJI_SIZE_BYTE = { s:0x00, m:0x20, l:0x30 }` — 用 ESC bit 語意塞入 `GS!`

**目標**（待 A/B 驗證確認）：`GS_SIZE_BYTE = { s:0x00, m:0x01, l:0x11 }` — 標準 Epson nibble `n=(w-1)<<4|(h-1)`

**⚠️ 唔可以盲改**：`0x30` 喺商頌 POS-80 可能啱用（韌體差異）。要先做 §4 嘅 A/B test：
- 若 `GS!0x11` 印出真 2×2 → 改用 `0x11`（標準）
- 若 `GS!0x11` 印出 1×1 或亂碼 → 韌體食 ESC bit 語意，保留 `0x30` 但喺註解寫死「呢部機非標準」

### P1-A · 行距跟實際縱向倍率同步

**落點**：同上 `setStyle` 內 `ESC 3 n`

**現狀**：`ESC 3` 按名義 size 設（s/m=30, l=60），但相乘修好前 ASCII 係 4× → 60 唔夠

**目標**：P0-A 修好後，放大只剩一個來源（2×），`ESC 3 60` 應該夠用。若仍微微重疊 → `lineSpacing.l` 微調 64–66。

**順序約束**：唔可以喺 P0-A 未完成前單獨修行距——會把 `ESC 3` 調到 120 掩蓋根因。

### P1-B · `reset()` 強制清除殘留

**落點**：Companion `renderEscPos` 結尾 + APK `EscPosRenderer` 結尾

**目標**：每次單據完 emit `GS ! 0x00` + `ESC ! 0x00` + `ESC 3 30`，防止放大狀態洩漏到下一張。

### P2 · Web 預覽危險提示

**落點**：`src/components/print-center/` template editor

**目標**：區塊含大量 ASCII（桌台號、日期時間）且 size=l 時，UI 顯示警告：
> 「⚠️ 熱敏大字為點陣放大，無抗鋸齒；純英文/數字喺大字下會出現明顯鋸齒同強制換行。建議桌台/時間保持細或中。」

### P3 · docs/80 修訂 + 統一真相表

**落點**：`docs/80` 本體 + 可能新建 `docs/82-esc-byte-truth-table.md`

**目標**：
1. docs/80 §1 表：B1 標註「僅影響 APK 通道；Windows Companion 通道唔適用」
2. docs/80 §4.2：範例字節由 `0x60`/`0x11` 改為 source 實際值 `0x30`/`0x30`，並標註「待 A/B 驗證後決定 GS! 正確值」
3. 新建「現行字節真相表」統一 docs/70（`SIZE_BYTE.l=0x30`）、docs/71（`GS!0x30` 實機）、docs/80（範例），消除三份文件打架
4. 加 rebuild 版號欄（source 改完 ≠ exe 生效）

---

## §4 · 驗證計劃（A/B test，研究 §5）

### Step 1：確認通道 + 版號
- `GET http://127.0.0.1:9311/api/health` → 記 version / hash
- 確認 POS 喺 Windows 瀏覽器開（唔係 Android WebView）

### Step 2：Dump 模板快照
- 瀏覽器 Console 讀 `localStorage` 廚房模板 `table_name.size`、`time.size`
- 預期：桌台/時間 = `l`（觸發條件 H9）；若已是 `s` 仍爆 → 狀態殘留問題

### Step 3：A/B（最關鍵）
- 臨時包 A：`kanjiEnlarge=GS!` 路徑 **只留 `GS!`，setStyle 唔帶 `ESC!` 放大 bit**
- 臨時包 B：反向——只留 `ESC!`+`FS!`，關掉 `GS!`
- 印同一張「桌台=A03、時間=now、皆 l」測試單
- **若 ASCII 從「巨怪」變回正常 2×** → H1（相乘）坐實

### Step 4：純 ASCII vs 純中文對照頁
- 行 1：`AAAA` size l
- 行 2：`中文測試` size l
- 行 3：`2026-08-27 22:35` size l
- 量測：ASCII 字高 ≈ 中文兩倍 → 相乘簽名

### Step 5：`GS!` 參數校正
- V-A：`GS!0x11` only（標準 nibble）
- V-B：`GS!0x30` only（現狀 ESC bit 語意）
- V-C：`ESC!0x30` only
- V-D：`ESC!0x30` + `GS!0x30`（重現現況）
- 量測字元格子數，唔好再靠「看起來有變大」就 PASS

### Step 6（可選）：Hex dump
- Companion 寫入印表機前 hex log 抓一行 `table_name`/`time`
- 搜 `1B 21` 同 `1D 21` 係咪同現 → 直接坐實雙發

---

## §5 · 部署（source 改完 ≠ 生效）

| 端 | 動作 | 版本號 |
|----|------|--------|
| Companion | `npm run dist` 重新打包 exe（P0-A + P0-B + P1） | ⬜ 待報 |
| Web（本 repo） | P2 預覽警告 UI + push Vercel | — |
| Android APK | 同樣嘅互斥放大邏輯 + `GS_SIZE_BYTE`（分開做，唔阻塞 Companion） | ⬜ 待報 |

> 用家規約：每次更新 Companion / APK 要主動報版本號。

---

## §6 · 執行順序

```
Step 1-2（確認 + dump）          ← 用家做，唔使改碼
        ↓
Step 3（A/B 臨時包）              ← 我改 Companion source 做臨時包，用家印紙
        ↓
Step 4-5（對照頁 + 參數校正）      ← 用家印紙 + 量測
        ↓
P0-A + P0-B（正式修）            ← 確認 A/B 結果後我再改
        ↓
P1-A + P1-B（行距 + reset）       ← P0 驗收後
        ↓
npm run dist + 報版號             ← 用家打包
        ↓
真紙驗收                          ← 12 個 A / 純中文 / 日期 / 規格表
        ↓
P2 + P3（預覽警告 + docs 修訂）   ← 最後
```

---

## §7 · 我嘅判斷

研究文檔嘅核心結論係 **正確嘅**：

1. **出事嗰條路係 Windows Companion → USB RAW**，唔係 APK。docs/80 嘅 B1 framing 喺呢張紙唔適用。
2. **`ESC!` × `GS!` 相乘係主因**（B2 方向對），但 docs/80 範例字節同 source 唔脗合，要修正。
3. **`GS!0x30` 係可疑嘅**（H3），但唔可以盲改，要 A/B 驗證。
4. **`ESC 3` 唔可以先行**——會掩蓋根因。

docs/80 嘅 B2 理論判斷冇錯，但 **落地位置錯咗**（應該改 Companion source，唔係得 APK），而且 **範例字節唔係 source 真實值**。

**下一步**：等用家確認呢個計劃，我先改 Companion source 做 A/B 臨時包。

---

## §8 · 執行結果（2026-08-30 ✅）

用家批准計劃後，P0-A / P0-B / P1-B 已全部落碼於 Companion source。

### 8.1 已改檔案

| 檔案 | 改動 |
|------|------|
| `C:\dev\desktop-companion\companion-server.mjs` | P0-A 互斥放大 + P0-B GS_SIZE_BYTE + P1-B resetMagnify |
| `C:\dev\desktop-companion\test-kanji-size.mjs` | A/B 診斷重寫（V-A/V-B/V-C/V-D + R-1~R-4 對照行） |
| `C:\dev\desktop-companion\package.json` | 版號 `0.1.14` → `0.1.15` |

### 8.2 P0-A 互斥放大（companion-server.mjs setStyle/textLine）

**核心邏輯**：

| `kanjiEnlarge` | setStyle（CJK 行） | textLine CJK 行 | 純 ASCII 行 |
|----------------|-------------------|----------------|------------|
| `"GS!"`（預設） | `ESC!0x00`（唔帶放大，避免相乘） | `GS!GS_SIZE_BYTE[size]`（唯一放大） | `ESC!SIZE_BYTE[size]`（正常放大） |
| `"FS!"` | `ESC!SIZE_BYTE[size]`（管 ASCII） | `FS!FS_SIZE_BYTE[size]`（管中文，唔相乘） | `ESC!SIZE_BYTE[size]`（正常放大） |

`setStyle` 新增第三參數 `isCjkLine`：GS! 路線下 CJK 行 `ESC!` 降為 `0x00`，非 CJK 行照常放大。

### 8.3 P0-B 字節表（companion-server.mjs 常數區）

| 常數 | 用途 | s | m | l | 語意 |
|------|------|---|---|---|------|
| `SIZE_BYTE` | `ESC!`（ASCII） | 0x00 | 0x20 | 0x30 | bit: 0x20=闊 0x10=高 |
| `GS_SIZE_BYTE` | `GS!`（ASCII+Kanji，新） | 0x00 | 0x01 | 0x11 | nibble: (h-1)<<4\|(w-1) |
| `FS_SIZE_BYTE` | `FS!`（Kanji，FS! 路線） | 0x00 | 0x04 | 0x0C | bit: 0x04=闊 0x08=高 |
| `KANJI_SIZE_BYTE_LEGACY` | `GS!` 舊值 fallback | 0x00 | 0x20 | 0x30 | ESC bit 語意（非標準） |

> `printer.gsNibble = false` → GS! 走舊 `0x30`（俾非標準韌體 fallback）。預設 `true` = 標準 nibble `0x11`。

### 8.4 P1-B resetMagnify（companion-server.mjs）

模板路徑結尾 + 舊 fallback 路徑結尾都加咗 `resetMagnify()`：
```
GS ! 0x00  — 清 GS! 放大
ESC ! 0x00 — 清 ESC! 放大
ESC 3 30   — 還原行距
```

### 8.5 A/B 診斷（test-kanji-size.mjs v2）

舊版 V1-V6 每行都帶 `ESC!0x30` + `GS!/FS!`（冇分離 → 冇校準 nibble）。
新版 4 個 A/B 變體各自獨立：

| 變體 | 發出 | 預期結果 | 判定 |
|------|------|---------|------|
| V-A | 只 `GS!0x11`（標準 nibble） | ASCII=2×, 中文=2× | ✅ 相乘修好 + nibble 啱 |
| V-B | 只 `GS!0x30`（舊 ESC bit） | ASCII=4× or 1×（視韌體） | 判定 0x30 語意 |
| V-C | 只 `ESC!0x30`（管 ASCII） | ASCII=2×, 中文唔變大 | ESC! 只管 ASCII |
| V-D | `ESC!0x30` + `GS!0x30`（重現舊 bug） | ASCII=4×4 | 重現相乘 |

對照行：R-1（12×A）、R-2（純中文）、R-3（日期時間）、R-4（規格兩行重疊測試）

### 8.6 驗證

- `node --check companion-server.mjs` → ✅ 0 error
- `node --check test-kanji-size.mjs` → ✅ 0 error

### 8.7 待用家做

1. **`npm run dist`** 打包 Companion 0.1.15 exe → 報版號
2. **印 A/B 測試紙**：`node test-kanji-size.mjs <printer-ip>:9100`
3. **對照 V-A vs V-D**：若 V-A ASCII 正常 2×、V-D ASCII 巨怪 4×4 → 相乘 bug 坐實 + 修正確認
4. **若 V-A 中文唔變大**：設 `printer.gsNibble=false` 走舊 `0x30`（韌體非標準）
5. **真紙驗收**：廚房單桌台=「A03」、時間=now、皆 size=l → 中英文放大倍率一致、唔重疊、唔爆行

> APK 側同樣邏輯（互斥放大 + GS_SIZE_BYTE）另案，唔阻塞 Companion 驗收。

---

## §9 · A/B 實機結果 + post-fix 確認（2026-08-30 22:30 ✅）

### 9.1 A/B 結果

| 變體 | 發出 | 用家結果 | 含義 |
|------|------|---------|------|
| V-A | 只 `GS!0x11`（標準 nibble） | ✅ **PASS** | POS-80 食標準 Epson nibble `0x11`，ASCII+中文都 2× |
| V-B | 只 `GS!0x30`（舊 ESC bit） | ❌ **FAIL** | `0x30` 喺 nibble 語意 = 寬×4 高×1（唔係 2×2） |
| V-C | 只 `ESC!0x30`（管 ASCII） | ✅ **PASS** | `ESC!0x30` = ASCII 2×2，中文唔變大（預期） |
| V-D | `ESC!0x30` + `GS!0x30` | ❌ **FAIL**（同 V-B） | 相乘 + `0x30` 語意錯 |

### 9.2 V-B 與 V-D 失敗嘅共通原因

**兩者都用咗 `GS!0x30`。**

V-A 用 `GS!0x11` 成功 → POS-80 **食標準 Epson nibble 語意**，唔係「非標準韌體食 ESC bit」。
喺標準 nibble 下 `0x30 = ((1)<<4)|(3)` = 寬×4 高×1，根本唔係 2×2。
V-D 同 V-B 一樣失敗，因為 `0x30` 本身已經錯，加上相乘只會更差。

**結論**：`KANJI_SIZE_BYTE_LEGACY` 嘅 `0x30` 唔係「韌體偏好」而係 **純粹寫錯**（docs/71 V5 遺留）。
`gsNibble=false` fallback 唔需要保留——`0x11` 係所有 Epson/Gprinter 系嘅正確值。

### 9.3 Post-fix 改動（Companion 0.1.16）

| 改動 | 檔案 |
|------|------|
| 移除 `KANJI_SIZE_BYTE_LEGACY` 常數 + `gsNibble` flag | `companion-server.mjs` |
| `gsByte()` 簡化為 `GS_SIZE_BYTE[size] \|\| 0x00`（永遠 0x11） | `companion-server.mjs` |
| `test-kanji-size.mjs` v3：F-1~F-5 確認測試 + R-1~R-4 對照 | `test-kanji-size.mjs` |
| 版號 `0.1.15` → `0.1.16` | `package.json` |

### 9.4 確認測試設計（test-kanji-size.mjs v3）

| 變體 | 發出 | 預期 | 目的 |
|------|------|------|------|
| F-1 | 只 `GS!0x11` | PASS | 基準：標準 nibble 2×2 |
| F-2 | `GS!0x11` + `ESC!0x00` | **PASS** | **= renderEscPos 修正後 CJK 行嘅實際輸出** |
| F-3 | `GS!0x11` + `ESC!0x30` | FAIL | 證明互斥修正必要（唔做就會相乘 4×4） |
| F-4 | `GS!0x30` + `ESC!0x30` | FAIL | 舊 bug 完整重現（對照） |
| F-5 | 只 `ESC!0x30` | PASS | 純 ASCII 行正常路徑 |

**F-2 係最關鍵嘅確認**：佢模擬 `renderEscPos` 修正後對 CJK 行嘅實際輸出（`ESC!0x00` = 互斥不放大 + `GS!0x11` = 唯一放大來源）。若 F-2 PASS，即係正常列印路徑已經修好。

### 9.5 待用家做

1. **`npm run dist`** 打包 Companion **0.1.16** exe → 報版號
2. **印確認測試紙**：`node test-kanji-size.mjs <printer-ip>:9100`
3. **預期**：F-1 ✅、F-2 ✅、F-3 ❌（證明互斥必要）、F-4 ❌（舊 bug 對照）、F-5 ✅
4. **F-2 PASS = 修正生效**
5. **真紙驗收**：廚房單桌台=「A03」、時間=now、皆 size=l → 中英文 2× 一致、唔重疊、唔爆行
