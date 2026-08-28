import mqtt from "mqtt";

const required = [
  "PRINTER_HOST",
  "PRINTER_SERIAL",
  "PRINTER_ACCESS_CODE",
  "PRINTFLOW_SITE_URL",
  "PRINTFLOW_PRINTER_ID",
  "PRINTFLOW_BRIDGE_TOKEN",
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`缺少配置：${missing.join(", ")}`);
  console.error("请使用 PrintFlow 打印机设置页生成 .env 文件。");
  process.exit(1);
}

const host = process.env.PRINTER_HOST;
const serial = process.env.PRINTER_SERIAL;
const siteUrl = process.env.PRINTFLOW_SITE_URL.replace(/\/$/, "");
const printerId = process.env.PRINTFLOW_PRINTER_ID;
const token = process.env.PRINTFLOW_BRIDGE_TOKEN;
const adapter = process.env.PRINTER_ADAPTER || "bambu-x2d-ams2pro";
const reportTopic = `device/${serial}/report`;
let latestPayload = null;
let sending = false;
let lastSentAt = 0;

async function forwardLatest() {
  if (!latestPayload || sending || Date.now() - lastSentAt < 4000) return;
  sending = true;
  const payload = latestPayload;
  latestPayload = null;
  try {
    const response = await fetch(`${siteUrl}/api/printers/ingest`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ printerId, adapter, payload }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`${response.status} ${detail.slice(0, 180)}`);
    }
    lastSentAt = Date.now();
    console.log(`${new Date().toLocaleTimeString()} 状态已同步到 PrintFlow`);
  } catch (error) {
    latestPayload = payload;
    console.error(`${new Date().toLocaleTimeString()} 同步失败：${error.message}`);
  } finally {
    sending = false;
  }
}

const client = mqtt.connect({
  protocol: "mqtts",
  host,
  port: Number(process.env.PRINTER_MQTT_PORT || 8883),
  username: "bblp",
  password: process.env.PRINTER_ACCESS_CODE,
  rejectUnauthorized: false,
  reconnectPeriod: 5000,
  connectTimeout: 12000,
  clientId: `printflow_${Math.random().toString(16).slice(2, 10)}`,
});

client.on("connect", () => {
  console.log(`已连接 ${process.env.PRINTER_NAME || "X2D"}，正在监听只读状态…`);
  client.subscribe(reportTopic, { qos: 0 }, (error) => {
    if (error) console.error(`订阅失败：${error.message}`);
    else console.log(`已订阅 ${reportTopic}`);
  });
});

client.on("message", (_topic, message) => {
  try {
    latestPayload = JSON.parse(message.toString("utf8"));
    void forwardLatest();
  } catch (error) {
    console.error(`忽略无法解析的 MQTT 数据：${error.message}`);
  }
});

client.on("reconnect", () => console.log("正在重新连接打印机…"));
client.on("error", (error) => console.error(`MQTT 连接错误：${error.message}`));

setInterval(() => void forwardLatest(), 4000);

function shutdown() {
  console.log("正在关闭 PrintFlow 桥接器…");
  client.end(false, {}, () => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
