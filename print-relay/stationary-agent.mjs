// print-relay/stationary-agent.mjs
//
// 最小 Stationary Agent 骨架：connect relay 做 stationary，收 dispatch，stub 出單，回 result。
// 協議見 docs/46 §3。⚠️ 出單係 stub（只 log），真出單要接 LanTransport（見 docs/46 P5.2）。
//
// 跑法：STORE_ID=macau-store-a TOKEN=dev-token npm run agent
//       （RELAY_URL 預設 ws://localhost:8788）

import WebSocket from "ws";

const RELAY = process.env.RELAY_URL || "ws://localhost:8788";
const STORE_ID = process.env.STORE_ID || "macau-store-a";
const TOKEN = process.env.STORE_TOKEN || "dev-token";

function start() {
  const ws = new WebSocket(
    `${RELAY}?role=stationary&storeId=${encodeURIComponent(STORE_ID)}&token=${encodeURIComponent(TOKEN)}`,
  );

  ws.on("open", () => console.log(`[agent] connected to relay as stationary (store=${STORE_ID})`));

  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.type === "dispatch") {
      const job = m.job;
      // TODO(P5.2): 用同一套 LanTransport 真正出單（ESC/POS bytes → 打印機）
      const bytesLen = JSON.stringify(job).length; // stub：實際係 renderEscPos(job) 嘅 byte 數
      console.log(
        `[agent] print job ${job?.id} -> ${m.printer?.name} (${m.printer?.connectionType}) bytes≈${bytesLen}`,
      );
      // 模擬成功（實際要等物理出單，再 call 真 async result）
      ws.send(
        JSON.stringify({ type: "result", storeId: STORE_ID, jobId: job?.id, ok: true, code: "OK" }),
      );
    }
  });

  ws.on("close", () => {
    console.log("[agent] disconnected, retrying in 3s...");
    setTimeout(start, 3000);
  });
  ws.on("error", (e) => console.error("[agent] error", e.message));
}

start();
