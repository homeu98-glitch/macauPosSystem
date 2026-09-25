> 📥 **歸檔（2026-09-25）**：Ledger 於 2026-09-24 發出之契約原件，逐字保存。
> POS 側審視、要 Ledger 修嘅 5 處出入、實作方案 → [`pos-offline-report-contract-review-2026-09-25.md`](./pos-offline-report-contract-review-2026-09-25.md)。
> 🔴 未收到 Ledger 回覆前 **唔好照本文實作**（時間腿、`breakdown.dineIn/quick`、以及「用 94 `build_full_report()`」三處已知會出錯）。

# 給 macauPosSystem 的線下營業摘要 API 契約 v1（可直接轉貼）

> **對象**：[homeu98-glitch/macauPosSystem](https://github.com/homeu98-glitch/macauPosSystem)  
> **日期**：2026-09-24  
> **方向**：**Ledger 伺服器 → POS Vercel**（與 v3.x 相反；POS 是被呼叫方）  
> **決策**：[ADR-040](../adr/ADR-040-pos-offline-report.md)  
> **取代**：POS `docs/83`／`docs/94`「Ledger 直連 POS DB」與 2026-09-04 回覆之「日快照推送」——兩者**皆不做**。  
> **不是**：Ledger 連 POS Supabase；**不是** POS 推資料進 Ledger；**不是**訂單明細／顧客個資；**不是** polling。

請把本檔交給 POS Agent。POS 只需新增**一支唯讀 GET route**。

---

## 一句話

商戶在會員通 `/merchant/reports` 開報表時，Ledger 伺服器**按需**帶 HMAC 打 POS 一次，取回該店該區間的**線下 KPI 聚合**，與線上數字**並排顯示、不加總**。POS 資料留在 POS；Ledger 不落地、不快取跨 session。

---

## 環境（私下交換，勿進前端 bundle／勿進 git）

| 變數 | 誰持有 | 說明 |
|------|--------|------|
| `LEDGER_OFFLINE_REPORT_HMAC_SECRET` | POS 伺服器 + Ledger 伺服器 | 由 Ledger 產生（≥32 hex）；**與** `LEDGER_WEBHOOK_SECRET`、`POS_SCAN_DEBIT_SECRET`、`AUTH_PIN_PEPPER` **分開** |

Ledger 側對應 env：`POS_OFFLINE_REPORT_BASE_URL=https://macau-pos-system.vercel.app`、`POS_OFFLINE_REPORT_HMAC_SECRET`。

**UAT**：Joe 無 UAT POS。UAT Ledger 會以**同一支 route、同一把 secret**（或另發一把）打**正式 POS**，`storeId` 由 UAT 端對照表映到 Joe 指定的 1 個正式測試店。**唯讀**，不寫 POS。

---

## Route（POS 實作）

```text
GET {POS_ORIGIN}/api/integration/ledger/offline-report?storeId=<uuid>&from=YYYY-MM-DD&to=YYYY-MM-DD
```

### 請求 Header

```text
X-Ledger-Timestamp: <unix 秒>
X-Ledger-Signature: HMAC-SHA256(secret, timestamp + "." + "GET" + "." + pathWithQuery).hex
Accept: application/json
```

`pathWithQuery` ＝ **收到的原始** `request.nextUrl.pathname + request.nextUrl.search`，例：

```text
/api/integration/ledger/offline-report?storeId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb&from=2026-09-01&to=2026-09-24
```

Ledger 固定以 `storeId, from, to` 順序組 query；POS **不要**重排、不要 decode 後再 encode，直接拿原字串驗。

### 驗證順序（POS 端）

1. 時戳容差 **5 分鐘**（秒或毫秒皆接受）。
2. `timingSafeEqual` 比對簽章；失敗 → **401** `{ "error": "unauthorized" }`。
3. `storeId` 須為 UUID；`from`/`to` 為 `YYYY-MM-DD`；`from ≤ to`；否則 **400**。
4. 區間 > **90 日**（含首尾兩天計算：`to - from ≥ 90`）→ **截斷**：保留 `to`，`from = to − 89 日`（即最近 90 個日曆日），回 `flags.clamped=true`，**不要**回錯。Ledger 會核對：`to` 必須等於請求值；`from` 等於請求值且 `clamped=false`，或 `clamped=true` 且 `from` **恰等於** `to − 89 日`（且請求確實超限），否則整包丟棄。
5. `storeId` 從未出現在 `pos_orders` → **404** `{ "error": "store_not_found" }`（Ledger 顯示「本店尚未啟用店內系統」）。
6. 限流：每 `storeId` 每分鐘 ≤ 30 次即可（Ledger 有 session cache，正常一次進頁一次）。

### 回應 200（JSON）

```json
{
  "v": 1,
  "storeId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "from": "2026-09-01",
  "to": "2026-09-24",
  "generatedAt": "2026-09-24T08:00:00.000Z",
  "kpi": {
    "orderCount": 12,
    "revenueAvos": 123450,
    "refundedAvos": 0,
    "discountAvos": 500,
    "covers": 30
  },
  "breakdown": {
    "dineIn": { "orderCount": 8, "revenueAvos": 100000 },
    "quick": { "orderCount": 4, "revenueAvos": 23450 },
    "byPayment": [{ "method": "cash", "amountAvos": 123450 }]
  },
  "flags": { "refundsNetted": false, "clamped": false }
}
```

| 欄位 | 必填 | 說明 |
|------|------|------|
| `v` | ✅ | 固定 `1` |
| `storeId` | ✅ | 回傳請求的 `storeId`（小寫 UUID） |
| `from`／`to` | ✅ | 實際計算區間（`clamped` 時 `from` 已推後） |
| `generatedAt` | ✅ | **RFC 3339 含時間與時區**（`2026-09-24T08:00:00.000Z` 或 `…T16:00:00+08:00`）；純日期或無時區字串會被拒。Ledger 顯示「店內系統資料截至 …」（澳門時間） |
| `kpi.orderCount` | ✅ | 計入單數 |
| `kpi.revenueAvos` | ✅ | **avos 整數**（1 MOP = 100 avos）；gross |
| `kpi.refundedAvos` | 選 | 已退款；POS 未上雲時省略或 `0` |
| `kpi.discountAvos` | 選 | 折扣合計 |
| `kpi.covers` | 選 | 用餐人數（`party_size` 加總＋快餐每單 1）；無則 `null`／省略 |
| `breakdown.dineIn`／`quick` | 選 | 各 `{orderCount, revenueAvos}`；無則 `null`／省略 |
| `breakdown.byPayment[]` | 選 | `{method, amountAvos}`；`method` 1–32 字（超過整包拒） |
| `flags.refundsNetted` | 選 | boolean；`true`＝`revenueAvos` 已扣退款；**省略鍵**＝`false`（Ledger 標「未扣退款」）。**有值（含 `null`）但非 boolean 整包拒** |
| `flags.clamped` | 選 | boolean；區間被截斷；同上規則 |

**金額一律 avos 整數（`Number.isSafeInteger`）、非負。** `from ≤ to` 且須為合法日曆日。任何欄位型別不符 Ledger 會整包丟棄並顯示「暫時無法取得」，**不會**渲染假零。

### 口徑（必須遵守）

| 規則 | 說明 |
|------|------|
| 計入 | `pos_orders.status ∈ {settled, paid}`；`refunded`／`partially_refunded` 不計入 gross（與 POS `/reports` `isSaleCountable` 一致） |
| **排除線上投影** | **`online_order_id IS NOT NULL` 的單一律排除**——那是會員通線上單在 POS 的投影，Ledger 已從自己的 `orders` 計算；不排除會算兩次 |
| 時間 | `settled_at`（缺則 `updated_at`）落在 `[from 00:00, to 23:59:59.999]` **`Asia/Macau`** |
| 單位 | POS 若以 MOP 小數或「分」存，回傳前換成 avos 整數 |

建議直接用 POS 已寫好的 `docs/sql/94-ledger-report-api.sql` 的 `build_full_report()` 聚合（先在 Dashboard 執行；用 `security definer` + service_role 呼叫即可，**不需** 83 的 `ledger_report_ro` 角色），再映射到上表。

---

## 驗簽參考實作（Node）

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyLedgerOfflineReport(req: Request, secret: string): boolean {
  const ts = req.headers.get("x-ledger-timestamp") ?? "";
  const sig = req.headers.get("x-ledger-signature") ?? "";
  const n = Number(ts);
  const ms = n < 1_000_000_000_000 ? n * 1000 : n;
  if (!Number.isFinite(ms) || Math.abs(Date.now() - ms) > 300_000) return false;
  if (!/^[0-9a-f]{64}$/i.test(sig)) return false; // Buffer.from(hex) 會靜默截斷壞尾碼，先擋長度
  const url = new URL(req.url);
  const expected = createHmac("sha256", secret)
    .update(`${ts}.GET.${url.pathname}${url.search}`)
    .digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
  } catch {
    return false;
  }
}
```

Ledger 端簽章程式：`src/lib/pos-offline-report-core.ts` `signPosOfflineReportRequest()`。

---

## 成本與行為（雙方）

| 項目 | 說明 |
|------|------|
| 頻率 | 商戶**進報表 Tab／換區間**各一次；Ledger session cache 內不重打；**無 timer**。POS 端可選 60s 記憶體快取 per (storeId, range) |
| Ledger Vercel | 併進既有報表 Server Action，**零新增** invocation |
| POS Vercel | 每次報表載入 +1 |
| 超時 | Ledger 3 秒放棄，線下卡顯示「暫時無法取得」，線上不受影響 |
| 資料留存 | Ledger **不**寫 DB、**不**寫 localStorage；只在該次 session 記憶體 |

---

## 驗收清單

- [ ] 錯 secret／過期時戳 → 401；缺 `storeId` → 400
- [ ] 未知 `storeId` → 404
- [ ] 正式測試店今日：`kpi.revenueAvos`／`orderCount` 與 POS `/reports` 同區間**線下**數一致
- [ ] 有線上單的日子：`online_order_id` 非空的單**不**計入
- [ ] 請求 `from=2026-01-01&to=2026-09-24` → `clamped=true`、`from=2026-06-27`（to − 89 日）、`to` 不變
- [ ] `generatedAt` 帶 `Z` 或 `+08:00`；簽章為 64 hex
- [ ] 回應全部金額為整數 avos

---

## 要 Joe 回覆的三件事

1. 一個正式測試店 `store_id`（＝Ledger `merchants.id`）給 UAT 對照。
2. `pos_orders.total` 現在的單位（MOP 小數？整數 avos？）。
3. secret 交換方式（Ledger 產生後私訊；不進 git、不進 issue）。
