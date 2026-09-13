# 144 · 標籤機設置獨立化 + 國內品牌補齊

> **日期**：2026-09-13
> **觸發**：商家截圖指出「設置標籤機時，裡面選項全部顯示為廚房打印機嘅選項」，
> 並要求「以支持國內為主」補齊大陸主流品牌，最後要出介面設計圖。
> **狀態**：程式碼已改（`tsc` 零錯、ESLint 零錯、9 + 5 項斷言通過）；**未上機驗**。

---

## 1. 三個根因（商家截圖見到嘅現象）

### R1 · 型號清單完全唔理角色 ⚠️ 主因

`printer-wizard-modal.tsx` 舊碼：

```ts
const lanModels = getLanModelOptions();   // ← 冇參數
```

而 `getLanModelOptions()` 嘅實作係**把 `USB_PRINTER_DB` 整份扁平移平**。於是
「標籤機」同「廚房機」拿到**完全相同**嘅清單 —— 商家揀標籤機時見到
Epson TM-T88V / 商頌 POS-80 / 芯燁 XP-Q800 等**票據機**型號。

**為害**：揀完之後 `paperSize` 帶住 `80mm`（連續紙），配落 100×75mm 標籤卷
→ 出紙亂版、走紙唔準。

### R2 · 標籤機被當廚房機處理「分區」

`printer-wizard-modal.tsx:297`（舊）：

```ts
{state.role && state.role !== "receipt" && printZones.length > 1 ? (   // 「所屬分區」
```

`role !== "receipt"` 同時命中 `zone` **同** `label`。所以標籤機也被逼揀
「所屬分區」（廚房 / 水吧 / 甜品）。

**為何錯**：分區（zone）嘅語義係「邊個廚房出呢張單」。標籤機印嘅係
**零售價籤 / 餐飲杯貼**，同廚房分區毫無關係。標籤機真正要問嘅係
**標籤紙尺寸**（40×30 vs 100×75 決定排版闊度），而 wizard 從來冇問過。

同一個 bug 亦見於 `printer-card-v2.tsx:109`（打印機已加入之後嘅卡片）。

### R3 · 品牌以國外為主、標籤機型號庫近乎空

舊 `USB_PRINTER_DB` 17 個 VID 裡，標籤機只有 **Zebra ×2 / TSC ×1**。
**漢印 HPRT、得力 Deli、快麥 KuaiMai、啟銳 Qirui、立象 Argox、新北洋 SNBC
全部缺席** —— 而 `docs/124` §D7 早於 2026-09-12 已拍板：

> **標籤機品牌：國產比較多** → 型號庫要補齊國產（佳博／漢印／芯燁／得力／快麥／啟銳…）

---

## 2. 修正內容

### 2.1 新增 `PrinterFamily` 維度（`printer-models.ts`）

```ts
export type PrinterFamily = "receipt" | "label" | "portable";
```

**為何唔可以只用品牌判斷**：同一品牌出兩種機係常態 ——

| 品牌 | 票據機 | 標籤機 |
| --- | --- | --- |
| 佳博 Gprinter | GP-58MBIII / GP-U80300 | GP-3120TU / GP-2270T |
| 漢印 HPRT | TP805 / TP809 | SL42 / N41 / D45 |
| 得力 Deli | DL-801P / DL-380AS | DL-888 / DL-730C / DL-770D |
| 容大 Rongta | RP80 / RP58 | （RP410 係便攜票據） |

所以族要**三層解析**（`resolveFamily()`）：型號級 → 品牌級 → fallback `"receipt"`。

### 2.2 `getLanModelOptions(family)` 加參數 —— 修正核心

```ts
// 舊：無參數，回傳全部
export function getLanModelOptions(): LanModelOption[]

// 新：按族過濾
export function getLanModelOptions(family?: PrinterFamily): LanModelOption[]
```

wizard 呼叫處：

```ts
const lanModels = useMemo(
  () => getLanModelOptions(familyForRole(state.role)),
  [state.role],
);

export function familyForRole(role): PrinterFamily {
  return role === "label" ? "label" : "receipt";   // zone 同 receipt 都係票據機
}
```

**效果**：票據機 31 個型號 / 標籤機 21 個型號，**零重疊**。

### 2.3 標籤機專屬設定區（Step 3）

| 設定 | 選項 | 為何要 |
| --- | --- | --- |
| **標籤紙尺寸** | 40×30 / 50×30 / 60×40 / 70×50 / 100×75 / 62mm（舊） | 決定排版闊度；同一部機可換卷 |
| **指令集** | TSPL / ZPL / ESC/POS / EPL / CPCL | 🔴 國內標籤機行 **TSPL**，唔食 ESC/POS |

指令集由品牌**自動建議**（`suggestLabelCommandSet()`）：
斑馬 → ZPL；立象 → EPL；其餘國產 → TSPL。

> ⚠️ 選咗非 TSPL 且非 ZPL 時，UI 會出黃色警告提醒
> 「國內標籤機絕大多數行 TSPL，揀錯會出白紙或亂碼」。

### 2.4 分區只屬於廚房機

```ts
// wizard Step 1
{state.role === "zone" && printZones.length > 1 ? ( /* 所屬分區 */ ) : null}

// printer-card-v2
{isZone ? ( /* 打印分區下拉 */ ) : null}
{isLabel ? ( /* 標籤紙尺寸下拉 */ ) : null}
```

同時 `complete()` 嘅 `zoneId` 由

```ts
zoneId: state.role !== "receipt" ? (...) : undefined,     // 舊：標籤機都被塞 zoneId
zoneId: state.role === "zone" ? (...) : undefined,        // 新：只有廚房機
```

### 2.5 品牌庫補齊（POS 側 + Companion 側同步）

**新增 VID（7 個）**：

| VID | 品牌 | 族 | 型號 |
| --- | --- | --- | --- |
| `0x28E9` | 佳博 Gprinter | label | GP-3120TU、GP-2270T |
| `0x0DD4` | 新北洋 SNBC | receipt | BTP-2002NP、BTP-R580 |
| `0x2A17` | **漢印 HPRT** | label + receipt | SL42、N41、D45 ／ TP805、TP809、HM-A300 |
| `0x28E0` | **得力 Deli** | label + receipt | DL-888、DL-730C、DL-770D ／ DL-801P、DL-380AS |
| `0x2E8A` | **快麥 KuaiMai** | label + receipt | K30、L31 ／ K388 |
| `0x1A86` | **啟銳 Qirui** | label | QR-386A、QR-668 |
| `0x0B36` | **立象 Argox** | label | CP-2140、OS-2140 |
| `0x6868` | 商頌 | receipt | POS-80、POS-58 |

**既有品牌補型號**：芯燁 +XP-N160II / XP-58IIH；容大 +RP410（便攜）；
Zebra +alsoKnownAs；TSC +TE200/TE300。

**品牌名統一中文 + 英文**（`Xprinter` → `芯燁 Xprinter`）——
商家喺機身標籤見到嘅係中文，英文只作技術對照。

**總計**：21 VID / 50 型號（舊 17 VID / 27 型號）。

### 2.6 新增 `alsoKnownAs`

同一部機多個 PID（韌體 / 介面 / OEM 貼牌）好常見。加 `alsoKnownAs` 令 UI
可以顯示「漢印 SL42（同系列：SL42S / SL42 Pro）」，商家買到第二個 PID 都認得出。

### 2.7 `PaperSizeValue` 擴充

```ts
export type PaperSizeValue =
  | "58mm" | "80mm" | "62mm"
  | "40x30mm" | "50x30mm" | "60x40mm" | "70x50mm" | "100x75mm";
```

原本只有 4 個值，標籤機型號填唔到 40×30 等尺寸。新增 4 個同
`LABEL_PAPER_PRESETS` 口徑對齊。

### 2.8 Companion 側同步（跨 repo 紅線）

`desktop-companion/companion-server.mjs` 嘅 `USB_PRINTER_DB` 係**第二份硬編表**，
必須同步（否則「網站認到嘅機」≠「Companion 認到嘅機」）：

- 補齊同樣 21 VID / 50 型號
- 加 `defaultFamily` ＋ 逐型號 `family`
- 加 `resolveFamily()`（同 POS 側同一口徑）
- `resolveUsbMeta()` 回傳加 `family`
- `enumerateUsbPrinters()` 回傳加 `family` → POS 側 `/api/usb` 路徑都用得着

POS 側 `PrinterCandidate` 加選填 `family`，USB 自動偵測路徑優先信 Companion 嘅判斷
（`candidate.family ?? (labelish ? "label" : "receipt")`）。

---

## 3. 未做 / 待辦

### 3.1 `labelCommandSet` 未落 config（刻意）

`DevicePrinterConfig` 目前**冇** `labelCommandSet` 欄位。UI 已收集商家選擇，
但 `complete()` 冇寫入（只寫 `paperSize`）。

**為何唔即刻加**：指令集要下游四個 renderer（POS 網頁 / Companion /
Android / print hub）都認得先有意義。而**四個 renderer 目前全部只出 ESC/POS**
—— 即係就算 config 帶住 `"tspl"`，實際 byte stream 一樣係 ESC/POS。
加咗欄位但唔改 renderer = 「UI 顯示 TSPL、實際出 ESC/POS」嘅**假同步**，
比唔加更危險。

**Phase 2 要連埋做**：
1. `DevicePrinterConfig` 加 `labelCommandSet?: LabelCommandSet`
2. 加 `normalizePosLocalSettings()` 白名單（見 docs/113 同類坑）
3. 寫 TSPL 渲染器（`TSPL\nSIZE w,h\nGAP ...\nCLS\nTEXT ...\nPRINT ...`）
4. Companion / Android 各自加分支
5. 三端 `versionCode` / `package.json` version 要擰

### 3.2 實機未驗 ⚠️

- **XP-235B**（商家手上標籤機）：通常係 **TSPL/ESC-Label** 指令集，
  **未必食 ESC/POS**。要實機驗：先用 TSPL 打自檢頁，確認指令集。
- **A-8016**（廚房機）：80mm ESC/POS，理應直接可用。
- 新款國產機嘅 VID 未實機確認過，第一次接上時要對照 Companion 枚舉結果。

### 3.3 已知未覆蓋品牌

以下品牌冇實機確認過 VID，**刻意留空**（寧可唔自動配對，都唔可以寫錯 VID）：

漢印（部分型號）／快麥（部分型號）／啟銳（部分型號）／立象（部分型號）／
漢印便攜系／得力便攜系。商家買到屬於呢批嘅機，UI 仍可經
「通用標籤機」兜底 + 手動選紙張尺寸。

---

## 4. 驗證

### 4.1 已跑（全過）

| 測試 | 命令 | 結果 |
| --- | --- | --- |
| TypeScript | `node node_modules/typescript/bin/tsc --noEmit` | **0 errors** |
| ESLint（3 個改動檔） | `node node_modules/eslint/bin/eslint.js <3 files>` | **0 problems** |
| 型號分流 | `node --experimental-strip-types tools/verify-label-model-split.cjs` | **9 / 9** |
| 兩表同步 | `node tools/verify-printer-db-parity.cjs` | **5 / 5** |
| Companion e2e | `cd C:/dev/desktop-companion && node test-print-e2e.mjs` | **8 / 8** |
| 跨 repo 硬編字串 | `cd C:/dev/desktop-companion && node test-crossrepo-parity.mjs` | **0 問題** |

### 4.2 新增測試腳本

**`tools/verify-label-model-split.cjs`** —— 驗證型號分流：

1. 票據機 / 標籤機清單零重疊
2. 標籤機清單冇票據機型號（regex 掃 TM-T88 / POS-80 / XP-Q800…）
3. 票據機清單冇標籤機型號（regex 掃 ZD410 / TTP-244 / SL42…）
4. 標籤機清單含全部國內品牌
5. 標籤機唔會誤用 58/80mm 連續紙
6. `familyForRole()` 對應正確
7. `resolveUsbMeta()` 族推斷正確（漢印同品牌兩種族都認得）
8. `alsoKnownAs` 有值
9. `suggestLabelCommandSet()` 正確

**`tools/verify-printer-db-parity.cjs`** —— 驗證兩份表同步：

做法唔用 regex 硬拆（太脆），而係把 object literal 切出嚟
用 `new Function` 求值成真 JS object，再逐欄比對。

1. VID 集合完全一致
2. 品牌一致
3. `defaultFamily` 一致
4. PID 集合一致
5. 逐型號 `family` 一致
6. 標籤機品牌兩邊都係 `label`
7. 標籤機型號唔用連續紙尺寸

---

## 5. 改動檔案

| 檔案 | 改動 |
| --- | --- |
| `src/lib/print-bridge/printer-models.ts` | ＋`PrinterFamily`、`resolveFamily`、`familyForRole`；`getLanModelOptions(family)`；＋7 VID / 23 型號；＋`alsoKnownAs`；＋`LABEL_MODEL_PAPER_SIZES`、`LABEL_COMMAND_SETS`、`suggestLabelCommandSet`；`PaperSizeValue` 擴充；`ResolvedUsbMeta` 加 `family` / `alsoKnownAs` |
| `src/components/printer-wizard-modal.tsx` | `lanModels` 按角色過濾（`useMemo`）；分區只給 `zone`；＋標籤機專屬 Step 3 設定區；`selectRole` 切換時清空 model；`complete()` 嘅 `zoneId` 只給 `zone`；`paperSize` 標籤機用商家選嘅值；USB 分支信 Companion `family`；標題動態（「添加標籤機」） |
| `src/components/printer-card-v2.tsx` | 分區只給 `zone`；＋標籤機紙張尺寸下拉 ＋ 紙張/指令集顯示；＋ `TSPL` 徽章；測試打印按鈕文案分標籤機 |
| `src/lib/print-bridge/companion.ts` | `PrinterCandidate` ＋`family`；`UsbPrinterRow` ＋`family`；兩處映射帶 `family` |
| `C:/dev/desktop-companion/companion-server.mjs` | `USB_PRINTER_DB` 同步 21 VID / 50 型號；＋`resolveFamily()`；`resolveUsbMeta()` ＋`family`；`enumerateUsbPrinters()` ＋`family` |
| `tools/verify-label-model-split.cjs` | 新增 |
| `tools/verify-printer-db-parity.cjs` | 新增 |

---

## 6. 教訓（可複用）

1. **「同一份清單餵兩個角色」係結構性 bug** —— 過濾參數唔係 optional 嘅時候，
   就唔應該畀 default。`getLanModelOptions()` 最初冇參數 = 引誘人唔傳。
2. **`role !== "receipt"` 係危險的否定式** —— 加第三個角色（`label`）之後，
   呢個表達式靜靜地擴大了命中範圍。要用**肯定式列舉**（`role === "zone"`）。
3. **硬件族要三層解析**（型號 → 品牌 → fallback）—— 品牌層唔夠，因為
   佳博 / 漢印 / 得力 / 容大 都同時出兩種機。
4. **跨 repo 硬編表一定要有自動化一致性測試** —— 兩份表改一邊唔會 throw，
   只會令商家見到唔一致嘅型號名。`verify-printer-db-parity.cjs` 就係防線。
5. **UI 收集咗設定但下游唔認 = 假同步，比唔加更危險** —— 所以 `labelCommandSet`
   刻意唔寫入 config，等 renderer 改好先一齊上。
