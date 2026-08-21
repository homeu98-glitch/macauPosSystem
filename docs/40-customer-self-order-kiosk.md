# 40 · 客人自點模式（Customer Self-Order Kiosk）功能規格

> 狀態：設計階段（2026-08-21 初版；同日用戶 12 點反饋修訂），未實作。待 dev box `npm run build` 驗證。
> 適用範圍：餐飲（restaurant）；美容（salon）暫不納入，待餐飲跑通。
> 相關：docs/36（native print agent）、docs/38（返結／反結賬）；線上訂單 Realtime 渠道見 Macau-Ledger。

## 1. 背景

目前落單全部靠員工喺收銀 POS 逐張入。想減人手、減排隊、減點錯，就係要比客人自己點：坐低掃枱 QR，或者店內平板 Kiosk，自己揀菜落單，廚房照出單，員工喺收銀只負責收錢同埋協助。

名詞澄清（重要）：**「線上訂單」= 外部平台（外賣／線上點餐系統）落嘅單**，顯示喺「線上」面板；**Kiosk 自點 = 店內自點**，唔係線上單（無 `onlineOrderId`）。Kiosk 綁枱單顯示喺**堂食**枱位圖，快餐／外賣單顯示喺**快餐候單**，兩者都唔入「線上」面板。

## 2. 名詞

| 詞 | 意思 |
|----|------|
| 客人自點 Kiosk | 客人向落單介面，觸控設計，落單匿名（無客人 login） |
| Kiosk 設備綁店 | 部機首次需 admin 登入，綁定所屬店 + 打印機 + 語言（落單先知道屬邊間店） |
| 枱 QR | 印喺枱面嘅 QR，掃咗開 `/order?tableId=A01`，天然綁枱 |
| 固定平板 Kiosk | 店內平板，鎖定瀏覽器開 `/order` 嘅專機 |
| 公開菜（customerOrderable） | Menu Item 旗標，Kiosk 只露呢類 |
| 取餐號 | 快餐／外賣落單後畀客人嘅 pickup 編號，商家叫號憑證 |
| 待確認（dine_in_confirm） | 堂食落單後未落廚房，等員工喺 POS 確認才 `sent_to_kitchen` |
| 候單 / 已下單 | 落單後 `status === "sent_to_kitchen"`，收銀未結 |

## 3. 設計決策（用戶 2026-08-21 拍板 + 12 點反饋修訂）

1. **獨立 route `/order`，落單匿名；但部機需 admin 綁店**：新增 `src/app/order/page.tsx`（客人向）。落單本身**唔使客人 login**；但**每台 Kiosk 設備首次需 admin 登入／設定**綁定所屬店（`storeId`）+ 打印機對應 + 語言，存喺部機。否則部機唔知自己屬邊間店、對應咩打印機。Kiosk 有「設定」掣 → 入 admin 密碼 → 改配置（重用現有 backoffice / admin auth）。收銀套 `pos-app.tsx` 原封不動，Kiosk 摸唔到退菜／退款／改價。
2. **入口雙軌，同一 URL，經外網**：手機掃枱 QR 同固定平板 Kiosk 都開公開 `/order`（Vercel 外網 hosted，同現有 POS 一樣）。平板 Kiosk 只係鎖定瀏覽器開同一 URL 嘅專機，唔寫第二套。
3. **顯示位置：堂食／快餐，唔係線上**：有 `tableId` → 堂食（枱位圖變「已下單」或「待確認」）；無 `tableId` → 快餐／外賣，入 `counter`，顯收銀候單。兩者都**唔入「線上」面板**（無 `onlineOrderId`）。
4. **付款：P1 唔集成**：客人落單出廚房單 → 收銀見單 → 去收銀找數（訂單維持 `sent_to_kitchen` 未結，似正常流程由員工 settle）。線上付款（MPay／支付寶澳門／微信／銀聯）留 P3，**因為而家仲未接通網上支付**。
5. **落單經 Supabase Realtime，禁 polling；售罄即時**：Kiosk 落單推 `ORDER_CREATED` + `PRINT_JOB_CREATED` 事件去 Supabase（似線上訂單渠道），收銀經 **Realtime 訂閱**拉入 `orders` → 枱位圖／候單，print agent 出廚房單。**絕對唔寫 Kiosk localStorage、絕對唔用任何 polling**——必須即時（秒級，同現有線上訂單渠道一致）。`soldout` 變動都要經 Realtime 訂閱即時反映（咪用 bootstrap 快照，否則商家要多溝通成本）。
6. **Menu 加 `customerOrderable` 旗標**：`MenuItem` 加 `customerOrderable?: boolean`（預設 `true`）。Kiosk 只讀 `customerOrderable && !soldout` 嘅菜，濾走內部價／停售／員工註解項。**菜名 P1 只留中文，唔做多語**（用家確認暫無必要）；UI 框架（分類、按鈕、提示、確認頁）做 `zh-HK` / `pt` / `en` 切換。
7. **廚房單歸邊設定 `kioskKitchenMode`**（用家要求有得揀）：
   - `auto`：落單即出廚房單（直出）。
   - `dine_in_confirm`（只限堂食）：客人落單後，商家 POS **彈「X 號台已下單，請確認」** → 按查看 → 顯點餐介面 + 該枱內容 → 商家確認 → 按下單 → 正常 `sent_to_kitchen` 流程（此 mode 下堂食單落單時係 `draft`，等員工確認才落廚房）。快餐／外賣永遠 `auto`（櫃檯即處理，唔使確認）。
8. **取餐號單（快餐模式）**：快餐／外賣落單後出張單畀客人，上面有**取餐號**（ reuse 現有 `localOrderNo`）；商家叫號，客人攞號去櫃檯換餐 + 付款。Kiosk 確認頁同廚房／櫃檯單都印取餐號。
9. **重複掃碼 resume 現有單，唔開新單**：開 `/order?tableId=A01` 時，先查呢張枱有冇**未結（unsettled）**單 → 有就 resume（顯示當時內容、客人可加菜）；直到 `settled` 先 reset。快餐（無枱）用 Kiosk/device session 或 URL resume token 達到同一效果（再入咪開新單，直到該單結帳）。堂食同快餐一致。
10. **QR 生成喺商家 POS / backoffice**：按枱生成 `https://.../order?tableId=A01` 嘅碼，印出貼枱。工具擺 backoffice / settings（P1 做，因為堂食 QR 係 dependency）。
11. **Kiosk 設備 admin 登入／設定**（詳見決策 1）：每台點餐用 Kiosk 需設定、需登入；有「設定」掣 → admin 密碼 → 改配置（綁店、打印機、語言）。無登入綁定就唔知邊間店、對應咩打印機。
12. **Kiosk 同點餐 QR 都用外網**：兩者經外網去 Vercel hosted 嘅 `/order`。落單頁公開，但淨係建立訂單、無敏感資料；店／打印機綁定靠設備 provisioning（決策 1/11）。

## 4. 資料流

```
  客人 (掃枱 QR / 平板 Kiosk) ──外網──> /order
        │  開 /order?tableId=A01（無=快餐）
        │  查 tableId 有冇 unsettled 單 → 有就 resume，無就新開（點 9）
        ▼
  ┌─────────────────────────────────┐
  │  Kiosk UI  (/order)               │  讀 bootstrap.menuItems（customerOrderable && !soldout）
  │  - 分類 + 公開菜（中文）           │  訂閱 soldout Realtime（即時，點 5）
  │  - 購物車 + 落單                   │
  └─────────────────────────────────┘
        │  createKioskOrder()
        │  推 Supabase Realtime（禁 polling，點 5）
        ▼
  ┌─────────────────────────────────┐
  │  Supabase Realtime（subscribe）    │  ORDER_CREATED + PRINT_JOB_CREATED
  └─────────────────────────────────┘
        │                              │
        ▼                              ▼
  Staff POS                        Kitchen / Counter 打印
   - 堂食(tableId):                  （消 PRINT_JOB_CREATED → 出廚房單）
       · auto 模式 → 枱位圖「已下單」直出廚房單
       · dine_in_confirm 模式 → 彈「X台已下單請確認」
           → 查看 → 確認 → sent_to_kitchen → 出廚房單（點 7）
   - 快餐(counter): 候單，出「取餐號」單，商家叫號（點 8）
```

狀態機（同現有堂食一致，Kiosk 只創建前半段）：

```
  Kiosk 落單 → draft（dine_in_confirm 堂食）/ sent_to_kitchen（auto / 快餐）
                   │
          收銀員工確認（dine_in_confirm）→ sent_to_kitchen → 廚房出單
                   │
          收銀員工結帳 → paid / settled（P1 由員工做，點 4 唔集成付款）
                   │
          返結／退菜／退桌（已有，員工側）
```

Kiosk 本身**唔落** `paid`／`settled`／`cancelled` —— 終態一律由收銀員工操作。

## 5. 實施分期

### Phase 1 — 證明流程（零付款，本次目標）
- [ ] `MenuItem` 加 `customerOrderable?: boolean`（`types.ts`）；`bootstrap-normalizer.ts` 原樣過；`mock-data.ts` 現有項預設 `true`。
- [ ] `device-settings.tsx` 菜單編輯器加「客人可點」toggle，存 bootstrap。
- [ ] **Kiosk 設備 admin 綁店**（`src/app/order` 內「設定」掣 → admin 密碼 → 綁 `storeId` + 打印機 + 語言，存部機）；重用 backoffice/admin auth（點 1/11）。
- [ ] 新增 `src/app/order/page.tsx`：客人向觸控介面（分類 → 公開菜 → 加購 → 購物車 → 落單）。UI 框架語言 `zh-HK / pt / en`（菜名中文）。
- [ ] `src/lib/kiosk-order.ts`：抽出共用落單建構（建 `PosOrder` + 廚房 `PrintJob`），俾 Kiosk 同 `pos-app` 共用。
- [ ] 落單推 **Supabase Realtime**（禁 polling），**唔寫 Kiosk localStorage**；收銀 Realtime 訂閱拉入 `orders`（點 5）。
- [ ] `soldout` Realtime 訂閱，Kiosk 即時反映（點 5/9）。
- [ ] 堂食（`?tableId=`，`dine_in_confirm` 模式落 `draft` 等確認）+ 快餐（無 tableId → `counter` + 自取／外賣 + **取餐號**，點 8）。
- [ ] **重複掃碼 resume** 現有 unsettled 單（按 tableId / session），唔開新單直到 settled（點 9）。
- [ ] 確認頁：訂單號 + 枱號／取餐號 + 「請往收銀付款」；快餐出取餐號單（點 8）。
- [ ] 設定 `kioskKitchenMode: "auto" | "dine_in_confirm"`（點 7）。
- [ ] **QR 生成工具**喺 backoffice / settings，按枱輸出 `https://.../order?tableId=`（點 10）。

### Phase 2 — 固定平板 Kiosk 硬化
- [ ] 平板專機：禁用右掣／禁離開／逾時返主頁。
- [ ] 快餐／外賣 resume：Kiosk/device session 或 URL resume token，令無枱單都可 resume 到結帳（點 9）。
- [ ] 多語默認跟店舖主語言；螢幕自適應（平板 1080p+）。

### Phase 3 — 線上付款（ deferred，因未接通網上支付）
- [ ] 接 MPay／支付寶澳門／微信支付／銀聯；落單即扣，狀態落 `paid`。
- [ ] 會員餘額付款（借 Macau-Ledger）。
- [ ] 付款失敗回退 → 轉收銀找數。

### （Salon 暫不納入，確認）

## 6. 預計檔案改動

| 檔 | 改動 |
|----|------|
| `src/lib/types.ts` | `MenuItem.customerOrderable?`；`PosLocalSettings.kioskKitchenMode`；`storeId` 綁定相關 |
| `src/lib/bootstrap-normalizer.ts` | 過 `customerOrderable` |
| `src/lib/mock-data.ts` | 現有項預設 `customerOrderable: true` |
| `src/components/device-settings.tsx` | 菜單編輯器加「客人可點」toggle |
| `src/app/order/page.tsx` | **新增** 客人向 Kiosk 介面 + 「設定」掣（admin 綁店） |
| `src/lib/kiosk-order.ts` | **新增** 落單建構（建 `PosOrder` + 廚房 `PrintJob`，推 Realtime，resume 邏輯） |
| `src/lib/pos-orders.ts` | 抽出／共用落單建構俾 Kiosk 用 |
| `src/lib/print-jobs.ts` | 廚房單 + 取餐號單 builder 共用 |
| `src/components/backoffice-*.tsx` | **新增** QR 生成工具（按枱輸出 `/order?tableId=`） |
| Supabase 渠道 | Kiosk 單 + soldout 嘅 Realtime 推送同收銀訂閱（似線上訂單，禁 polling） |

## 7. 風險與開放問題

- **跨機同步即時**：用 Supabase Realtime（subscribe），**禁用任何 polling**，同現有線上訂單渠道一致（秒級）。Kiosk 推 → 收銀即見，唔好客人落完單收銀仲未見。
- **廚房單歸邊**：`auto` 直出；`dine_in_confirm` 堂食彈確認窗，員工確認才落廚房。快餐永遠 `auto`。設定喺 `kioskKitchenMode`。
- **售罄即時**：經 Realtime 訂閱，唔用 bootstrap 快照（點 9）。
- **重複落單／誤觸**：按 tableId / session resume 現有單，直到 settled 先 reset（點 7）；快餐無枱用 device/session token。
- **Kiosk 設備身分**：每台 Kiosk 需 admin 登入綁店 + 打印機，否則唔知邊間店、對應咩機（點 11）。落單頁公開但淨建單、無敏感資料。
- **取餐號一致性**：快餐取餐號 reuse 現有 `localOrderNo`，商家叫號流程照舊。
- **Salon 唔納入**：美容自點（預約）玩法唔同，餐飲跑通後再議。
