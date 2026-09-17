# 回覆：中繼機（Sunmi）清單逐條確認

> 回覆日期：**2026-09-17 11:40（澳門）**
> 我方版本錨點：`main` @ **`bffd352`**（commit 09-17 10:43 +08）
> 正式站部署：Vercel **Production `bffd352`**（deployment created 09-17 10:44:09 +08，commit status = success）
> 相關文檔：`docs/integration/print-relay-hardening-brief.md` §8、`docs/integration/print-relay-device-config-runbook.md`

---

## 0. 先更正三處前提（會影響你們後面所有判斷）

| # | 你們的前提 | 事實 |
|---|---|---|
| 0.1 | 「我們剛 pull 的 `main`（`b910a76`）」 | **`b910a76` 唔係最新 main。** GitHub `main` HEAD = `bffd352`（09-17 10:43），你們**落後一個 commit**，而 `bffd352` 正好就係帶 agent 憑證通道嘅 commit。→ 請重新 pull。 |
| 0.2 | 「最新 repo 的 `device-config/route.ts` **只有** `posRouteAuthGuard`，**沒有** verifyAgent 雙路徑」 | **已過時。** `bffd352` 嘅 `src/app/api/pos/device-config/route.ts:45-54` 就係 `readAgentHeaders` + `verifyAgent` + 綁店檢查；而且**正式站已部署 `bffd352`**。 |
| 0.3 | 「帶假 token 仍回 401「需要 POS 終端憑證」⇒ 證明 agent 路徑未上」 | 🔴 **這個推論無效 —— 假 token 在「已部署」和「未部署」兩種情況下回應完全一樣。**<br>流程：`verifyAgent()` 驗不過 ⇒ `viaAgent = false` ⇒ 落返 `posRouteAuthGuard()` ⇒ 401「需要 POS 終端憑證」。<br>⇒ **必須用一組現役有效憑證才分得出**（R2 應 200、R3 跨店應 401）。 |

---

## 1. `device-config` 何時支援 agent 憑證？

**✅ 已支援，且已在正式站生效（`bffd352`，09-17 10:44 部署完成）。**

實作位置與契約（`src/app/api/pos/device-config/route.ts:45-54`）：

```ts
const { agentId, token } = readAgentHeaders(request);           // x-agent-id / x-agent-token
const agent = agentId && token ? await verifyAgent(agentId, token) : null;
const viaAgent = Boolean(agent && agent.storeId === storeId);   // 🔴 綁店
if (!viaAgent) {
  const denied = posRouteAuthGuard(request, storeId, "pos/device-config");
  if (denied) return denied;
}
```

| 你們的提問 | 答覆 |
|---|---|
| 何時 deploy 到正式？ | **已經 deploy**（`bffd352`，Production，09-17 10:44:09 +08）。 |
| 契約是否 `x-agent-id` + `x-agent-token`，且 `agent.storeId === storeId` 否則 401？ | **是**，完全正確。`verifyAgent()` 另外驗 `revoked_at is null` + `sha256(token) === token_hash`（`src/lib/print-agent-server.ts:84-90`）。 |
| 可否提供測試用 agentId/token？ | 🔴 **做不到。** server 只存 `sha256`（`pos_print_agents.token_hash`），**明文 token 連我們也讀不到**（設計如此，配對時只交一次）。<br>✅ 替代做法（建議）：**你們自己 pair 一次**，用自己嘅 `agentId`/`token` 跑 `tools/verify-relay-agent.cjs` 驗 R1–R4（憑證走環境變數，唔落 shell history）。<br>或：現場 pair 之後，把 `agentId` 給我們，我們可以**代跑 R1/R3（跨店）**，但 R2 仍要你們側持有 token 才跑得到。 |
| 額外一個限制（最小權限） | `viaAgent === true` 時，回應嘅 **`localSettings` 一律為 `null`**（只回 `deviceConfig.printers`），因為 `local_settings.printZones` 係 KDS 分區權威來源。已核對兩個中繼 App 都只用 `deviceConfig.printers` —— **你們不需改**。 |

**你們的承諾（`fetchDeviceConfig` / `unpair` 帶齊 agent header、不走 `/api/ledger/login`、不存 PIN）—— 我方確認：這正是我們期望嘅方向。** 但 ⚠️ **`unpair` 有一個實質 bug，見第 9 條。**

---

## 2. 部署順序

**書面確認：**

- ✅ **先 server（已完成）**，後 APK。⇒ **你們現在可以推 merchant APK。**
- ⚠️ **「不要重啟中繼機」在 APK 更新之前仍然有效**。理由不變：未升級嘅 APK 拉 `device-config` 會 401 ⇒ `RelayState.deviceConfigPrinters`（**純記憶體**）在重啟後歸零 ⇒ 多打印機嘅店可能**印錯機**（唔會停印，但錯係靜默嘅）。**APK 更新 + R5/R6 通過之後，重啟就安全。**
- 🔴 **回滾指引（重要）**：如果 APK 更新出事，**唔好去改 `POS_REQUIRE_DEVICE_AUTH`** —— 那粒制會把**全部**閘一齊打開（等於整輪加固報廢）。正確做法＝**回退該次 Vercel deployment**。

---

## 3. 中繼用哪套憑證（理解一致確認）

| 用途 | 憑證 | Sunmi 要不要 |
|---|---|---|
| iPad 收銀／設定頁 | `Authorization: Bearer`（12h，`/api/ledger/login` → `posDeviceToken`） | **不要** |
| 中繼 claim / heartbeat / result | `x-agent-id` + `x-agent-token` | **要**（已有） |
| 中繼讀 `device-config` | 同上 agent header | **要**（server 已支援，APK 待補） |
| 中繼 `unpair` 自證 | 同上 agent header | **要**（但目前 APK 傳空 token ⇒ 會 401，見第 9 條） |

**明確回答那一句：**

> 「中繼不需要也不應該為過閘去登入 POS 拿 `posDeviceToken`，對嗎？」

**✅ 對。** 而且我們**刻意**設計成這樣：

1. 我方 brief §2 曾提過「方案 B：APK 去 `/api/ledger/login` 換 POS 憑證」。**該方案已被取代** —— 現在走 agent 憑證通道，APK **唔需要**登入 Ledger、**唔需要**存 PIN、**唔需要**處理 12h TTL 續期。
2. 只有 agent 憑證通道才能在 `POS_REQUIRE_DEVICE_AUTH` 開關切換時保持穩定（agent token 無 TTL）。
3. 反之，如果中繼去拿 `posDeviceToken`，**12h 一過就要續期**，續期失敗＝全店停印 —— 唔值得。

---

## 4. `POST /api/pos/print-agent/pair` 還要開多久？

**現況確認（你們係對嘅）：** 匿名 `POST /pair` 仍可自註冊，**401 還沒上**。

**但請注意：不是「只驗 storeId 是否存在」那麼寬鬆**（`pair/route.ts`）：

- `storeId` 必須符合 `/^[A-Za-z0-9_-]+$/` 且 ≤ 64 字元（`:122`）
- **假店黑名單**（`macau-store-a` 之類）→ 400（`:127`）
- **必須對應真實商戶**：查 `merchants` 表，查唔到 → 400「storeId 唔對應任何商戶」（`:139-149`）

⇒ 攻擊者需要**知道一個真實 merchantId**（而 merchantId 是公開值：枱 QR `/menu?tableId=…&store=<merchantId>`）。

**時間表：**

- 短期：**維持現狀**。
- 方案 A（一次性配對碼）／方案 B（APK 帶 POS 憑證）：**尚未排期**。
  - 補充：方案 B 現在**不必要**了（agent 憑證通道已取代它）；方案 A 才會是首選。
- 🔴 **若日後上鎖 `pair`，你們需要提前幾版 APK？** 我們的建議：**1 版**。做法＝雙軌過渡期（新 APK 支援短碼，舊 APK 仍可匿名 pair 一段時間），我方會**先出書面通知 + 過渡期長度**才動手。**不會突然上鎖。**

---

## 5. `POS_REQUIRE_DEVICE_AUTH` 現在是什麼？

**今天 11:30（澳門）實測（匿名零憑證，`tools/_probe-auth-state-20260917.cjs`）：**

| 端點 | 結果 |
|---|---|
| `GET /api/pos/state` | **401** |
| `GET /api/pos/device-config` | **401** |
| `GET /api/pos/print-jobs/status` | **401** |
| `GET /api/pos/orders` | **401** |
| `POST /api/pos/device-token`（假 token） | 401「Ledger 會話已失效」**（唔係 503）** |

**答覆：**

- ✅ **肯定不是 `0`。** `0` 的定義是「全部 route 匿名放行」——實測全部 401，所以**閘是開著的**。
- ⚠️ 我們**無法從外部區分「未設」與 `1`/`true`** —— 因為 `isPosDeviceAuthRequired()` 的實作是 `raw === undefined || raw === "" → true`（**fail-closed**）。**「冇設」＝「開閘」**，兩者行為完全一樣。
- ✅ 9/16 那個 `0` 已經改回。時間線：09-16 21:25 實測 401 → 09-17 09:26 再確認 401 → 09-17 11:30 再確認 401。
- ✅ 「改 env 不 redeploy 不會生效」——同意，而正式站現在跑 `bffd352`（**今天 10:44**），遠晚於該變更。
- ✅ 順帶答你們那句「`device-token` 回 401 而非 503 ⇒ Ledger env 正常」——**判讀正確**，secret 鏈健康（`resolveSecret()` 有值，簽發能力正常）。

⚠️ **一個必須分清的界線（避免你們誤判「加固無效」）：**
**開閘只擋 API route，擋唔到資料庫。** `NEXT_PUBLIC_POS_SUPABASE_ANON_KEY` 是**公開變數**（隨 bundle 出街），anon 對 `pos_orders` 有 SELECT ⇒ 只帶 anon key 直打 PostgREST 就能讀 14 日內訂單明細。**這是已知的獨立問題**（根治要 per-store token，未做），**與 API 閘無關**。

---

## 6. Vercel 上 pair 用的 Supabase 變數名

**確認：Production 讀的是 `SUPABASE_URL` + `SUPABASE_ANON_KEY`（不是 `NEXT_PUBLIC_POS_*`）。**

```ts
// src/lib/print-agent-server.ts:130-135
export function resolveRelayRealtimeConfig(): { url: string; anonKey: string } | null {
  const url = process.env.SUPABASE_URL?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return null;
  return { url, anonKey };
}
```

- 🔴 **刻意不 fallback 去 `NEXT_PUBLIC_SUPABASE_URL`**（那個是 Ledger 專案，**冇任何 `pos_*` 表**）。
- `GET /pair` 與 `GET /pair-status` **共用同一個 helper** ⇒ 兩邊口徑永遠不會漂移。

**你們的驗收條件 → 已實測通過（2026-09-16 09:10）：**

```
GET /api/pos/print-agent/pair?agentId=ag-0590816d9f60e8d2f55a16cf721042dd
→ 200 {"status":"paired",
       "storeId":"d564b932-0c91-45e9-86fd-0ec8e2711f13",
       "supabaseUrl":"https://iyrywzormzisyppkokbi.supabase.co",   ← POS 專案 ✅
       "anonKey":"eyJ…(role=anon, ref=iyrywzormzisyppkokbi)"}      ← 非 null ✅
```

URL **不是** Ledger（`zymdemjflsckicnxl`），兩欄非 null ⇒ **符合你們的驗收。**

🔴 **但請修正你們的探測方法：`pending` 不能當「env 有問題」的證據。**

`pair/route.ts:76-79` —— **不存在的 agentId 也回 `{"status":"pending"}`**：

```ts
const agent = await loadPairedAgent(agentId);
if (!agent || agent.revokedAt) {
  return NextResponse.json({ status: "pending" });   // ← 未知 + 已撤銷，同一回應
}
```

⇒ 你們「舊 agent 都是 pending」只能證明**那些 agent 不存在或已被撤銷**，**完全證明不到 env 有無值**。要驗 env 必須用**現役未撤銷**的 agent。

---

## 7. `pair-status` vs 心跳：Web 綠燈不代表中繼在線

**✅ 你們三點都對，逐條確認：**

| 提問 | 答覆 | 證據 |
|---|---|---|
| `paired: true` 只表示 DB 有 agent 列，**不是**即時在線？ | ✅ **對。** `paired` 是**歷史事實**（APK 曾成功 POST 過 `/pair`）。 | `pair-status/route.ts:80-93`（我們自己在註解裡也寫明了） |
| 即時在線是否只看 `last_seen_at` / heartbeat（~30s）？ | ✅ **對。** 心跳＝APK 側每 30s；server 只更新 `pos_print_agents.last_seen_at`。 | `heartbeat/route.ts:24-32` |
| 收銀台 `/` 何時顯示「中繼離線」？ | ⚠️ **收銀台完全看不到。** 只有 `/prints`（打印中心）會顯示，且**門檻是 5 分鐘**：<br>`中繼打印機：最後心跳 N 分鐘前（疑似離線）` | `print-center.tsx:1769-1782` |

**⚠️ 三個額外陷阱（會令你們誤判「斷線」）：**

1. 🔴 **`/prints` 那句「N 分鐘前」是純前端即時計算，頁面不 reload 會無限膨脹。** 實案：畫面顯示「1138 分鐘前」，真實只有 68 分鐘。
   ⇒ **要判死活，請直接打 `GET /api/pos/print-agent/pair-status?storeId=` 讀 `lastSeenAt`**，再對照 `pos_print_jobs` 最後 `claimed_at`。**兩者同一秒停 ⇒ `PosJobRunner` 已死**（心跳 30s 與 tick 60s 是兩條獨立 coroutine，同時停＝整個 scope 被 cancel）。
2. `pair-status` 現在**需要 POS 憑證**（綁店）。**401 會令 web 面板顯示「配對失敗」** ⇒ 配對流程自己停擺。**401 的正解是「iPad 重新登入 POS 帳號」**，不是重配對。
3. `storeName` 恆為 `null`（`pos_print_agents` 沒有這欄）；店名由 web 端 auth session 取。

**額外欄位（你們可用）：** `androidReady: boolean` —— `false` 表示 APK 拿不到 POS 專案的 `supabaseUrl`/`anonKey`（會退化到 30s 輪詢）。與 `paired` **是兩件獨立的事**，請分開報。

---

## 8. `claim` / `heartbeat` 契約有無變更

**✅ 契約未變。逐項：**

| 項目 | 現況 |
|---|---|
| header | `x-agent-id` + `x-agent-token`（`print-agent-server.ts:93-98`） |
| `claim` 回應 | `{ ok: true, jobs: [...], printers: [] }` —— **`printers` 仍然硬編碼 `[]`**（`claim/route.ts:42`）。揀機仍然靠 job 內 `printer` + `device-config`。 |
| `heartbeat` 回應 | `{ ok: true, serverTime: <epoch ms> }` |
| 401 body | **`{"ok":false,"error":"agent 驗證失敗"}`** —— `claim:22` / `heartbeat:21` / `result:22` **三處完全一致** |
| `result` 回應 | `{ ok: true }`；`failed` 時 server 寫 `last_error = "AGENT_FAILED: <你們的原文>"`（截 300 字元） |

**🔴 兩個你們必須知道的「非變更」事實：**

1. **伺服器端對「60s claim / 30s heartbeat」完全沒有任何間隔要求。** 那純粹是 APK 側節奏；server 只驗身分、寫 `last_seen_at`。
   ⇒ 你們「清 pairing 自動重配 + 連續 3 次 401 冷卻 5 分鐘」的策略**不會被 server 打斷**。
2. **你們的 `claim()` 會把 401 訊息蓋掉。** server 回的是 `{"ok":false,"error":"agent 驗證失敗"}`，但你們的 `RelayApi.post()` 因為 `!isSuccessful` 會再寫入 `error = "HTTP 401"`，**覆蓋**掉原文。
   ⇒ 你們的偵測（`error.contains("HTTP 401")`）**會正常運作**，但**會失去「agent 驗證失敗」這句原文**。若要保留原文，改為只在 `error` 不存在時才補 `HTTP <code>`。

**🔴 新發現（需雙方協調，我方尚未改）—— `claim` 缺跨店綁店檢查：**

```ts
// claim/route.ts:29
const storeId = (body.storeId ?? agent.storeId ?? "").trim();   // ← 冇驗 body.storeId === agent.storeId
```

對比：`device-config` **有** `agent.storeId === storeId` 綁店檢查，`claim` / `result` / `heartbeat` **沒有**。
⇒ 理論上，持有**甲店**有效 agent 憑證的人，只要在 body 傳**乙店** storeId，就可以 claim（並在回應中讀到）**乙店的打印任務全文**（含訂單內容）。

**你們側的事實（我們已讀源碼）：** 兩個 APK 的 `claim()` **確實會送 `body.storeId`**，但送的是**自己配對的那家店**（`RelayApi.kt` claim → `PosJobRunner` 傳入自家 storeId），所以**目前不是被利用的漏洞，只是缺了一道防線**。

**建議修法（二選一）：**
- (a) server 拒絕 `body.storeId && body.storeId !== agent.storeId` → 403；
- (b) server 直接忽略 `body.storeId`，一律用 `agent.storeId`。

**在你們回覆「現行 APK 是否依賴 body.storeId 有任何別店用途」之前，我方不會改。** 按目前源碼判斷，(b) 是安全的。

---

## 9. `unpair`：APK 用 agent 自證即可？—— 🔴 **你們目前會 401，需要修 APK**

**契約（不變）：**

```
POST /api/pos/print-agent/unpair   { agentId, storeId, token? }
認可兩條路：
  ① Web 面板 → POS 終端憑證 / admin session（posRouteAuthGuard）
  ② APK 自證 → x-agent-id + x-agent-token（header）或 body.token，且 agent.storeId === storeId
兩者都冇 → 401
```

| 你們的提問 | 答覆 |
|---|---|
| 只帶 `x-agent-id` + `x-agent-token`（body 可不帶 token）→ 200？ | ✅ **是**，會 200（`unpair/route.ts:41-50`）。 |
| body token 傳空字串、閘開後是否 401？ | 🔴 **會 401。** `agentToken = headerToken.token \|\| body.token`；空字串是 falsy ⇒ 不會呼叫 `verifyAgent()` ⇒ 直接回 `posDenied`（401）。 |
| 契約是否不變？ | ✅ 不變（header 或 body token 任一皆可）。但**請你們一律帶 header**。 |
| `agentId` / `storeId` 是否必填？ | ✅ 必填，否則 400。且 `agent.storeId` 必須等於請求的 `storeId`（否則 401）。 |

**🔴 我方的發現（讀你們現行源碼）：兩個 APK 的 `unpair`／`revoke` 都傳空 token：**

```kotlin
// macau-ledger-merchant …/posrelay/RelayApi.kt:104-111
suspend fun unpair(agentId: String, storeId: String): Boolean {
    val payload = JSONObject().put("agentId", agentId).put("storeId", storeId).toString()
    val resp = post("$root/api/pos/print-agent/unpair", agentId, "", payload)   // ← token = ""
```
```kotlin
// print-agent-android …/relay/RelayApi.kt:91-98（同款）
fun revoke(baseUrl: String, agentId: String, storeId: String): Boolean {
    ...
    val resp = post("$baseUrl/api/pos/print-agent/unpair", agentId, "", payload) // ← token = ""
```

⇒ **閘開之後，兩部 App 的「解除配對」都會 401**（Web 面板路徑不受影響）。
⇒ **修法＝把真正的 `agentToken` 傳入 `unpair()`／`revoke()`**，與 `claim()` 一樣。**這次 APK 更新請一併修。**

---

## 10. `verify-pos-authgate.cjs` 對 `kiosk-settings` 的期望

**✅ 你們的判讀完全正確。**

- `GET /api/pos/kiosk-settings` **設計上就是匿名 + rate limit 120/min**（`kiosk-settings/route.ts:119-122`），理由：kiosk／掃碼落單時要讀一次，只暴露非敏感設定。
- **只有 `POST` 需要 POS 憑證**（`:236-242`）。
- **`verify-pos-authgate.cjs` 以前把 kiosk-settings 錯誤列入 `GUARDED`** ⇒ 它正常回 200 被計成「受保護端點仍然放行」⇒ 總結永遠印「閘尚未生效」。**你們的診斷是對的，這是我們腳本的 bug。**

**🔧 已修（2026-09-17）：** 把 `/api/pos/kiosk-settings` 從 `GUARDED` 移到 `ANONYMOUS` 段並加註。修後實測：

```
=== A. 受保護端點（期望 401）===   9/9 全部 401 ✅（含 device-config / pair-status）
=== B. 匿名端點（唔應該 401）===   bootstrap 200 ✅ / kiosk-settings 200 ✅ / store-status 200 ✅
=== 總結 ===  受保護端點仍然 200：0 / 9  →  ⇒ 閘已生效：匿名已無法讀寫店舖資料。
```

---

## 11. 9/16 本地未 deploy 的 sync 修復

**✅ 已 commit、已部署。** 那份 incident 文件的描述**已過時**。

| 事實 | 證據 |
|---|---|
| `sync-order-payload.ts` + 迴歸測試**已 commit** | commit **`b910a76`**（09-16 21:35 +08） |
| **已部署** | GitHub deployments：Production `ref=b910a76`（created 09-16 13:36:38 UTC = 21:36 +08） |
| server 已在用 | `sync/route.ts:13`（import）、`:499`（LWW 預取）、`:682-684`（主解析） |
| 文件那句話 | `docs/reviews/security-incident-2026-09-16.md:59` 寫「本地工作區，未 commit、未部署」→ **該句寫於 20:50 之前，現在已不成立**（我方會更新該文檔） |

**「同步失敗 6 筆」是否仍可能出現？—— 要分兩條講：**

1. ✅ **原本那 6 筆的成因已修**：`ORDER_CREATED` 收了 `{ order }` 包裹形狀 ⇒ 舊版拆錯 ⇒ 永久 400。現在兩種形狀都收（`unwrapOrderEventPayload`）。**已排隊的 6 筆會在下次 flush 自動補上。**
2. 🔴 **但「按放棄又彈返」那條仍未修**：`sync-flush.ts:558-560` 的 legacy-heal 分支（每次 reload 首次 flush 觸發）**只排除 `failed`、不排除 `skipped`** ⇒ 撳「放棄」後一 reload 就會重新推。**所以新一批「同步失敗」仍可能出現，但成因不同。**
3. ⚠️ 另外，「拒絕覆寫訂單（downgrade）」是 **LWW 的正確拒收**（`ack(ok:true, applied:false, reason:"downgrade")`），**不是故障**，請不要當成錯誤計數。

---

## 12. 積壓／離線單處理

| 你們的提問 | 答覆 |
|---|---|
| 中繼長時間離線後重啟，是否要先在 POS 作廢積壓再重啟？ | ✅ **是，這是既定 SOP。** 原因：`RelayState` 是純記憶體，復活一刻會把積壓 job 一次過 claim 出去 ⇒ **一次爆幾十張紙**。 |
| `PrintJob.ttl`（12h 絕對時間）是否已落地？ | ✅ **已落地（server 端）**：`sync/route.ts:145` `PRINT_JOB_TTL_MS = 12 * 60 * 60 * 1000`，實際值 = **min(建單 + 12h, 澳門當日 23:59:59.999)**（雙重保護，用 `created_at` 計，不用 `now()`，避免補推舊事件被當新單）。<br>⚠️ **只對新寫入的行生效**；`ttl` 只在 INSERT 寫 ⇒ 09-15 之前的舊行恆為 `NULL`。 |

**🔴 三個必須知道的實作盲區（會直接影響你們的判斷）：**

1. **`pos_void_stale_print_jobs()` 清不掉 `ttl IS NULL` 的行。**
   條件是 `ttl is not null and ttl <= now`（`0042:144-146`）⇒ `ttl IS NULL` 永遠掃不到。
   **實案：**11 張風險單，函式回 `0`，覆核後**一張都沒變**。
   ⇒ **驗證法（不要只看函式回傳值）**：跑前後比對
   `select count(*) from pos_print_jobs where finished_at is null and coalesce(attempts,0) < 5;`
   清 `ttl IS NULL` 只能用 UPDATE 退路，**且必須逐店分開跑**。
2. ✅ **`attempts >= 5` 的行是安全的**（`coalesce(attempts,0) < 5` 不成立 ⇒ 永不被 claim）。
3. 🔴 **`0042` migration 仍未跑。** 影響你們的兩點：
   - (a) claim 仍是**舊的分段**（0035 的 60 秒）⇒ 同一部機 60 秒後可以**合法地重領自己那張長單** ⇒ **重複出紙**（默認 `p_limit=5`、串行印 5 張長單就可能超過 60 秒）。
     **⇒ 在 0042 跑之前，APK 側請留意：一次 claim 5 張的節奏本身就是這個風險的觸發器。**
   - (b) `pos_void_stale_print_jobs()` **函式不存在** ⇒ `GET /print-jobs/status` 的 lazy sweep 是 **best-effort no-op**（不會 500）⇒ 過期 job 在 UI 會永遠顯示「未認領」，**不會**自動變 failed。
     **⇒ 請不要在 APK 側依賴 server 的 ttl sweep。**

---

## 13. 我方新增的兩項（需你們配合）

| # | 項目 | 誰要做 |
|---|---|---|
| N1 | `claim` 的跨店綁店缺口（第 8 條）—— 回覆「現行 APK 是否依賴 `body.storeId` 有任何別店用途」 | **你們先答，我方再改** |
| N2 | 🔴 **`unpair` / `revoke` 傳空 token ⇒ 閘開後必 401**（第 9 條）—— 把真 token 傳入 | **你們（本次 APK 更新一併修）** |
| N3 | `fetchDeviceConfig()` 加 `x-agent-id` / `x-agent-token`（兩部 App 都要：`print-relay/RelayApi.kt:221`、`_ref-macau-ledger-merchant/…/posrelay/RelayApi.kt:182-185`） | **你們** |
| N4 | `bump versionCode` + 同 keystore 簽名 | **你們** |
| N5 | 更新 `docs/reviews/security-incident-2026-09-16.md:59` 那句過時描述 | **我方** |

---

## 14. 一頁總表

| # | 問題 | 結論 |
|---|---|---|
| 1 | `device-config` agent 憑證 | ✅ **已部署**（`bffd352`）；契約＝`x-agent-id`/`x-agent-token` + `agent.storeId === storeId`；**無法提供測試 token**（只存 hash） |
| 2 | 部署順序 | ✅ server 先行（已完成）→ 你們推 APK；APK 更新前**不要重啟**；回滾＝回退 deployment，**不要改 `POS_REQUIRE_DEVICE_AUTH`** |
| 3 | 憑證分工 | ✅ 中繼**不需也不應**登入 POS 拿 token，用 agent header 即可 |
| 4 | `POST /pair` 匿名 | ⚠️ **仍然匿名**，但已驗真商戶 + 假店黑名單；**無上鎖時間表**；若上鎖會提前通知 + 雙軌過渡 |
| 5 | `POS_REQUIRE_DEVICE_AUTH` | ✅ **閘已開**（11:30 實測 4 條 401）；**肯定不是 `0`**；「未設」＝「開」 |
| 6 | pair 的 env 變數名 | ✅ `SUPABASE_URL` + `SUPABASE_ANON_KEY`（無 fallback）；09-16 實測兩欄非 null 且為 POS 專案；⚠️ **`pending` 不能作 env 證據** |
| 7 | `pair-status` vs 心跳 | ✅ 三點全對；`/prints` 5 分鐘門檻；收銀台看不到；⚠️「N 分鐘前」是前端計算會膨脹 |
| 8 | `claim`/`heartbeat` 契約 | ✅ 未變（`printers: []`、401 文案一致）；🔴 **`claim` 缺綁店檢查**（待你們回覆）；⚠️ 你們 client 會蓋掉 401 原文 |
| 9 | `unpair` 自證 | ✅ header-only = 200；🔴 **但你們傳空 token ⇒ 會 401，需修 APK** |
| 10 | `verify-pos-authgate` 誤列 kiosk-settings | ✅ 你們對；**我方已修腳本**，修後總結正確顯示「閘已生效」 |
| 11 | 9/16 sync 修復 | ✅ **已 commit（`b910a76`）且已部署**；文件描述過時；⚠️ `skipped` 那條仍未修 |
| 12 | 積壓／ttl | ✅ 作廢再重啟是 SOP；✅ ttl 已落地；🔴 **0042 未跑** + **`ttl IS NULL` 是 sweep 盲區** |
