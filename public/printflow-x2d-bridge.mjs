import mqtt from "mqtt";

const required = [
  "BAMBU_USER_ID",
  "BAMBU_ACCESS_TOKEN",
  "PRINTER_SERIAL",
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

const region = process.env.BAMBU_REGION === "china" ? "china" : "global";
const host = region === "china" ? "cn.mqtt.bambulab.com" : "us.mqtt.bambulab.com";
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
  port: 8883,
  username: `u_${process.env.BAMBU_USER_ID}`,
  password: process.env.BAMBU_ACCESS_TOKEN,
  rejectUnauthorized: true,
  reconnectPeriod: 10000,
  connectTimeout: 15000,
  clientId: `printflow_cloud_${Math.random().toString(16).slice(2, 10)}`,
});

client.on("connect", () => {
  console.log(`已连接拓竹${region === "china" ? "中国区" : "国际区"}云端，正在监听 ${process.env.PRINTER_NAME || "X2D"}…`);
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

client.on("reconnect", () => console.log("正在重新连接拓竹云端 MQTT…"));
client.on("error", (error) => console.error(`云端 MQTT 连接错误：${error.message}`));

setInterval(() => void forwardLatest(), 4000);

function shutdown() {
  console.log("正在关闭 PrintFlow 桥接器…");
  client.end(false, {}, () => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
