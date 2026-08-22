// print-relay/server.mjs
//
// 最小 Cloud Print Relay 骨架（store-scoped room + submit→dispatch + result 回傳 + TTL 丟 + anchor 心跳）。
// 協議見 docs/46 §3。⚠️ auth 係 placeholder，唔係生產級（見 docs/46 §4）。
//
// 跑法：npm install && npm run relay   （port 用 RELAY_PORT，預設 8788）

import { WebSocketServer, WebSocket } from "ws";
import { URL } from "node:url";

const PORT = Number(process.env.RELAY_PORT || 8788);
const DEFAULT_TTL_MS = 60_000;

const wss = new WebSocketServer({ port: PORT });

// rooms: storeId -> { terminals: Set<ws>, stationary: ws|null, pending: Map<jobId, {msg, expiresAt}> }
const rooms = new Map();

function room(storeId) {
  if (!rooms.has(storeId)) {
    rooms.set(storeId, { terminals: new Set(), stationary: null, pending: new Map() });
  }
  return rooms.get(storeId);
}

function send(ws, type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...payload }));
}

// TODO(P5.1 security): 真實驗證 token 屬於 storeId 嘅 merchant（見 docs/46 §4）
function authenticate(token, storeId) {
  if (!token || !storeId) return false;
  console.warn("[relay] ⚠️ placeholder auth：token 非空即過，生產級驗證 TODO (docs/46 §4)");
  return true;
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("token");
  const storeId = url.searchParams.get("storeId");
  const role = url.searchParams.get("role"); // "terminal" | "stationary"

  if (!authenticate(token, storeId)) {
    send(ws, "error", { error: "unauthorized" });
    ws.close();
    return;
  }

  const r = room(storeId);
  ws.meta = { storeId, role, lastSeen: Date.now() };

  if (role === "stationary") {
    r.stationary = ws;
    // 重發重過期嘅 pending 畀新上線嘅 stationary
    for (const [jobId, entry] of r.pending) {
      if (entry.expiresAt > Date.now()) send(ws, "dispatch", entry.msg);
    }
  } else {
    r.terminals.add(ws);
  }

  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.type === "submit" && role === "terminal") {
      const jobId = m.job?.id;
      const expiresAt = typeof m.ttl === "number" ? m.ttl : Date.now() + DEFAULT_TTL_MS;
      const dispatchMsg = {
        storeId,
        job: m.job,
        printer: m.printer,
        kind: m.kind,
        storeName: m.storeName,
        ttl: m.ttl,
      };
      r.pending.set(jobId, { msg: dispatchMsg, expiresAt });
      send(ws, "submit_ack", { ok: true, jobId });
      if (r.stationary && r.stationary.readyState === WebSocket.OPEN) {
        send(r.stationary, "dispatch", dispatchMsg);
      }
      // 冇 stationary 就 keep 喺 pending 等佢上線（見上面重發）
    } else if (m.type === "result" && role === "stationary") {
      for (const t of r.terminals) {
        send(t, "result", { storeId, jobId: m.jobId, ok: m.ok, code: m.code, error: m.error });
      }
      r.pending.delete(m.jobId);
    } else if (m.type === "anchor") {
      ws.meta.lastSeen = Date.now();
    }
  });

  ws.on("close", () => {
    if (role === "stationary" && r.stationary === ws) r.stationary = null;
    r.terminals.delete(ws);
  });
});

// TTL 清掃：每 10s 丟過期 pending，並通知 terminal（防以為印咗）
setInterval(() => {
  const now = Date.now();
  for (const [storeId, r] of rooms) {
    for (const [jobId, entry] of r.pending) {
      if (entry.expiresAt <= now) {
        r.pending.delete(jobId);
        for (const t of r.terminals) {
          send(t, "result", { storeId, jobId, ok: false, code: "TTL_EXPIRED", error: "job expired" });
        }
      }
    }
  }
}, 10_000);

console.log(`[relay] Cloud Print Relay listening on :${PORT} (ws)`);
