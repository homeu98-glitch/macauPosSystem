# 38 · 返結 / 反結賬（Reopen & Re-settle）功能規格

> 狀態：Phase A / B / C 已落地（2026-08-20），待 dev box `npm run build` 驗證。
> 適用範圍：餐飲（restaurant）+ 美容（salon）雙模組。
> 相關：docs/37（APK Native Bridge 打印格式需求）；Ledger 反向調整 RPC 需求見 docs/39。

## 1. 背景

線上 / 堂食訂單一旦 `settled` / `paid`，目前**冇任何方法改返**。商家若結帳結錯（加錯 item、折扣計錯、找錯錢、會員扣錯），只能靠「作廢」或「退款」呢類**終態**操作，無法把單退回可編輯再更正。

現狀審計（2026-08-20）：
- 全庫無 `reopen` / `unsettle` / `返結` 能力。
- 餐飲 `voidEntireOrder` 硬性要求 `status === "sent_to_kitchen"`，對 `settled` 單唔適用；`refundOrder` / `cancelOrder` 皆為終態。
- 美容 `SalonOrderStatus` 有 `cancelled` / `no_show` 枚舉但從未賦值；美容單實際只到 `settled`。
- `printVoid*` 三函只印 void 小票，唔改狀態。
- 權限：餐飲有 `UserPermissions.refundOrder/voidItem` + `showPermissionDenied`；美容**完全無權限層**。

## 2. 名詞

| 詞 | 意思 |
|----|------|
| 反結賬 / 返結 / Reopen | 把已結單退回**可編輯**狀態，改完再結（本功能） |
| 重結 / Re-settle | 返結後改完，重新落單結帳 |
| 作廢 Void | 成單取消，當冇發生（終態） |
| 退款 Refund | 已收錢退返客（終態） |

業界（銀豹、有贊）統稱「反結賬」。本規格用 **返結（reopen）→ 重結（re-settle）** 一對詞。

## 3. 設計決策（用戶 2026-08-20 拍板，2026-08-20 晚修訂）

1. **完整回滾**：返結時一併反向回滾會員餘額 / 積分 / 套票扣次；重結時重新扣。防會員被雙重扣款。
2. **權限門控（2026-08-20 晚取消）**：用戶決定**唔加 PIN 同權限門控**，理由係步驟太多會浪費工人時間。改為：**任何員工都可以直接返結**，只需強制揀「返結原因」（從設置清單揀，不可空白）。餐飲 `UserPermissions.reopenOrder` 權位保留喺 types 但**唔做門控**；美容唔另起權限。
3. **強制原因（保留）**：返結必須填原因；「設置」內「返結原因 / 備註」**可配置清單**（似銀豹「反結賬&退貨原因設置」），餐飲 `settings.tsx` 與美容 `salon/settings.tsx` 各加，存各自 bootstrap。經理 PIN 授權 **取消**。
4. **線上訂單範圍（2026-08-20 收尾追加，後經用戶澄清收窄）**：用戶澄清「線上訂單唔可以返結」只係指**純線上快餐 / 自取 / 外賣**（counter / 未轉枱）；**「線上堂食單轉到枱」已變成喺店單，要可以返結**，美容同理（到店服務單）。判定邏輯：`isReopenable` 對有 `onlineOrderId` 嘅單改為「只有 `tableId != "counter"`（已轉枱堂食）先放行；counter / 無枱線上單照擋」。本地面板列表過濾由 `isLocalPosOrder`（= `!onlineOrderId`）放寬為 `isLocalOrTransferredDineIn`（本地單 + 已轉枱線上堂食單），令呢類單出得返面板、按到「返結」；純線上快餐/自取/外賣仍只喺 online-orders 面板、唔入本地面板、唔可返結。保留 `onlineOrderId` 唔清走（唔影響 Ledger 對賬）。美容無 `onlineOrderId` 字段，一向當本地單，唔受影響。

## 4. 狀態機

```
         ┌──── 作廢 / 退款（終態，已有） ────┐
         │                                  │
  draft → … → 已完成 (settled / paid)       ↓
                  │  ▲                       (終態)
         返結 reopen │  │ 重結 re-settle
                  ▼  │
            reopened（可編輯 · 待重結）
```

- 新增狀態 `reopened`（餐飲 `PosOrder.status`、美容 `SalonOrderStatus`）。
- `reopened` 視為「可編輯、未最終」，UI 當 draft 處理。
- **重結後回到 `settled`**：report 只數 `settled`，唔會重複計營收。
- 禁止對已 `refunded` / `cancelled` 單返結。

## 5. 實施分期

### Phase A — 共享地基（本次）
- [ ] 兩模組 `types.ts` 加 `reopened` 狀態 + 審計字段。
- [ ] 設置加「返結原因」可配置清單（餐飲 + 美容），存 bootstrap。
- [ ] 新增 `buildReopenPrintJobs`（印「返結」單）。
- [ ] 餐飲 `UserPermissions` 加 `reopenOrder` + `showPermissionDenied` 門控骨架。

### Phase B — 餐飲
- [x] `local-orders-panel.tsx`「已完成」詳情加「返結」掣（無權限 disabled，簡化後任何員工可點）。
- [x] 揀原因 → 轉 `reopened` + 印返結單 + **反向回滾會員餘額**（best-effort，見 §7 / docs/39）。
- [x] 重結：複用 `confirmPayment`（源 reopened 單）→ 回 `settled` + 重推 `ORDER_SETTLED` + 重新扣。
- 實施筆記：返結入口在 orders-hub 的「已完成」訂單詳情；重結在 POS 工作台選回該枱位（`openOrders` 已含 `reopened`，枱位會載入可編輯），改正後結帳即重結。
- 線上訂單範圍（見 §3 決策 4）：純線上快餐/自取/外賣（counter / 未轉枱）排除返結；「線上堂食轉枱」單（`onlineOrderId` + `tableId!="counter"`）當本地單可返結。本地面板過濾由 `isLocalPosOrder` 放寬為 `isLocalOrTransferredDineIn`，令轉枱堂食單出得返面板；`isReopenable` 同步放行，`reopenPosOrder` 內部再審。

### Phase C — 美容
- [x] 返結入口放在 `checkout`「已結帳」屏（預約結帳後即見；經 service-runner 重開 settled 預約亦可達），免另起 drill-down 列表。
- [x] 返結 → `reopened` + 印單 + **本地 mock 反向回滾**（客戶檔案 ledgerBalance / ledgerPoints / 套票次數加返、pointsEarned 減返、推薦獎勵扣返並重置標記）。
- [x] 重結：複用 salon `checkout`，針對同一 `booking.orderId` 就地更新 order（不新增），重新扣。

### Phase D — 硬化
- [x] 強制原因（設置清單，不可空白）。
- [x] 審計日誌（reopenedAt / reopenedBy / reopenReason / reopenCount / originalSettledAt）。
- [x] 防重複重結（重結就地更新同 id，report 只數 settled，不重複計營收）。
- [x] 更正收據（返結單 ticketType=void + 重結正常收據）。
- [ ] 手測（待 dev box build + 真機/模擬數據）。

## 6. 數據模型變更

### 餐飲 `src/lib/types.ts`
```ts
// PosOrder.status
status: "draft" | "sent_to_kitchen" | "paid" | "settled" | "reopened" | "cancelled" | "partially_refunded" | "refunded";

// 審計字段（加落 PosOrder）
reopenedAt?: string;
reopenedBy?: string;
reopenReason?: string;
reopenCount?: number;
originalSettledAt?: string;

// UserPermissions
reopenOrder: boolean;

// 設置（StoreBootstrap 或對應 config）
reopenReasons: string[];
```

### 美容 `src/lib/salon/types.ts`
```ts
// SalonOrderStatus
| "reopened"

// SalonPosOrder 審計字段同上（reopenedAt / reopenedBy / reopenReason / reopenCount / originalSettledAt）
// SalonBootstrap
reopenReasons: string[];
```

## 7. Ledger 對賬影響

- **餐飲**：會員餘額 / 積分喺 Ledger 真後端。完整回滾需 Ledger **反向調整 RPC**（現無 `p_type:"add"` 分支）。處理：v1 `reopenPosOrder` 調用 `applyPosAdd`（best-effort）；若 RPC 未佈署，只本地 flip 狀態 + 印單，並 toast 提示「會員餘額退回待 Ledger 對接」。需求書見 **docs/39** 交同事加 RPC，到位後 `applyPosAdd` 即生效真正沖。
- **美容**：v1 全本地 mock 回滾（`applyMockLedgerDelta` 加回餘額 / 積分、扣返賺分與推薦獎勵；`revertPackageDeductions` 加返套票次數）。真 Ledger 對接要補 `ledgerOrderId`（留 seam）。

## 8. 風險與待決

- 餐飲 Ledger 反向 RPC 依賴同事（同 docs/37 模式）。
- 美容 `reopened` 狀態對 report / sync 的影響要回歸測（狀態機只數 settled）。
- 「返結原因」清單兩模組都要落 storage，建議存各自 bootstrap。
- 線上訂單對賬：純線上快餐/自取/外賣（counter / 未轉枱）責任歸上游 Ledger，POS 唔返結（見 §3 決策 4）；「線上堂食轉枱」單已視作喺店單，可返結。美容無 `onlineOrderId`，一向當本地單。

## 9. 驗收清單（Phase A）

- [ ] `tsc --noEmit` 零新增錯誤（預期只餘 `layout.tsx` `LayoutProps` 誤報）。
- [ ] 兩模組 `types` 加咗 `reopened` + 審計字段。
- [ ] 設置頁可增删「返結原因」，刷新後保留。
- [ ] `buildReopenPrintJobs` 存在且產出合理 PrintJob。
- [ ] 餐飲 `reopenOrder` 權位可配置，`showPermissionDenied` 可接。
