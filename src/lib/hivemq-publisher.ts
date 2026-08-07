import "server-only";

import mqtt from "mqtt";

type PublishPayload = {
  type: "online_order_changed" | "member_changed";
  action?: string;
  orderId?: string;
  memberId?: string;
  ts: string;
};

function env(name: string) {
  return process.env[name] ?? "";
}

function resolveHiveMqTlsUrl() {
  // 例：mqtts://xxxx.s1.eu.hivemq.cloud:8883
  const direct = env("HIVEMQ_MQTTS_URL");
  if (direct) return direct;
  const host = env("HIVEMQ_HOST");
  if (!host) return "";
  const port = env("HIVEMQ_MQTTS_PORT") || "8883";
  return `mqtts://${host}:${port}`;
}

let client: mqtt.MqttClient | null = null;

function getClient() {
  if (client) return client;
  const url = resolveHiveMqTlsUrl();
  const username = env("HIVEMQ_USERNAME");
  const password = env("HIVEMQ_PASSWORD");
  if (!url || !username || !password) return null;

  client = mqtt.connect(url, {
    username,
    password,
    reconnectPeriod: 2000,
    connectTimeout: 8000,
    keepalive: 30,
  });

  client.on("connect", () => {
    // ready
  });
  client.on("close", () => {
    // closed
  });
  client.on("offline", () => {
    // offline
  });

  return client;
}

export async function publishOnlineOrderChanged(storeId: string, orderId: string, action: string) {
  const mqttClient = getClient();
  if (!mqttClient) return;

  const topic = `stores/${storeId}/online-orders/events`;
  const payload: PublishPayload = {
    type: "online_order_changed",
    action,
    orderId,
    ts: new Date().toISOString(),
  };

  await new Promise<void>((resolve) => {
    mqttClient.publish(topic, JSON.stringify(payload), { qos: 1, retain: false }, () => resolve());
  });
}
