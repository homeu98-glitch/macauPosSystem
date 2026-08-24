# print-relay — Cloud Print Relay + Stationary Agent（Phase 5 骨架）

> 互聯網備援路徑（path B）嘅最小可跑骨架。協議與選型見 [`docs/46-cloud-print-relay-spec.md`](../docs/46-cloud-print-relay-spec.md)。

## 角色

- **Relay server**（`server.mjs`）：雲端常駐，store-scoped 隔離，只中轉，唔落 DB。
- **Stationary Agent**（`stationary-agent.mjs`）：店內常開機，收 relay job → 出單 → 回 result。

## 跑法

```bash
cd print-relay
npm install
# 終端 1：relay
npm run relay
# 終端 2：店內 stationary agent
STORE_ID=macau-store-a TOKEN=dev-token npm run agent
```

## 協議（WSS JSON 訊息，見 docs/46 §3）

| 方向 | 訊息 | 欄位 |
|---|---|---|
| Terminal → Relay | `submit` | `{ storeId, token, job, printer, kind, storeName, ttl }` |
| Relay → Terminal | `submit_ack` | `{ ok, jobId, error? }` |
| Relay → Stationary | `dispatch` | `{ storeId, job, printer, kind, storeName, ttl }` |
| Stationary → Relay | `result` | `{ storeId, jobId, ok, code, error? }` |
| Relay → Terminal | `result` | `{ storeId, jobId, ok, code, error? }` |
| 任一方 → Relay | `anchor` | `{ storeId, at }`（心跳） |

## ⚠️ 骨架限制（生產級要補，見 docs/46 P5.1–P5.6）

- **auth 係 placeholder**：`server.mjs` 嘅 `authenticate()` 只 check token 非空。生產要驗證 token 屬於該 storeId 嘅 merchant（docs/46 §4）。
- **Stationary 出單係 stub**：只 log，未接真正 `LanTransport` 出單（docs/46 P5.2）。
- **無持久 ack / 多 stationary 負載均衡 / 監控 / rate limit**：要 P5.1–P5.6 補。
- **部署**：呢度係 `ws` 常駐服務，適合 Railway/Render/Fly/VM。亦可改用 Supabase Realtime（見 docs/46 §2）。

## 同本 repo 嘅關係

- 終端側 relay client：`src/lib/print-bridge/relay-transport.ts`（實作 `PrintTransport`，暫未接入 `dispatch.ts`，留 P5.3）。
- LAN 直打 path A 唔受影響；relay 只係 off store-LAN fallback。
