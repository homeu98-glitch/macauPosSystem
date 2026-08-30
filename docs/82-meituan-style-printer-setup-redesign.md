# 82 · 美團式打印機設置重設方案

> **觸發**：用家提供 10 張美團打印機添加流程截圖，要求重新設計打印機設置功能，
> 取代現有所有設置方法，全部改為手動選擇、步驟引導，隱藏所有技術性設置。
> **約束**：先出方案，唔好郁手做。

---

## §1 · 現狀問題

現有打印機設置（`device-settings.tsx` L801-1060）係一個**扁平表單**：

- 所有欄位同時展現喺一張卡片度（名稱、用途、分區、連接方式、型號、紙寬、IP、端口、VID、PID、機型、USB 端口、藍牙名、charset、kanjiEnlarge、lineSpacing、打印張數…）
- 商家面對大量技術欄位：USB Vendor ID、USB Product ID、偵測到嘅機型（命令檔）、OS 打印端口、ESC/POS 跨碼（中文字集）、中文倍大指令（Kanji 命令檔）
- 冇步驟引導，冇鎖定機制，所有欄位可以隨時改
- 用家要求：**美團式步驟引導 + 選定後鎖定變灰 + 隱藏所有技術設置**

---

## §2 · 美團式三步流程設計

### 流程總覽

```
┌─────────────────────────────────────────────────────┐
│  第一步：選擇用途 + 連接方式                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐             │
│  │ 廚房機   │ │ 小票機   │ │ 標籤機   │             │
│  └──────────┘ └──────────┘ └──────────┘             │
│  ┌──────────┐ ┌──────────┐                           │
│  │ LAN 網線 │ │ USB      │                           │
│  └──────────┘ └──────────┘                           │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│  第二步：選擇打印機型號                               │
│  ┌─────────────────────────────────────────┐        │
│  │ ○ Epson TM-T88V                         │        │
│  │ ○ 商頌 POS-80                            │        │
│  │ ○ Xprinter XP-Q800                      │        │
│  │ ○ ...（按連接方式過濾）                   │        │
│  └─────────────────────────────────────────┘        │
│  ⚠️ 型號一經選定後不可更改，變灰鎖定                   │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│  第三步：完成連接                                     │
│                                                       │
│  【LAN】                【USB】                       │
│  輸入 IP 地址           自動偵測設備列表              │
│  192.168.1.110    →     ○ Printer POS-80 (USB)      │
│  [測試連接]              [選擇]                       │
│                                                       │
│  ✅ 連接成功            ✅ 連接成功                    │
│  （唔顯示進階設置）      （唔顯示進階設置）            │
│  ⚠️ 連接方式一經選定後不可更改                         │
└─────────────────────────────────────────────────────┘
```

### 第一步：用途 + 連接方式

**用途類型**（3 選 1，卡片式選擇）：

| 選項 | 映射 role | 說明 |
|------|-----------|------|
| 廚房機 | `zone` | 分區出單（廚房／飲品部 etc.） |
| 小票機 | `receipt` | 收銀台收據 |
| 標籤機 | `label` | 杯貼標籤 |

**連接方式**（2 選 1，卡片式選擇）：

| 選項 | 映射 connectionType | 說明 |
|------|---------------------|------|
| LAN（區網／網線） | `lan` | 有線網絡 |
| USB | `usb` | USB 直連 |

> 藍牙先移除——現有代碼有但用家冇提及，且美團流程冇藍牙。如需保留可加做，但默認隱藏。

**第一步選完後**，用途同連接方式寫入 wizard state，進入第二步。

### 第二步：選擇打印機型號

**型號列表來源**：`src/lib/print-bridge/printer-models.ts` 嘅 `USB_PRINTER_DB`，按連接方式過濾：

- **LAN**：列出所有已知品牌+型號（因為 LAN 唔做 VID/PID 偵測，商家憑機身標籤選）
- **USB**：調用 Companion `GET /api/usb` 嘅 `enumerateUsbPrinters()` 結果 → 列出偵測到嘅設備（品牌+型號+VID/PID）+ 通用「USB Printer Class 設備」選項

**選定後行為**：

| 連接方式 | 型號選定後自動填入 | 商家可見 |
|---------|-------------------|---------|
| LAN | `model`、`paperSize`、`charset`、`kanjiEnlarge`（從型號表預設） | 淨見型號名 |
| USB | `model`、`usbVendorId`、`usbProductId`、`paperSize`、`charset`、`kanjiEnlarge`、`usbPort`（從 Companion 偵測） | 淨見型號名 |

> ⚠️ **型號一經選定後不可更改，變灰鎖定**。要改型號 = 刪除呢部機重新添加。

### 第三步：完成連接

**LAN 路徑**：

```
┌─────────────────────────────────────┐
│  輸入打印機 IP 地址                  │
│  ┌─────────────────────────────────┐│
│  │ 192.168.1.110                   ││
│  └─────────────────────────────────┘│
│  [測試連接]                          │
│                                      │
│  → 測試：TCP socket 連 IP:9100      │
│  → 成功：「✅ 連接成功」             │
│  → 失敗：「❌ 連接失敗，請檢查 IP」   │
└─────────────────────────────────────┘
```

- 連接成功後 **唔顯示**：中文倍大指令、ESC/POS 跨碼等進階設置
- 連接方式（LAN）鎖定，變灰

**USB 路徑**：

```
┌─────────────────────────────────────┐
│  自動偵測到嘅設備：                  │
│                                      │
│  ○ Printer POS-80 (USB001)          │
│    商頌 · 通用 ESC/POS                │
│                                      │
│  ○ Epson TM-T88V (USB002)           │
│    Epson                              │
│                                      │
│  [重新掃描]                          │
└─────────────────────────────────────┘
```

- 選擇設備後 **唔顯示**：USB VID、PID、偵測到嘅機型、OS 打印端口、中文倍大指令、ESC/POS 跨碼
- 連接方式（USB）鎖定，變灰
- `usbPort` 由 Companion 自動填入（USB001 etc.）

---

## §3 · 鎖定機制設計

### 鎖定規則

| 欄位 | 鎖定時機 | 解鎖方式 |
|------|---------|---------|
| 用途（role） | 第一步選定後 | 刪除重新添加 |
| 連接方式（connectionType） | 第一步選定後 | 刪除重新添加 |
| 型號（model + VID/PID + 預設值） | 第二步選定後 | 刪除重新添加 |
| IP 地址（LAN） | **唔鎖定**——可改（IP 可能變） | — |
| USB 設備（USB） | 第三步選定後 | 刪除重新添加 |

> 設計原則：硬件身份（用途、連接方式、型號）鎖定；可變參數（IP）唔鎖定。

### UI 鎖定視覺

- 已選定嘅選項：灰底 + 唔可點擊 + 右上角 ✅ 標記
- 已選定嘅步驟：收起（只顯示一行摘要「廚房機 · LAN · 商頌 POS-80 · 192.168.1.110」）
- 唯一可改嘅：IP 地址（LAN）同啟用/禁用開關

---

## §4 · 已添加打印機列表（完成後）

完成 wizard 後，打印機出喺列表。每部機顯示：

```
┌──────────────────────────────────────────────────────┐
│ 🟢 廚房機 · 商頌 POS-80                                │
│ LAN · 192.168.1.110                  [啟用] [刪除]   │
│ ──────────────────────────────────────────────────── │
│ 用途：廚房機 🔒    連接：LAN 🔒    型號：POS-80 🔒   │
│ IP：192.168.1.110 [可改]                              │
└──────────────────────────────────────────────────────┘
```

- **唔顯示**：VID、PID、charset、kanjiEnlarge、lineSpacing、usbPort（全部由型號表自動帶入，對商家隱藏）
- 唯一可編輯：IP 地址（LAN）、啟用/禁用、刪除
- 廚房機/標籤機額外顯示：所屬分區（可改）

---

## §5 · 技術設置去哪了

所有「隱藏」嘅技術設置 **唔係刪除，而係自動帶入**：

| 技術欄位 | 值來源 | 商家可見 |
|---------|--------|---------|
| `charset` | 型號表預設（`USB_PRINTER_DB[vid].defaultCharset` / 型號級 `charset`） | ❌ 隱藏 |
| `kanjiEnlarge` | 型號表預設（`defaultKanjiEnlarge` / 型號級 `kanjiEnlarge`） | ❌ 隱藏 |
| `paperSize` | 型號表預設（`defaultPaperSize` / 型號級 `paperSize`） | ❌ 隱藏 |
| `usbVendorId` | Companion `enumerateUsbPrinters()` 偵測 | ❌ 隱藏 |
| `usbProductId` | Companion 偵測 | ❌ 隱藏 |
| `usbPort` | Companion 偵測（`USB001` etc.） | ❌ 隱藏 |
| `lineSpacing` | 預設（s/m=30, l=60）—— A/B 已確認 0x11 + 互斥修正啱用 | ❌ 隱藏 |
| `lanPort` | 預設 9100 | ❌ 隱藏（顯示「端口 9100」可改但唔默認顯示） |

> **Dev override**：`localStorage` 可手動加 `printer-dev-override` key 顯示全部技術欄位（俾工程師 debug 用，唔喺 UI 暴露）。

---

## §6 · 型號列表數據源

### 6.1 LAN 型號列表

LAN 唔做 VID/PID 偵測，商家憑機身標籤選。列表來自 `USB_PRINTER_DB` 扁平化 + 「通用 ESC/POS」兜底：

```typescript
const LAN_MODEL_OPTIONS = [
  { brand: "Epson", models: ["TM-T88IV", "TM-T88V", "TM-T88VI", "TM-T81II"] },
  { brand: "商頌", models: ["POS-80", "POS-58"] },  // 新增——USB Printer Class 通用
  { brand: "Xprinter", models: ["XP-Q800 / Q200", "XP-58 / 80 series"] },
  { brand: "Gprinter", models: ["GP-58 / 80 series", "GP-U80300", "GP-58MBIII"] },
  { brand: "Zjiang", models: ["ZJ-5805 / 5890", "ZJ-80"] },
  { brand: "Rongta", models: ["RP80 / RP58"] },
  { brand: "Star", models: ["TSP100 (TSP143)", "mC-Print2"] },
  { brand: "Citizen", models: ["CT-S310II", "CT-S4000"] },
  { brand: "Brother", models: ["TD-2xxx / RJ series"] },
  { brand: "Bixolon", models: ["SRP-350III"] },
  { brand: "通用 ESC/POS", models: ["通用 80mm 熱敏打印機"] },  // 兜底
];
```

> 「商頌 POS-80」要新增入 `USB_PRINTER_DB`——佢而家靠 USB Printer Class 0x07 fallback 認到，冇特定 VID entry。LAN 選擇時要手動列出。

### 6.2 USB 型號列表

來自 Companion `GET /api/usb` → `enumerateUsbPrinters()` 回傳嘅 `printers[]`，每個設備已含 `brand`/`model`/`vendorId`/`productId`/`charset`/`paperSize`/`kanjiEnlarge`。商家淨係揀，唔使填任何技術欄位。

---

## §7 · 組件架構

### 7.1 新增組件

```
src/components/
  printer-wizard-modal.tsx     ← 三步 wizard（取代現有 printer 表單）
  printer-card-v2.tsx          ← 簡化嘅 printer card（顯示摘要 + IP 可改）
```

### 7.2 PrinterWizardModal 狀態機

```typescript
type WizardStep = 1 | 2 | 3;

interface WizardState {
  step: WizardStep;
  // Step 1
  role: "zone" | "receipt" | "label" | null;
  connectionType: "lan" | "usb" | null;
  // Step 2
  model: string | null;           // 選定嘅型號名
  modelLocked: boolean;           // 選定後 true
  // Step 2/3 自動帶入（唔顯示）
  resolvedMeta?: ResolvedUsbMeta; // charset/paperSize/kanjiEnlarge
  usbVendorId?: string;
  usbProductId?: string;
  usbPort?: string;
  // Step 3
  ipAddress?: string;             // LAN 輸入
  selectedUsbDevice?: string;     // USB 選擇
  connectionTested: boolean;
  // 完成後
  zoneId?: string;                // 廚房機/標籤機嘅分區
}
```

### 7.3 流程

```
[+ 添加打印機] → 彈出 PrinterWizardModal
  Step 1: 選用途卡片 → 選連接方式卡片 → [下一步]
  Step 2: 選型號（LAN=列表, USB=偵測） → [下一步]
     → 自動帶入 charset/paperSize/kanjiEnlarge/VID/PID
  Step 3a (LAN): 輸入 IP → [測試連接] → 成功 → [完成]
  Step 3b (USB): 偵測列表 → 選設備 → [完成]
  → 寫入 config.printers[]（含所有技術欄位，UI 唔顯示）
  → Modal 關閉，列表刷新
```

### 7.4 現有 device-settings.tsx 改動

| 現有區域 | 改動 |
|---------|------|
| L801-1060 printer 卡片表單 | **整段移除**，改為 `<PrinterCardV2>` 列表 + `PrinterWizardModal` |
| `updatePrinter` 函數 | 保留（改 IP 用），但移除 role/connectionType/model/charset/kanjiEnlarge 嘅 editable |
| `handleAddCompanionPrinter` | 保留（Companion auto-pair 入口），改為開 wizard 預填 |
| `handleRoleChange` | 移除（role 鎖定，唔可改） |
| `removePrinter` | 保留 |

---

## §8 · 與 Companion 嘅互動

### USB 路徑

1. **Step 2**：`GET http://127.0.0.1:9311/api/usb` → `enumerateUsbPrinters()` 回傳設備列表
2. **Step 3**：用家選設備 → Companion 已知 `vendorId`/`productId` → `usbPort` 由 Companion 偵測或 fallback `USB001`
3. **測試連接**：`POST /api/print-test` 帶空 job → 確認打印機出紙

### LAN 路徑

1. **Step 3**：用家輸入 IP → `POST /api/probe-lan`（新 endpoint 或複用現有 test print）→ TCP socket 連 `IP:9100` → 2s timeout → 成功/失敗
2. 若 Companion 唔喺線（純 Android Native）：`PosNative.testPrint()` 測試

---

## §9 · 與既有數據結構嘅兼容

### 9.1 DevicePrinterConfig 唔改

`DevicePrinterConfig` 介面**唔改**——所有欄位保留，只係 UI 唔顯示技術欄位。wizard 寫入時自動填入：

```typescript
function buildPrinterFromWizard(state: WizardState): DevicePrinterConfig {
  return {
    id: uid("printer"),
    role: state.role!,
    connectionType: state.connectionType!,
    name: `${state.role === "receipt" ? "收據機" : state.role === "label" ? "標籤機" : "廚房機"} · ${state.model}`,
    model: state.model ?? undefined,
    paperSize: state.resolvedMeta?.paperSize ?? "80mm",
    charset: state.resolvedMeta?.charset ?? "gb18030",
    kanjiEnlarge: state.resolvedMeta?.kanjiEnlarge ?? "GS!",
    ipAddress: state.connectionType === "lan" ? state.ipAddress : undefined,
    lanPort: state.connectionType === "lan" ? 9100 : undefined,
    usbVendorId: state.connectionType === "usb" ? state.usbVendorId : undefined,
    usbProductId: state.connectionType === "usb" ? state.usbProductId : undefined,
    usbPort: state.connectionType === "usb" ? state.usbPort : undefined,
    zoneId: state.role !== "receipt" ? state.zoneId : undefined,
    enabled: true,
  };
}
```

### 9.2 舊打印機數據兼容

已添加嘅舊打印機（有齊所有欄位）會正常顯示喺列表，只係 UI 唔再顯示技術欄位。**唔需要 migration**——數據結構唔變，只係 UI 改。

### 9.3 PrinterRole 映射

| 美團式叫法 | PrinterRole | zoneId |
|-----------|-------------|--------|
| 廚房機 | `zone` | 必填（Step 1 後追加問「所屬分區」） |
| 小票機 | `receipt` | 唔需要 |
| 標籤機 | `label` | 必填（Step 1 後追加問「標籤分區」） |

> 廚房機/標籤機選完用途後，如果有多個分區，彈一個「所屬分區」選擇。如果只有一個分區（默認 `kitchen`），自動帶入唔問。

---

## §10 · 分區設置嘅處理

美團流程冇「分區」概念，但我哋需要。處理方式：

1. **廚房機/標籤機**：選完用途後，如果 `printZones` 多過 1 個 → 額外彈「所屬分區」選擇
2. **只有 1 個分區**：自動帶入，唔問
3. **分區管理**：保留現有「分區」tab 唔變（分區同打印機係獨立管理）

---

## §11 · 連接測試邏輯

### LAN 測試

```typescript
async function testLanConnection(ip: string, port = 9100): Promise<boolean> {
  // 如果 Companion 喺線
  if (isCompanionConfigured()) {
    const res = await fetch(`${companionUrl}/api/probe-lan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip, port }),
    });
    return res.ok;
  }
  // Android Native
  if (isNativeBridgeAvailable()) {
    return await testPrintNative();
  }
  // Fallback：瀏覽器冇法直接 TCP，提示需 Companion
  return false;
}
```

> Companion 要新增 `POST /api/probe-lan` endpoint（TCP socket 連 `ip:port`，2s timeout）。或者複用現有 test print 邏輯。

### USB 測試

選擇設備即代表連接——USB Printer Class 係 driverless raw，選到 = 連到。可以加一張測試打印確認。

---

## §12 · 實施計劃

### Phase 1：本 repo wizard UI（主體）

| 步驟 | 檔案 | 改動 |
|------|------|------|
| 1 | `src/components/printer-wizard-modal.tsx` | 新建三步 wizard |
| 2 | `src/components/printer-card-v2.tsx` | 新建簡化 printer card |
| 3 | `src/components/device-settings.tsx` | L801-1060 整段替換為 wizard + card-v2 列表 |
| 4 | `src/lib/print-bridge/printer-models.ts` | 加「商頌 POS-80」LAN 型號 entry |
| 5 | `src/lib/print-bridge/companion.ts` | 加 `probeLan()` helper |

### Phase 2：Companion endpoint

| 步驟 | 檔案 | 改動 |
|------|------|------|
| 1 | `companion-server.mjs` | 加 `POST /api/probe-lan`（TCP socket test） |

### Phase 3：收尾

| 步驟 | 檔案 | 改動 |
|------|------|------|
| 1 | `docs/82` | 本文件，完成後更新狀態 |
| 2 | `device-settings.tsx` | 移除 `handleRoleChange`、移除 printer 表單內所有技術欄位 select/input |

### 唔做

- 唔改 `DevicePrinterConfig` 介面
- 唔改 `dispatch.ts` / `native.ts` / `companion.ts` 嘅列印路徑
- 唔改 `print-jobs.ts` 嘅 job builder
- 唔改 Companion 嘅 `renderEscPos` renderer
- 藍牙先移除（如需保留另加）

---

## §13 · 驗收

1. 打開 `/settings` → 打印機 tab → 淨見「+ 添加打印機」+ 已添加列表
2. 點「+ 添加打印機」→ wizard 彈出
3. Step 1：選「廚房機」+「LAN」→ [下一步]
4. Step 2：選「商頌 POS-80」→ [下一步] → 型號變灰鎖定
5. Step 3：輸入 IP → [測試連接] → ✅ → [完成]
6. 列表顯示：廚房機 · POS-80 · LAN · IP
7. **唔見**：VID、PID、charset、kanjiEnlarge、lineSpacing、usbPort
8. 改 IP → 可改；改型號 → 唔可改（灰）；刪除 → 可
9. USB 路徑同理：Step 2 顯示偵測到嘅設備列表 → 選 → 連接成功 → 唔見技術欄位

---

## §14 · 與列印變形修正嘅關係

呢個方案同 docs/81 嘅 ESC/POS 相乘修正係**互補**：

- docs/81 修正咗 Companion renderer 嘅 `GS!0x11` + 互斥放大 + resetMagnify
- 本方案令商家**唔使手動設 `kanjiEnlarge`**——型號表自動帶入正確值
- 兩者一齊：商家揀「商頌 POS-80」→ 自動 `kanjiEnlarge=GS!` → Companion 行 `GS!0x11` 互斥 → 出紙正確

> 即係：docs/81 係引擎修正，docs/82 係駕駛介面簡化。兩者獨立但互補。
