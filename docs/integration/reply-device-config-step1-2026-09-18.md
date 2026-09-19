# 回覆：商戶 App 堂食中繼交接單（device-config Step 1）

> 回覆日期：**2026-09-18 17:20（澳門）**
> 我方版本錨點：`main` @ **`2c1cf55`**（工作區乾淨，無未推送 commit）
> Step 1 實作 commit：**`bffd352`**（2026-09-17 10:43 +08，"up"）
> 相關文檔：`docs/integration/reply-relay-checklist-2026-09-17.md`（上一輪）、`print-relay-device-config-runbook.md`、`print-relay-hardening-brief.md` §8

---

## 0. 結論一句

**✅ Step 1 我方已完成、已部署、已生效——你們可以推 APK，唔使等我方任何事。**

你們交接單裡「請 POS 跟的事項 §1」所指嘅改動（device-config 接受 agent 憑證），**早在 2026-09-17 10:43 嘅 `bffd352` 就做完並上了正式 Vercel**。本輪我方**冇新 code 要寫**，只做了**獨立複驗**。

---

## 1. §1 Server Step 1 — 已實作，位置與契約

`src/app/api/pos/device-config/route.ts:45-54`：

```ts
const { agentId, token } = readAgentHeaders(request);            // x-agent-id / x-agent-token
const agent = agentId && token ? await verifyAgent(agentId, token) : null;
const viaAgent = Boolean(agent && agent.storeId === storeId);    // 🔴 綁店

if (!viaAgent) {
  const denied = posRouteAuthGuard(request, storeId, "pos/device-config");
  if (denied) return denied;                                     // 既有 iPad Bearer / admin
} else {
  console.info(`[pos/device-config] 中繼機憑證通道（agent=${agentId}, store=${storeId}）`);
}
```

| 你們的要求 | 現況 |
|---|---|
| 兩條路任一通過 | ✅ 正是如此（agent 憑證 **或** `posRouteAuthGuard`） |
| `agent.storeId === storeId` 綁店 | ✅ `:47` |
| 用同一套 `readAgentHeaders` / `verifyAgent` | ✅ 由 `@/lib/print-agent-server` import，**冇另寫**（`:4`） |
| Redeploy 正式 Vercel | ✅ 已部署（`bffd352`，09-17 10:44:09 +08） |

**早期 return 位置（重要，唔會被閘污染）**：`!supabase` 與 `!storeId` 兩個 early-return **刻意放在 auth 閘之前**（`route.ts:13-25`），保持既有 mock / 無 storeId 回應完全不變。

---

## 2. §2 部署後一起驗 — 本輪已驗結果

以**正式站** `https://macau-pos-system.vercel.app` 實測（腳本 `tools/_probe-device-config-step1-20260918.cjs`、`tools/_probe-agent-contract-20260918.cjs`）。

| # | 檢查 | 期望 | 本輪實測 | 結果 |
|---|---|---|---|---|
| 1 | 匿名 + storeId | 401 | **401**「未經授權：需要 POS 終端憑證」 | ✅ |
| 2 | 本店真 agent | 200 + printers 有內容 | 需真憑證（見 §3） | ⏳ 待驗 |
| 3 | 甲店 agent 打乙店 | 401 | 需真憑證（見 §3） | ⏳ 待驗 |
| 4 | 已 revoke 的 agent | 401 | 需真憑證 + DB 操作 | ⏳ 待驗 |
| 5 | 商米重啟後落一張堂食單 | 印得出、印對機 | 現場人手驗 | ⏳ 待驗 |

**額外旁證（本輪實測）**：帶**亂造** agent 憑證打 device-config → **401**。
⚠️ 注意：假憑證回 401 **在「已部署」和「未部署」兩種情況下完全一樣**（`verifyAgent` 失敗 ⇒ 落返 guard ⇒ 同一句 401），**唔可以單憑假憑證回 401 就判斷 agent 通道上咗**。必須用**現役有效憑證**才分得出 #2/#3。

---

## 3. §2 #2/#3/#4 為何要真憑證 —— 以及我們需要你什麼

`pos_print_agents` **只存 `sha256(token)`**（`token_hash`），明文 token 在配對時只經 HTTPS 交一次，**連我方 DB 也讀唔到**（RLS 亦無 anon SELECT，實測 42501）。
⇒ #2/#3/#4 **無法由我方單獨完成**，必須用你們手上那組**現役有效** `agentId` + 明文 token。

**已備好驗證腳本**：`tools/verify-device-config-agent-live.cjs`

```bash
read -r -p "agentId: " RELAY_AGENT_ID
read -rs -p "token  : " RELAY_AGENT_TOKEN; echo
read -r -p "storeId: " RELAY_STORE_ID
export RELAY_AGENT_ID RELAY_AGENT_TOKEN RELAY_STORE_ID
node tools/verify-device-config-agent-live.cjs
```

依序驗 R1（匿名 401）→ R2（本店 200 + printers）→ R3（跨店 401）。R4（revoked）需先撤銷再跑，屬破壞性，建議用測試 agent。

---

## 4. §3 不要改的契約 — 本輪實測：**全部維持不變**

| 契約 | 實測（假憑證 / 匿名） | 結論 |
|---|---|---|
| `claim` | `POST` → **401** `{"ok":false,"error":"agent 驗證失敗"}` | ✅ 只認 agent，冇改要 POS Bearer |
| `heartbeat` | `POST` → **401** 同上 | ✅ |
| `result` | `POST` → **401** 同上 | ✅ |
| `GET /pair` | 未知 agentId → **200 `{"status":"pending"}`** | ✅ 自動配對通道不變 |
| 中繼是否需 POS 登入 Bearer | **完全唔需要** | ✅ 設計如此，agent token 無 TTL |

**`claim` 回應 `printers` 仍然係硬編碼 `[]`**（`claim/route.ts:42`）—— 揀機靠 job 內 `printer` + device-config，**契約未變**。

⚠️ **`POST /pair` 配對碼**：仍**未排期**。若日後上鎖，我方會**先出書面通知 + 雙軌過渡期**（建議提前 1 版 APK），**不會突然上鎖**。

---

## 5. §4 營運注意 — 逐條確認

| 你們的提醒 | 我方答覆 |
|---|---|
| Step 1 上線前，重啟中繼仍可能印錯機（路由只在記憶體） | ✅ **正確**。`RelayState.deviceConfigPrinters` 純記憶體。**Step 1 已上線 ⇒ 只要 APK 帶齊 agent header（你們已做），重啟就安全**（能重讀到權威路由）。 |
| `POS_REQUIRE_DEVICE_AUTH` 維持開 | ✅ **已開**。本輪 17:10 實測：`state` / `device-config` / `print-jobs/status` / `orders` 全部 **401**。肯定唔係 `0`。 |
| 改 env 後要 Redeploy | ✅ 同意。正式站跑 `bffd352`，遠晚於任何 env 變更。 |
| Vercel `SUPABASE_URL` + `SUPABASE_ANON_KEY` 必須係 POS 專案 | ✅ 確認。`resolveRelayRealtimeConfig()` 讀嘅正是這兩支，**刻意唔 fallback 去 `NEXT_PUBLIC_SUPABASE_URL`**（Ledger 專案冇 `pos_*` 表）。09-16 實測 `/pair` 回 `iyrywzormzisyppkokbi.supabase.co` ✅。 |

---

## 6. §5 斷線 — 同意，唔係本次 Auth 能解

✅ **完全同意你們的判斷。** Auth 只保證「閘開了還能讀打印機設定」，與「心跳停、要手動重連」係兩件獨立的事。

本輪實測一個相關旁證：`GET /api/pos/print-agent/pair-status` 回 **401**（`posRouteAuthGuard`）。
⇒ 該端點**只認 POS 憑證（iPad Bearer / admin）**，**agent 憑證讀唔到**。
⇒ 營運含意：`/prints` 打印中心判中繼死活嗰句，**必須 iPad 處於登入態**才讀得到 `lastSeenAt`；401 會令面板顯示「配對失敗」（正解＝iPad 重新登入，不是重配對）。

⇒ 若仍常斷（心跳停、要手按重連）：**另開一輪**（watchdog / 電池白名單 / 自啟動），與本次無關。

---

## 7. 一頁總表

| # | 你們的期望 | 我方結論 |
|---|---|---|
| 1 | device-config 接受 agent 憑證（Server Step 1） | ✅ **已實作、已部署、已生效**（`bffd352`） |
| 2 | 部署後一起驗（5 項） | 匿名 401 ✅ 已驗；#2/#3/#4 待真憑證；#5 現場驗 |
| 3 | claim/heartbeat/result 只驗 agent | ✅ 實測契約不變 |
| 4 | 中繼不需 POS 登入 Bearer | ✅ 設計如此 |
| 5 | `POST /pair` 加配對碼先講時間表 | ✅ 未排期；會提前通知 + 雙軌過渡 |
| 6 | `POS_REQUIRE_DEVICE_AUTH` 維持開 | ✅ 已開（4 端點實測 401） |
| 7 | Vercel pair 用 POS 專案 env | ✅ 確認，無 fallback |
| 8 | 重啟印錯機 | ✅ Step 1 上線後 + APK 帶憑證 ⇒ 重啟安全 |
| 9 | 斷線 | ✅ 同意與 Auth 無關，另開一輪 |

**⇒ 你們可以推 APK（`sunmi-v2s` / `1.1.12` (18)）。我方無阻塞項。**
