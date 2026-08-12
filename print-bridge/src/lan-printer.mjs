import net from "node:net";

/**
 * @param {{ host: string, port?: number, data: Buffer, timeoutMs?: number }} options
 */
export function printToLan({ host, port = 9100, data, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    if (!host) {
      reject(new Error("LAN 打印機缺少 IP 地址。"));
      return;
    }

    const socket = new net.Socket();
    let settled = false;

    function finish(error) {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(undefined);
    }

    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => finish(new Error(`連線 ${host}:${port} 逾時。`)));
    socket.once("error", (error) => finish(error));
    socket.connect(port, host, () => {
      socket.write(data, (error) => {
        if (error) {
          finish(error);
          return;
        }
        socket.end();
      });
    });
    socket.once("close", () => finish(undefined));
  });
}
