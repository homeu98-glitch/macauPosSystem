# 55 — Android Print Agent 模板驅動化（P7 收尾）

> 狀態：**待辦（文檔標記）**。本 checkout 唔包含 `print-agent-android/` 倉庫，
> 所以本檔係「對接規格 + 待辦清單」，唔係直接改碼。Android 倉庫要喺 dev box 另行開 PR。
>
> 關聯：Phase 1 收斂方案（`docs/60` ESC/POS 模板統一）、`docs/36-native-print-agent.md`、
> Companion 模板驅動化（`companion-server.mjs` `renderEscPos` 已落地，見 §1）。

## 1. 背景與現狀

Option 1 收斂完成後，打印管線有三條「同源」渲染路徑，目標係 **設計介面 == 預覽 == 實際出紙**：

| 路徑 | 位置 | 狀態 |
| --- | --- | --- |
| Web 預覽 | `src/lib/escpos-render.ts` `renderEscPosLines` → `EscPosPreview` / `KitchenTicketPreview` | ✅ 已落地 |
| 桌面 Companion | `companion-server.mjs` `renderEscPos(job, printer)` | ✅ **模板驅動**（現 0.1.11，含 items `card` 排版 / docs/67） |
| Android APK | `print-agent-android` `EscPosRenderer.renderReceiptTicket` / `renderKitchenTicket` | ❌ **仍係硬編碼舊路，未讀 template** |

Companion 嘅新路徑邏輯（`companion-server.mjs:253`）：

```js
if (job.template && Array.isArray(job.template.blocks) && job.template.blocks.length) {
  const snap = job.template;
  const titleText = kind === "receipt" ? "＊＊＊ 收據 ＊＊＊"
                  : kind === "kitchen" ? "＊＊＊ 廚房 ＊＊＊" : "";
  if (titleText) textLine(titleText, "m", true, "center");
  for (const b of snap.blocks) {
    if (!b.visible) continue;
    if (b.id === "items") {
      divider();
      for (const it of items) {
        textLine(`${it.name}  ${qty}`, b.size || "m", Boolean(b.bold), b.align || "left");
        for (const s of it.specs || []) textLine(`  · ${s}`, b.subSize || "s", false, b.align || "left");
        if (it.note) textLine(`  注：${it.note}`, b.subSize || "s", false, b.align || "left");
      }
      divider();
    } else {
      const text = (content && content[b.id]) || "";
      if (!text) continue;
      textLine(text, b.size || "s", Boolean(b.bold), b.align || "left");
    }
  }
  // feed + GS V 切紙
  return;
}
// 無 template → 舊 fallback（硬編碼抬頭/票種/單號/時間/項目/footer）
```

**問題核心**：`src/lib/print-bridge/native.ts` 經 `PosNative.printJob(json)` 發去 APK 嘅 payload（第 46–85 行），
目前**只轉發咗 `job.items`，冇轉發 `job.template` 同 `job.content`**。所以就算 APK 想做模板驅動，
都收唔到模板快照同靜態區塊文字，必然會 fallback 去舊硬編碼渲染 → **手機/平板經 APK 打印嘅結果，會同網頁預覽、Companion 出紙唔一致**。

呢個係 Option 1「設計介面 == 預覽 == 實際輸出」最後一塊冇補嘅位。

## 2. 要改嘅兩處（Android 倉庫內）

### 2.1 `src/lib/print-bridge/native.ts` — 擴充 payload

喺 `payload.job` 加兩個欄位，直接 serialize `PrintJob` 上已有的 `template` / `content`：

```ts
const payload = {
  job: {
    id: job.id,
    orderNo: job.orderNo ?? "",
    tableName: job.tableName ?? "",
    orderId: job.orderId ?? "",
    printerGroup: job.printerGroup,
    ticketType: job.ticketType,
    printerId: job.printerId ?? "",
    printerName: job.printerName,
    items: (job.items ?? []).map((it) => ({
      name: it.name, quantity: it.quantity, specs: it.specs ?? [], note: it.note ?? "",
    })),
    createdAt,
    // ── 新增：模板驅動所需（與 Companion 同源） ──
    template: job.template ?? null,   // EscPosTemplateSnapshot | undefined
    content: job.content ?? null,     // Record<string,string> | undefined
  },
  // ... printer / kind / storeName / paymentMethod / total / storeId / ttl 不變
};
```

> `EscPosTemplateSnapshot` 同 `PrintJob.content` 嘅型別已經喺 `src/lib/types.ts` 定義好（見 §3），
> APK 側要定義同一 shape 嘅 Kotlin data class 嚟 decode。

### 2.2 `print-agent-android` `EscPosRenderer` — 改為模板驅動

`EscPosRenderer.renderReceiptTicket` 同 `renderKitchenTicket` 要加一條「睇 `job.template` 是否存在」嘅分支：

- **有 `template`**：逐 block 行 `if (!visible) continue`；`items` block 印分隔線 + 每項 `name x qty` + specs/note 細字副行 + 尾分隔線；
  其他 block 由 `content[block.id]` 取值（空就 skip）。`size`/`bold`/`align` 經 ESC `!` / `E` / `a` 落去（見 `SIZE_BYTE` 對照表）。
  - **`items` block 嘅 `layout` 欄位（docs/67）**：`"card"`（預設）= 序號 `1. 2. 3.` 前綴 + 品名行（加粗）+ 名下虛線規則線（`-` 重複一排）+ 規格/備註**成組縮排、唔加 bullet** + 菜與菜之間留白；`"inline"` = 舊式 `name x qty` 左右排列 + `·` 規格 bullet；`"stacked"` = 完全直向（待定，今輪只落咗 card）。
  - APK 要同 Companion（`companion-server.mjs` items 分支）完全一致：名行 `textLine(\`${i+1}. ${name}  x${qty}\`)` → `divider()` → 每條 spec `textLine(\`  ${s}\`)` → note `textLine(\`  注：${note}\`)` → 菜間 `textLine("")` 留白。
- **無 `template`**（舊 job / 其他來源）：保留而家嘅硬編碼渲染做 fallback，唔好拆。

ESC/POS 指令對照（Kotlin 同樣適用）：

| 語意 | 指令 | 值 |
| --- | --- | --- |
| 對齊 | `ESC a` | 0=left / 1=center / 2=right |
| 粗體 | `ESC E` | 0=off / 1=on |
| 字型大小 | `ESC ! n` | `s=0x00` / `m=0x20` / `l=0x60`（`SIZE_BYTE`） |
| 切紙 | `GS V` `0` | 半切 |

`SIZE_BYTE = { s: 0x00, m: 0x20, l: 0x60 }` —— 與 Companion（`companion-server.mjs:222`）完全一致，
確保 APK 同桌面出紙字型大小相同。

## 3. 合約參考（必須與 web 端同 shape）

來自 `src/lib/types.ts`：

```ts
export type EscPosItemsLayout = "inline" | "card" | "stacked";  // 菜品明細清單排版（見 docs/67）
export interface EscPosBlockStyle {
  visible: boolean;
  size: "s" | "m" | "l";      // EscPosSize
  bold: boolean;
  align: "left" | "center" | "right";  // EscPosAlign
  subSize?: EscPosSize;       // 規格/備註次級字型
  layout?: EscPosItemsLayout; // 只有 items block 有意義；缺省當 "card"
}
export interface EscPosTemplateSnapshot {
  kind: "receipt" | "label" | "kitchen";   // PrintTemplateKind
  blocks: Array<{ id: string; visible: boolean; size: EscPosSize; bold: boolean; align: EscPosAlign; subSize?: EscPosSize; layout?: EscPosItemsLayout }>;
}
export interface PrintJob {
  // ...
  template?: EscPosTemplateSnapshot;       // 第 448 行
  content?: Record<string, string>;        // 第 450 行：靜態區塊文字，key = section id，items 除外
}
```

APK 側 decode `payload.job.template` / `payload.job.content` 後，渲染演算法要同
`renderEscPosLines`（`src/lib/escpos-render.ts`）以及 Companion `renderEscPos` 完全一致，
先可以達到「設計介面 == 預覽 == 實際出紙」。

## 4. 驗證矩陣（APK 改完之後）

喺 Sunmi 機實機行一次，對照網頁 `/print-center` 預覽：

1. 收據：店名/單號/枱號/項目/總計 嘅 可見性、字型大小、對齊、粗體，要同設計 tab 一致。
2. 標籤：header/footer 文字、項目排序要同標籤設計 tab 一致。
3. 廚房：全單備註（`order_note` block）要出到；新增嘅 section 要跟 `order` 陣列順序。
4. 退單（void）/ 加單（addon）：`ticketType` 唔影響模板渲染，但要確認 `items` override 有落到 APK。
5. 冇 template 嘅舊 job：fallback 硬編碼路徑仍然出到紙（唔 regression）。

## 5. 待辦清單（checklist）

- [ ] `native.ts` payload 加 `job.template` + `job.content`（本倉庫，見 2.1）
- [ ] Android `EscPosRenderer` 加 template 分支（Android 倉庫，見 2.2）
- [ ] APK 定義 `EscPosTemplateSnapshot` / `content` Kotlin data class
- [ ] APK 實機驗證矩陣（§4）
- [ ] **APK 重新 build + 派版**（版本號要同 Companion 0.1.9 一齊記錄到 release note）
- [ ] 上 GitHub（Android 倉庫 PR）

> 備註：Companion `0.1.8 → 0.1.9` 已經喺 dev box 改完 `companion-server.mjs` 並 bump version，
> 但要 `npm run dist` 重新打包 exe 先生效（見 `docs/49-desktop-auto-update.md` / 桌面重建規約）。
> APK 呢邊同等處理：source 改完唔等於生效，必須 rebuild + 派版。
