# 120 · 掃碼／Kiosk 顧客 Ledger 登入・扣費・用券 — 可行性評估

> **文件版本**：v1.0（可行性評估，**未落任何 code**）
> **日期**：2026-09-11
> **輸入**：夥伴交接《給 macauPosSystem 的 v3.4 顧客登入交接》（2026-09-11）
> **範圍**：`src/app/order`（Kiosk 自助機）、`src/app/menu`（堂食掃碼）、`src/app/quick`（快餐掃碼）
> **相關**：docs/110（原方案，未開工）、docs/integration/ledger-client-api.md、docs/86 §需求 3、docs/115
> **狀態**：⚠️ 有一項**硬阻塞**（本地缺契約 §4.5／§5.11 全文）＋ 一項**架構阻塞**（扣費／用券嘅寫入身份）。
>
> ---
> **📌 2026-09-11 17:28 更新 — 兩項阻塞均已解除，結論不變**
> Ledger 已發佈 v3.4 契約正本（`docs/integration/ledger-client-api.md`，1271 行，含 §4.5／§5.11），
> 並在交接文檔 §5 逐條回覆 `docs/121`。要點：
> - **§4.5.0 確認本文判斷**：扣費／核銷硬前提係 `is_merchant_staff`，與「掃碼抑或 Kiosk」無關。
> - **扣費路徑拍板**：掃碼 = **S3 降級**（顧客揀、收銀台代扣）；Kiosk = 用裝置現成店員 session 走既有 §5.7；
>   **S2（顧客自助扣款 RPC）Phase 1 不做**；**S1（掃碼場景託管店員 token）Phase 1 不認可**。
> - **PII 裁定**：`pos_orders` **只可存 Ledger `customer_id`（uuid）**，**不可存電話**（原本文中「存 `member_phone`」嘅設想已作廢）。
> - **立場修正**：平台會員掃別店碼**仍可登入**，該店餘額顯示 0，**唔應該 403「尚未成為本店會員」**
>   （原 §3.1／§6 參照 docs/110 §7.7 嘅「403 非本店會員」講法已作廢）。
> - 詳見 `docs/121` §0.1。

---

## 0. 結論速覽

| # | 功能 | 判定 | 一句話理由 |
|---|------|------|-----------|
| A | 顧客電話 + PIN **登入** | ✅ **可行**（需新 route） | HMAC 派生演算法完全可重用（`pin.server.ts`），只需繞開現有店員專屬 route 嘅 `merchant_staff` 403 |
| B | 讀**本店餘額／積分／卡包** | ✅ **可行**（需契約） | 交接文檔指明用**顧客 JWT** 直讀；伺服器已有 `createLedgerServerClient(token)` 可帶 JWT 查 Ledger |
| C | **扣費**（儲值餘額扣款） | ⚠️ **分場景** | Kiosk 有現成店員 session 可代扣；**掃碼（客人手機）打唔到寫入 RPC**，須等 S1 託管或 Ledger 出 S2 |
| D | **用券**（卡包核銷） | ⚠️ **分場景＋高風險** | 同上身份限制；且交接文檔明言「顧客 JWT 不能自己核銷」，券**無沖正**，一旦錯核銷無法回退 |

**一句總結**：你手上這份 v3.4 交接文檔**只覆蓋「登入 + 讀」，冇覆蓋「扣費 + 用券」**。扣費與用券在**掃碼場景目前無法用顧客身份實現**，必須先解決「誰有權扣錢」這個身份問題。

---

## 1. 為什麼先講「文檔覆蓋範圍」（最重要前提）

交接文檔自己的定位寫得很清楚（原文 §開頭）：

> **不是**：店員收銀台登入。**不是**：顧客在 POS 網域 `create_order`（仍契約外，另約）。

而原文 §3「禁止」明文列出：

| 禁止項（原文） | 直接後果 |
|---------------|---------|
| 「**顧客 session 打店員寫入**：`merchant_apply_pos_txn`、`list_merchant_customers` 等」 | 顧客 JWT **扣唔到費** |
| §2.3「**核銷**仍是店員 RPC（`redeem_reward`／`redeem_reward_grants`），**顧客 JWT 不能自己核銷**」 | 顧客 JWT **核銷唔到券** |

→ 即係：**文檔 §1–§2 給嘅係登入 + 讀取；扣費與用券被明確排除在顧客身份之外。**
交接文檔亦**冇**提出任何顧客端自我扣款 RPC（亦即 docs/110 §11 Q1 嘅 S2 方案），亦冇回答 docs/110 §11 嘅其餘四個缺口。

---

## 2. 判斷依據（逐項硬證據）

### 2.1 ✅（已解決）本地契約版本落後，§4.5／§5.11 不存在

> **2026-09-11 17:28 已解決**：Ledger 已提供 v3.4 契約正本，並已同步入庫
> （`docs/integration/ledger-client-api.md`，1271 行，md5 與對方一致）。
> 本節保留為**當時判斷記錄**，說明為什麼「先要文件」係正確嘅第一步。

事發時核對本地：

| 事實 | 證據 |
|------|------|
| `docs/pos-ledger-client-api.md` 只係 3 行搬遷指針 | 全文：`# 此文檔已搬遷` → 指向 `integration/ledger-client-api.md` |
| 真契約 `docs/integration/ledger-client-api.md` 日期 **9/1**，共 695 行 | `ls -la` 顯示 `Sep 1 12:00` |
| 契約**只到 §4.4 與 §5.9** | 章節索引：`4.4 Session 與登出` → `## 5. RPC 契約` → `5.6 / 5.7 / 5.8 / 5.9` → `## 6.` |
| 全文搜 `§4.5`／`§5.11`／`get_my_merchant_points`／`list_my_rewards`／`mode=customer` | **零命中** |

→ 交接文檔引用嘅兩節**在我方手上根本不存在**。文件自身亦標明「規格細節、錯誤字串、禁止項**以契約 §4.5／§5.11 為準**」。即係：**規格權威文件缺失，無法開工**。

**新舊契約差異（已核對）**：新版係舊版嘅**超集**，冇內容被刪。變動為——
① 新增 §4.5（顧客登入）、§5.11（顧客自讀）、§5.10（積分 v3.3）、§6.8（會員／券呼叫頻率）、§6.9（菜單／售罄 Realtime）；
② §5.6–§5.9 重編為 §5.6.1–§5.6.5、§5.7.1–§5.7.7；
③ §7.2／§7.3 加「Kiosk 雙 client」與「訂單歸因只可存 `customer_id`」；
④ §9 驗收清單由 14 項擴至 33 項。

### 2.2 既有可重用資產（好消息）

| 資產 | 位置 | 可重用度 |
|------|------|---------|
| PIN → Auth 密碼派生（HMAC-SHA256，pepper 只在 server） | `src/lib/ledger/pin.server.ts`（`import "server-only"`） | ✅ **完全可重用**，一字不改 |
| Auth email 組裝 | `src/lib/ledger/phone.ts` `ledgerAuthEmail()` | ✅ |
| 「帶 JWT 查 Ledger」嘅 server client | `src/lib/ledger/supabase-server-auth.ts` `createLedgerServerClient(accessToken)` | ✅ **正是顧客 JWT 讀取所需** |
| 會員錢包／積分／券嘅資料形別與解析 | `src/lib/ledger/member-types.ts` | ✅ 可重用 |
| 店員端扣款／核銷編排（先券後扣、`skipRedeem` 冪等保護） | `src/lib/ledger/checkout-member.ts` `executeLedgerMemberCheckout()` | ✅ **收銀台沿用，Kiosk 可借鏡** |
| 結帳會員 UI 範式（餘額面板＋券勾選＋扣款金額） | `src/components/pos-app.tsx` L6009–6160 | ✅ 可搬去 Kiosk |
| 落單入庫鏈路 | `src/lib/kiosk-order.ts` `submitKioskOrder()` → `POST /api/pos/sync` | ✅ 可擴充會員欄 |
| POS 終端憑證 | `src/lib/pos/pos-device-token.ts` `issuePosDeviceToken()` | ✅ Kiosk 已是可信終端 |

### 2.3 現有登入 route **唔可以照改**（交接文檔建議有風險）

交接文檔 §1 建議「**重用現有** `POST /api/ledger/login`，加 `mode:"customer"`」。核對實作，**不建議照做**：

| 事實 | 位置 |
|------|------|
| 完全冇 `mode` 參數（連 `mode=kiosk` 都唔係呢個 route 處理） | `src/app/api/ledger/login/route.ts` L52–54 |
| 簽入後**硬查** `merchant_staff`，查唔到即 `signOut` + 403 | 同上 L94–112 |
| 成功時**簽發 `posDeviceToken`**（店內終端憑證） | 同上 L155–159 |

⚠️ **風險**：若在同一個 route 內加 `mode=customer` 分支，一旦分支寫錯，可能令顧客拿到一張**簽咗名嘅店內終端憑證**（權限提升），或者污染收銀台嘅生命線登入。**建議另開新 route**（與 docs/110 §1.2 一致：「唔好改舊 route」）。

### 2.4 關鍵：兩種入口嘅「寫入身份」完全不同

這是扣費／用券能否成立的分水嶺。核對實作發現：

| | **Kiosk（`/order`，綁定平板）** | **掃碼（`/menu`、`/quick`，客人手機）** |
|---|---|---|
| 綁店方式 | `/login?mode=kiosk` 用**店員帳號**登入 → `saveKioskDeviceBinding()` | 靠 URL `?store=` / `?tableId=`，**冇任何登入** |
| 證據 | `src/components/login-screen.tsx` L96–124 | `src/lib/use-kiosk-order.ts` L249–267 |
| 裝置上有無**店員 Ledger session** | ✅ **有** —— 登入時 `setSession(ledgerAccessToken)` + `saveAuthSession()`，`ensureLedgerSession()` 會還原 | ❌ **冇** |
| 證據 | `login-screen.tsx` L141–149、`src/lib/ledger/session.ts` L13–42 | — |
| 有無 `posDeviceToken` | ✅ 有（落單帶 `posDeviceAuthHeaders()`） | ❌ 冇（匿名通道） |
| 證據 | `src/lib/kiosk-order.ts` L474 | `sync/route.ts` L294 `ANONYMOUS_ALLOWED_EVENTS` |

**推論**：

- **Kiosk** 部機本身就揸住一個**店員 session**，技術上可以直接打 `merchant_apply_pos_txn` / `redeem_reward_grants`（契約 §5.8 正是店員 RPC）。→ 扣費／用券**有路**，但要注意這是「用店員身份代扣」，且會落入契約 §7.3「共用 staff session 之 blast radius」嘅告警範圍。
- **掃碼** 客人手機**冇任何店員憑證**，顧客 JWT 又被明文禁止打寫入 RPC → **扣費／用券無路可走**，除非行 docs/110 §7.2 嘅 S1（POS server 託管店員 token）或等 Ledger 出 S2。

### 2.5 扣費要成立，仲差幾件「未做」嘅地基

| 缺口 | 證據 | 影響 |
|------|------|------|
| `/api/pos/sync` **唔核價**，直接信 client 傳來嘅 `total` | `sync/route.ts` L697/L701 `money(order.subtotal)` / `money(order.total)` | 扣費前必須 server 重算，否則可改 JS 扣少／扣多（docs/110 §7.6） |
| `pos_orders` **冇任何會員欄** | `baseRecord` 白名單 `sync/route.ts` L682–722（有 `payment_method`，**冇** `member_*`） | 商家認唔到「邊個落單」；且要面對 §7.2 PII 禁令 |
| 券**無沖正** | 契約 §5.8「`p_type="add"` 禁用」；docs/110 §7.4 | 自助核銷一旦出錯**無法回退**，風險高於餘額 |
| 兩個 Supabase client 必須分開 | `supabase-client.ts` 係**單例**（L5 模組級變數）；`members.ts` / `rewards.ts` 都靠 `requireRpcClient()` 取**店員** session | 顧客 `setSession` 會**頂走**店員 session（docs/110 §3.2） |
| 顧客端 RPC 一格都冇 | 全 repo 搜 `get_my_merchant_points`／`list_my_rewards` 零命中 | 全部要新接 |

---

## 3. 逐項可行性判定

### 3.1 登入 ✅ 可行（有前提）

- **可行依據**：派生演算法可重用；只需一支新 route（收 `{phone, pin, storeId}` → `deriveLedgerAuthPassword` → `signInWithPassword` → 回顧客 session）。勿查 `merchant_staff`。
- **前提**：① 契約 §4.5 全文；② 確認 `merchantId`（Kiosk 取綁定店；掃碼取 `?store=`）如何驗「呢個人係唔係呢間店嘅會員」——交接文檔**冇**講呢步（docs/110 §7.7 原本靠商戶通道 `merchant_lookup_customer_wallet` 驗證，但顧客 JWT 打唔到）。
- **已知失敗場景**（交接文檔 §1）：未在會員通設過 PIN 嘅會員（含 `ensure-customer` 代建、`pin_set=false`）→ **登入必定失敗**，要引導去會員通 `/wallet/login` 自設。

### 3.2 讀餘額／積分／卡包 ✅ 可行（有前提）

- **可行依據**：交接文檔指明用**顧客 JWT**，`user.id = session.user.id`。
  - 餘額：`ledger.from("wallets").select(...).eq("customer_id", user.id).eq("merchant_id", merchantId)` — **表直讀**，靠 RLS 限自己嗰行。
  - 積分：`rpc("get_my_merchant_points", { p_merchant_id })`
  - 卡包：`rpc("list_my_rewards", { p_merchant_id })`
- **前提**：上述 RPC 與 `wallets` 嘅**顧客端 RLS 存在且正確**（我方無法自證，須 Ledger 確認）＋ 新 route 需用獨立 client（見 3.4 前提）。
- **口徑注意**：`balance_avos` 已係 paid + gift 合計，**唔可以**再加 `gift_balance_avos`（契約 §5.7 同款告誡）。`points_balance` 係 avos 但**唔係錢**，唔可折現、唔可當現金扣（交接文檔 §2.2）。

### 3.3 扣費 ⚠️ 分場景

| 場景 | 判定 | 路徑 |
|------|------|------|
| **Kiosk（`/order`）** | ⚠️ **技術可行，需決策** | 用裝置現成店員 session 打 `merchant_apply_pos_txn(p_type:"deduct")`；或照 docs/110 §7.2 S1 用**專用低權限帳號** |
| **掃碼（`/menu`、`/quick`）** | ❌ **目前不可行** | 客人手機無店員憑證；顧客 JWT 被禁打寫入 RPC → 須等 S1（server 託管 token）或 S2（Ledger 新 RPC） |

- **必須先解決**：① server 端核價；② 冪等鍵由 server 生成（`self-deduct:{orderId}:{totalAvos}`）；③ 落單後鎖單（`member_deduct_avos > 0` 唔准加單）；④ 扣款成功先標 `paid`（Kiosk）。
- **建議 v1 只做全額抵扣**（`balance >= total` 才准扣），唔做部分抵扣／混合支付（docs/110 §7.3）。
- **降級方案（完全可行、零 Ledger 依賴）**：掃碼單繼續落 `draft`，**會員身份與所選券一併上報**，由**收銀台店員**在確認時用**現成** `executeLedgerMemberCheckout()` 核銷＋扣款。即「顧客選，店員扣」。

### 3.4 用券（核銷）⚠️ 分場景＋高風險

- 交接文檔 §2.3 明文：**顧客 JWT 不能自己核銷**。故與扣費同構：Kiosk 有店員 session 才「有可能」；掃碼無路。
- **額外風險（比扣費更高）**：券核銷**冇沖正**。一旦客人自助核銷成功而落單／付款失敗，券就燒咗，只能人手介入。
- **建議**：v1 **唔做自助核銷**（與 docs/110 §N3「優惠券自助核銷留 P2」一致），先做「掃碼顯示卡包／預選券 ＋ 收銀台代核銷」。

---

## 4. 技術限制（匯總）

1. **身份斷層（最核心）**：`merchant_apply_pos_txn` / `redeem_reward_grants` 需 `is_merchant_staff`；顧客 JWT 被禁；掃碼裝置無店員 session。
2. **雙 client 衝突**：`getLedgerSupabaseClient()` 係單例且服務店員 session，顧客 `setSession` 會頂走店員 session → 必須另建 `getMemberSupabaseClient()`（`persistSession:false`、`autoRefreshToken:false`），兩者永不互相 `setSession`。
3. **server 未核價**：`sync` 信 client `total`，扣費前必須由 `pos_orders` 讀回重算。
4. **資料模型缺口**：`PosOrder` 與 `pos_orders` 均無會員欄；`sync` 白名單、mapper 未收。
5. **狀態機守門**：匿名寫入**改唔到**既有單狀態（`sync/route.ts` L600 `writeStatus`），故「扣款後標 paid」要經**授權通道**或**新 server route（service_role）**完成，唔可以靠匿名 client 自己改。
6. **限流不足**：現有只有 IP 10 次/60s；4 位 PIN 只有 1 萬組合 → 必須加「電話號碼」維度限流（建議 5 次/15 分，跨 IP）。
7. **契約缺口**：本地無 §4.5／§5.11，規格權威缺失。
8. **UAT／正式不可混**：pepper 與 Ledger URL 必須成對，`LEDGER_INTEGRATION_BASE_URL` 預設值係 UAT。

---

## 5. 業務限制（匯總）

1. **存量會員可能未設 PIN**：`ensure-customer` 代建者 `pin_set=false`，登入必敗 → 需引導去會員通設 PIN，影響功能覆蓋率。
2. **積分不可折現**、不可當現金扣款、不可跨店；兌換積分 P2 未開放 → 「扣費」只能扣**儲值餘額**。
3. **券無沖正** → 自助核銷一旦出錯無法回退。
4. **PII 落地爭議**：契約 §7.2 禁寫顧客電話入 POS DB；docs/110 §6.2 卻要求 `pos_orders.member_phone`。兩者**直接衝突**，需書面決定（豁免 or 只存 hash／customer_id）。docs/110 §11 Q2 早有此問，交接文檔**未答**。
5. **報表口徑不可動**：自助扣款係「預付收款方式」而**非折扣**，營業額照計 `total`（docs/110 §7.11）。
6. **掃碼單本質要收銀確認**：手機端付款成功 ≠ 商戶確認；Kiosk（店內可信）才適合直接 `paid`。
7. **共用機私隱**：Kiosk 係共用平板，會員 session 必須 `sessionStorage`＋記憶體、逾時／落單完成即清，禁 `localStorage`。

---

## 6. 必須確認／補充嘅前提條件（按優先級）

> **2026-09-11 17:28 狀態：P0 三項已全部回覆、P1 六項亦已回覆。** 以下保留原始問題以便追溯，答案見「現況」欄。

### P0 — 已回覆 ✅

| # | 問題 | 現況（Ledger 回覆） |
|---|------|-------------------|
| **Q1** | 提供契約 **§4.5、§5.11 全文**（及 §9 v3.4 驗收清單） | ✅ **已提供並入庫**：`docs/integration/ledger-client-api.md` v3.4（1271 行）；§9 驗收清單由 14 項擴至 33 項 |
| **Q2** | **扣費／核銷走邊條路**？(a) S2 顧客端 RPC；(b) S1 POS 託管憑證；(c) 店員代扣 | ✅ **已拍板**：掃碼 = **(c) S3 降級**（顧客揀、收銀台代扣）；Kiosk = 用裝置現成**店員 session** 走既有 §5.7；**S2 Phase 1 不做**；**S1 掃碼場景 Phase 1 不認可** |
| **Q3** | `pos_orders` 寫入 `member_phone`／會員身份，是否抵觸 §7.2 PII 禁令？ | ✅ **已裁定**：**只可存 Ledger `customer_id`（uuid）**，**不可存電話**（§5.11 開頭 + §7.2）。→ 原 docs/110 §6.2 嘅 `member_phone` 設想**作廢** |

### P1 — 已回覆 ✅

| # | 問題 | 現況（Ledger 回覆） |
|---|------|-------------------|
| Q4 | `wallets` 對顧客 JWT 嘅 RLS 具體條件 | ✅ 顧客可 SELECT **本人**列；**必帶** `customer_id = auth.uid()` **與** `merchant_id`；**無列 = 餘額 0** |
| Q5 | `get_my_*` 嘅簽章與回傳 | ✅ §5.11.2／§5.11.3 已列；另有可選 `list_my_point_ledger`、`get_my_reward_grant` |
| Q6 | 顧客同店員是否真共用 namespace？ | ✅ **確認共用**（同一 `@phone.macau-ledger.app` + 同一 pepper）。店員用掃碼頁登入**合法**，POS 只需**唔當佢係收銀台 session**（**無需**拒絕；docs/110 §7.7 嘅「反向檢查拒絕」作廢） |
| Q7 | 券自助核銷可否開放 | ✅ **不開放**；核銷仍為店員 §5.7.4／§5.7.5。Kiosk 技術上可（有店員 session）但券**無沖正**，建議 P2 |
| Q8 | 扣款流水命名空間 | ✅ S2 不做故無新流水；店員 deduct 沿用 §5.7.1，Ledger `transactions.note` = 「商家扣點」；**Phase 1 不寫 `p_reference`** |
| Q9 | 冪等鍵重用語義 | ✅ 沿用 §5.7.1 既有 `p_idempotency_key`（**無** `'order-deduct:' \|\| key` 前綴，與線上單 `accept_order_with_deduct` **不同**） |

### 6.1 新回覆揭示嘅設計修正（**必改**）

1. **唔應該 403「尚未成為本店會員」** —— 平台會員掃**別店**碼仍然可以登入，該店餘額顯示 0、卡包可能空。
   → 原 §3.1／§3.2／§6 參照 docs/110 §7.7 嘅「403 非本店會員」講法**作廢**。
2. **`pos_orders` 欄位由 `member_phone` 改為 `member_customer_id`（uuid）** ——（可另加 `member_deduct_avos`／`member_deduct_txn_id`）。
   商家端要「認得邊個落單」就只能靠 customer_id；要顯示姓名必須即時向 Ledger 查。
3. **`display_name` 來源 = `profiles.display_name`**（顧客登入後 select 本人 profiles）——**僅供當次畫面**，不得落地。
4. **未設 PIN 冇獨立錯誤碼** —— Auth 無法穩定區分「無帳號／未設 PIN／PIN 錯」，統一「密碼錯誤」，只能靠**文案**引導去 `/wallet/login`。
5. **Session**：access token 約 1 小時，用 refresh_token 續期；**續期失敗即當登出**。
6. **Kiosk 雙 client 係硬性要求** —— 契約 §7.3 明文：顧客 `setSession` 不得打店員單例；否則整台機失去 §5.7 寫入權，或反過來把店員權限暴露給顧客頁。
7. **冇 Webhook** —— §8 Phase 1 明確不做；同步 RPC 回傳即結果（我方原本判斷獲確認）。
8. **會員／券一律無 Realtime、無 polling** —— §6.8 給出每場景上限（單次結帳：lookup ≤1、`list_redeemable` ≤1、`redeem_reward_grants` ≤1、`merchant_apply_pos_txn` ≤1）。

### P2 — 落地細節

- 專用「自助點餐」店員帳號（若走 S1）：權限只配 `staff`、可一鍵撤銷、token 加密存放（`pgcrypto` 或 AES-GCM）、輪換失敗告警。
- 會員 session 逾時策略（Kiosk 閒置 1 分鐘 + 登入後 15 分鐘）。
- 是否有現成「掃碼頁顯示卡包」需求（P2 用券前置）。

---

## 7. 建議分期

> **2026-09-11 17:28 更新**：Q1–Q3 已有答案，**P0 與 P1.5 已無外部阻塞，可以開工**。
> P1（Kiosk 扣費）亦已無 Ledger 依賴（走既有 §5.7 + 裝置店員 session），只餘內部實作（server 核價、鎖單、限流）。

| 階段 | 內容 | 外部依賴 | 現況 |
|------|------|---------|------|
| **P0** | **登入 + 自讀**：新 member login route、`getMemberSupabaseClient`、session 管理、`MemberLoginSheet`、顯示餘額／積分／卡包（唯讀）。掃碼與 Kiosk 皆可。 | 契約 §4.5／§5.11 | ✅ **可開工** |
| **P0.5** | `pos_orders` 會員欄（**只存 `member_customer_id`**）+ sync 白名單 + mapper + 收銀台單卡顯示「會員徽章」 | Q3 已答 | ✅ **可開工** |
| **P1** | **Kiosk 扣費**：用裝置店員 session 走 §5.7（全額）＋ server 核價 ＋ 鎖單 ＋ 冪等 ＋ 限流 | 無（§5.7 既有） | ✅ **可開工** |
| **P1.5** | **掃碼「顧客揀、收銀台店員代扣／代核銷」**（= 契約 §4.5.0 指定嘅 v1 做法，用現成 `executeLedgerMemberCheckout`） | 無 | ✅ **可開工** |
| **P2** | 掃碼真自助扣費（需 Ledger 出 S2 `customer_self_deduct`）、券自助核銷、部分抵扣／混合支付、積分兌換、會員價 | Ledger 新 RPC（§5.10.4 預告） | ⏸ 待 Ledger 排期 |

---

## 8. 與 docs/110 嘅關係

- docs/110（2026-09-08）係**方案**，而本檔（2026-09-11）係**對住 v3.4 交接文檔嘅可行性回覆**。
- 交接文檔**只回應咗 docs/110 §11 嘅一部分**（提供了「顧客讀取」路徑 §5.11），但：
  - **未回答** Q1（有無 S2）——只係明文禁止顧客打寫入 RPC，變相要行 S1；
  - **未回答** Q2（PII 落地）——反而 §3 更加收緊；
  - **未回答** Q4／Q5。
- docs/110 §3.2「兩個 client 必須分開」、§7.1「單先落錢後扣」、§7.4「扣款即鎖單」、§7.5「冪等鍵」、§7.6「server 核價」、§7.9「session 生命週期」、§7.10「限流」、§7.11「報表口徑」——**全部仍然有效**，可直接沿用。

---

## 9. 可複用範圍（按入口逐項）

> 回答：「掃碼同 Kiosk 分別可否照搬 POS 現有嘅扣費／扣券實作？」

**唯一判斷規則**：POS 現有嘅扣費／扣券實作
（`checkout-member.ts` → `members.ts` / `rewards.ts` → `getLedgerSupabaseClient()`）
**硬前提係「呢部裝置有店員 Ledger session」**（`ensureLedgerSession()`）。
所以能唔能照搬，**只取決於該入口有無店員 session，同係掃碼抑或 Kiosk 無關**。

| 項目 | 掃碼（客人手機） | Kiosk（綁定平板） | 可否照搬 POS 現有實作 |
|------|----------------|------------------|---------------------|
| **登入** | ✅ 可行 | ✅ 可行（做法與掃碼**完全相同**） | ❌ 唔關事 —— 屬於**新增**嘅顧客 JWT 通道 |
| **扣費** | ❌ 顧客自助不可行 | ⚠️ 技術可行 | Kiosk ✅ ／ 掃碼 ❌ |
| **扣券** | ❌ 顧客自助不可行 | ⚠️ 技術可行但風險高 | Kiosk ✅（建議後置）／ 掃碼 ❌ |

### 逐項說明

- **登入（掃碼 + Kiosk 一樣）**：兩邊都係「新開 member route + 顧客 JWT」，**同 POS 現有店員登入無關**，唔存在「照搬」問題。Kiosk 唔會因為係店內機而有優待，掃碼亦唔會因為係客人手機而做唔到。唯一前置：契約 §4.5／§5.11 全文。

- **掃碼扣費／扣券 = 唔可行**，而且呢個**唔係做法問題，係身份問題**：
  客人手機冇店員 session → 就算把 `executeLedgerMemberCheckout` 原封不動搬過去，`merchant_apply_pos_txn` / `redeem_reward_grants` 一樣會被 RLS 拒。
  → **唯一可行**：降級為「**顧客揀，店員在收銀台代做**」。此時用返收銀台原本嗰套（`executeLedgerMemberCheckout`），**零改動**。

- **Kiosk 扣費 = 可行，但做法同掃碼唔同**：靠 **Kiosk 裝置自己嘅店員 session**（綁機時 `/login?mode=kiosk` 已經簽入）。三個要點：
  1. **唔可以**用同一個 `getLedgerSupabaseClient()` 實例畀顧客 `setSession`（會頂走店員 session）→ 顧客側必須另建 `getMemberSupabaseClient()`。
  2. 建議照 docs/110 §7.2 另設**專用低權限 `staff` 帳號**，唔好直接用綁機嘅 owner 帳號（契約 §7.3 blast radius）。
  3. 唔可以信 client 傳嚟嘅 `total`（`/api/pos/sync` 現時唔核價），扣費前必須 server 重算。

- **Kiosk 扣券**：技術上做得到，但券**無沖正**，建議同 docs/110 §N3 一樣排 P2，v1 先由收銀台代核銷。

### 一句總結

> **登入：掃碼同 Kiosk 完全一樣，都做得到。**
> **扣費／扣券：Kiosk 因為部機本身揸住店員 session 而做得到；掃碼做唔到，只能交返收銀台代做。**

---

## 附：一句話總結

> **登入讀取無問題，扣費用券卡在身份。**
> 交接文檔給了你「顧客能讀自己錢包」的鑰匙，但**沒有**給「顧客能動自己錢包」的鑰匙；
> 而掃碼場景連店員 session 都沒有。**先向 Ledger 拿 §4.5／§5.11，並拍板 Q2（扣費走哪條路），否則 P1 之後都唔使開工。**
