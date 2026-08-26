# 67 — 打印內容 list view：採用 方案 B 分層卡片清單

> 狀態：**已落碼（2026-08-26）**。方案 A/B/C 對比見 `docs/67` 對話；本檔記錄最終決定與實作落點。

## 1. 決定

打印預覽 / 實紙嘅菜品明細，由舊式「左右排列」（`name` 左、`x數量` 遠右，順序難辨識）改為 **方案 B 分層卡片清單**：

- 每道菜 = 一個卡片單元；
- 品名行（加粗，左對齊）前方加 `1. 2. 3.` 序號錨定順序；
- 品名行下方一條**虛線規則線**分隔品名與規格；
- 規格 / 備註成組**縮排**（無 bullet），作為子層；
- 菜與菜之間留白（`mb-2` / Companion 印空行）。

**揀 B 嘅理由**：層級最分明（品名 → 規格）、密度適中（比 A 清、比 C 慳紙），收據 + 廚房都啱用，做統一預設。

三方案對比（排版 / 層級 / 間距）：

| | A 緊湊序號 | B 分層卡片（採用） | C 階層直向 |
| --- | --- | --- | --- |
| 結構 | 序號+品名同行、數量靠右、`·` 縮排 | 品名行→名下虛線→規格成組縮排 | 品名獨行→數量獨行→規格深縮排 |
| 層級 | 2 層 | 3 層 | 3 層 |
| 間距 | 緊 | 中 | 寬 |
| 紙張 | 最短 | 中 | 最長 |

## 2. 實作落點

| 檔 | 改動 |
| --- | --- |
| `src/lib/types.ts` | 加 `EscPosItemsLayout = "inline" \| "card" \| "stacked"`；`EscPosBlockStyle.layout?`；`EscPosTemplateSnapshot.blocks[].layout?` |
| `src/lib/escpos-template.ts` | `block()` helper 加第 6 參數 `layout`；`DEFAULT_RECEIPT_TEMPLATE.items` / `DEFAULT_KITCHEN_TEMPLATE.items` 設 `"card"` |
| `src/lib/escpos-render.ts` | `EscPosLine` items variant 加 `layout: EscPosItemsLayout`；`renderEscPosLines` 推 `layout: b.layout ?? "card"`（舊模板缺省當 card） |
| `src/components/escpos-preview.tsx` | items 分支：`layout === "card"` → 序號前綴 + 虛線 + 成組縮排；否則舊式 inline |
| `desktop-companion/companion-server.mjs` | `renderEscPos` items 分支：`b.layout \|\| "card"` → `序號 品名 x數量` + `divider()` + 規格（無 bullet）+ 菜間空行；否則 inline。`version` `0.1.10 → 0.1.11` |
| `docs/55-android-template-driven.md` | 補 `layout` 合約 + APK items 分支要 mirror card 渲染 |

標籤模板無 `items` block（每張 1 件、per-item section），唔受影響。

## 3. 切換 / 擴展

- 想改用 A 或 C：改 `DEFAULT_*_TEMPLATE.items.layout`（新店）或該店 `printTemplates.*.items.layout`（舊店遷移）；preview / Companion 同食 `layout` 欄位。
- `inline` = 舊式左右排列；`card` = 本方案；`stacked` 係保留值（暫同 inline fallback，未實作完全直向渲染）。
- 三路徑同源：`renderEscPosLines`（web 預覽）／Companion `renderEscPos`（桌面 exe）／APK `EscPosRenderer`（待 P7 補 `layout`）都讀同一 `layout` → 設計介面 == 預覽 == 實紙。

## 4. 部署

- web 側（types / escpos-template / escpos-render / escpos-preview）Vercel push 即生效。
- **Desktop Companion `0.1.11` 必須喺 Windows dev box `npm run dist` 重 build exe 先生效**（按 standing instruction 主動報版本號：0.1.10 → 0.1.11）。
- Android APK：待 P7 文檔執行 + rebuild（本回合未做，僅補合約說明）。
