import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mqtt from "mqtt";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = resolve(process.env.PRINTFLOW_LOCAL_DATA_DIR || resolve(projectRoot, ".data"));
const configPath = resolve(dataDirectory, "printer-config.json");

const cloudRegions = {
  global: { label: "国际区", apiHost: "api.bambulab.com", mqttHost: "us.mqtt.bambulab.com" },
  china: { label: "中国区", apiHost: "api.bambulab.cn", mqttHost: "cn.mqtt.bambulab.com" },
};

const bambuClientHeaders = {
  "User-Agent": "bambu_network_agent/01.09.05.01",
  "X-BBL-Client-Name": "OrcaSlicer",
  "X-BBL-Client-Type": "slicer",
  "X-BBL-Client-Version": "01.09.05.51",
  "X-BBL-Language": "zh-CN",
  "X-BBL-OS-Type": "linux",
};

let configuration = null;
let client = null;
let latestPayload = null;
let sending = false;
let lastSentAt = 0;
let connected = false;
let lastMessageAt = null;
let lastForwardAt = null;
let lastError = "";
let forwardTimer = null;

function isMergeableObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeReportPayload(previous, incoming) {
  if (!isMergeableObject(previous)) return incoming;
  if (!isMergeableObject(incoming)) return incoming ?? previous;
  const merged = { ...previous };
  for (const [key, value] of Object.entries(incoming)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    merged[key] = isMergeableObject(value) && isMergeableObject(previous[key])
      ? mergeReportPayload(previous[key], value)
      : value;
  }
  return merged;
}

export class VerificationRequiredError extends Error {
  constructor(message = "拓竹账号要求验证码，请查收短信或邮件后填写验证码") {
    super(message);
    this.name = "VerificationRequiredError";
  }
}

export function getAdapterStatus() {
  const region = configuration ? cloudRegions[configuration.region] : null;
  return {
    mode: "cloud-mqtt",
    configured: Boolean(configuration),
    connected,
    lastMessageAt,
    lastForwardAt,
    lastError,
    tokenExpiresAt: configuration?.tokenExpiresAt || null,
    printer: configuration ? {
      name: configuration.name,
      serial: configuration.serial,
      adapter: configuration.adapter,
      region: configuration.region,
      regionLabel: region.label,
      broker: region.mqttHost,
    } : null,
  };
}

function validateBaseConfiguration(input) {
  const value = input && typeof input === "object" ? input : {};
  const name = String(value.name || "X2D 工作站").trim();
  const serial = String(value.serial || "").trim().toUpperCase();
  const region = String(value.region || "global");
  const siteUrl = String(value.siteUrl || "").replace(/\/$/, "");
  const printerId = String(value.printerId || "").trim();
  const bridgeToken = String(value.bridgeToken || "").trim();
  const adapter = String(value.adapter || "bambu-x2d-ams2pro");

  if (!/^[A-Z0-9_-]{6,32}$/.test(serial)) throw new Error("打印机序列号格式不正确");
  if (!(region in cloudRegions)) throw new Error("不支持的拓竹账号区域");
  if (!printerId || !bridgeToken) throw new Error("缺少 PrintFlow 本地连接凭证");
  if (adapter !== "bambu-x2d-ams2pro") throw new Error("当前仅支持 X2D + AMS 2 Pro 适配器");

  const target = new URL(siteUrl);
  if (!["http:", "https:"].includes(target.protocol)) throw new Error("PrintFlow 页面地址必须使用 HTTP 或 HTTPS");

  return { name, serial, region, siteUrl, printerId, bridgeToken, adapter };
}

function validateStoredConfiguration(input) {
  const base = validateBaseConfiguration(input);
  const value = input && typeof input === "object" ? input : {};
  const userId = String(value.userId || "").trim();
  const accessToken = String(value.accessToken || "").trim();
  const tokenExpiresAt = value.tokenExpiresAt ? String(value.tokenExpiresAt) : null;
  if (!/^\d+$/.test(userId)) throw new Error("拓竹云端用户 ID 无效，请重新登录");
  if (accessToken.length < 20) throw new Error("拓竹云端访问令牌无效，请重新登录");
  return { ...base, userId, accessToken, tokenExpiresAt };
}

function cloudError(response, data, fallback) {
  const detail = data && typeof data === "object" ? String(data.message || data.error || "").trim() : "";
  if (response.status === 401 || response.status === 403) return "拓竹云端认证失败，请重新登录";
  return detail && detail.length < 160 ? detail : fallback;
}

async function cloudRequest(region, path, options = {}) {
  const endpoint = cloudRegions[region];
  const url = path.startsWith("https://") ? path : `https://${endpoint.apiHost}${path}`;
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(15000),
    headers: { ...bambuClientHeaders, "Accept": "application/json", ...(options.headers || {}) },
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // Non-JSON responses are represented by the HTTP status below.
  }
  return { response, data };
}

async function loginToCloud(region, input) {
  const directToken = String(input.accessToken || "").trim();
  if (directToken) return { accessToken: directToken, tokenExpiresAt: null };

  const account = String(input.account || "").trim();
  const password = String(input.password || "");
  const verificationCode = String(input.verificationCode || "").trim();
  if (!account) throw new Error("请填写拓竹账号邮箱或手机号，或使用已有 Access Token");
  if (region !== "china" && !account.includes("@")) throw new Error("手机号注册账号请选择中国区");
  if (!account.includes("@") && !/^\+?\d{6,20}$/.test(account)) throw new Error("手机号格式不正确，请只输入号码和可选的国家区号");

  if (!password && !verificationCode) {
    await requestVerificationCode(region, account);
    throw new VerificationRequiredError(account.includes("@") ? "验证码已发送到账号邮箱，请填写后再次连接" : "验证码已发送到账号手机，请填写后再次连接");
  }

  const loginBody = verificationCode ? { account, code: verificationCode } : { account, password };
  const { response, data } = await cloudRequest(region, "/v1/user-service/user/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(loginBody),
  });
  const accessToken = data && typeof data === "object" ? String(data.accessToken || "").trim() : "";
  if (!accessToken && data?.loginType === "verifyCode") {
    await requestVerificationCode(region, account);
    throw new VerificationRequiredError(account.includes("@") ? "验证码已发送到账号邮箱，请填写后再次连接" : "验证码已发送到账号手机，请填写后再次连接");
  }
  if (!accessToken && Number(data?.code) === 1) throw new VerificationRequiredError("验证码已过期，请重新获取");
  if (!accessToken && Number(data?.code) === 2) throw new VerificationRequiredError("验证码不正确，请检查后重试");
  if (!response.ok || !accessToken) throw new Error(cloudError(response, data, "无法登录拓竹云端"));
  const expiresIn = Number(data.expiresIn);
  const tokenExpiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
  return { accessToken, tokenExpiresAt };
}

export async function requestVerificationCode(region, accountValue) {
  const account = String(accountValue || "").trim();
  if (!(region in cloudRegions)) throw new Error("不支持的拓竹账号区域");
  if (!account) throw new Error("请先填写拓竹账号邮箱或手机号");
  if (region !== "china" && !account.includes("@")) throw new Error("手机号注册账号请选择中国区");
  if (!account.includes("@") && !/^\+?\d{6,20}$/.test(account)) throw new Error("手机号格式不正确，请只输入号码和可选的国家区号");
  const isEmail = account.includes("@");
  const path = isEmail ? "/v1/user-service/user/sendemail/code" : "/v1/user-service/user/sendsmscode";
  const body = isEmail ? { email: account, type: "codeLogin" } : { phone: account, type: "codeLogin" };
  const { response, data } = await cloudRequest(region, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const fallback = isEmail ? "无法发送邮箱验证码" : "无法发送短信验证码";
    if (response.status === 401 || response.status === 403) {
      throw new Error(`${fallback}：拓竹云端拒绝了请求，请检查账号区域和${isEmail ? "邮箱" : "手机号"}，或稍后重试`);
    }
    throw new Error(cloudError(response, data, fallback));
  }
}

async function resolveCloudIdentity(region, serial, accessToken) {
  const headers = { "Authorization": `Bearer ${accessToken}` };
  const [{ response: profileResponse, data: profile }, { response: devicesResponse, data: devicesData }] = await Promise.all([
    cloudRequest(region, "/v1/design-user-service/my/preference", { headers }),
    cloudRequest(region, "/v1/iot-service/api/user/bind", { headers }),
  ]);
  if (!profileResponse.ok) throw new Error(cloudError(profileResponse, profile, "无法读取拓竹账号信息"));
  if (!devicesResponse.ok) throw new Error(cloudError(devicesResponse, devicesData, "无法读取账号中的打印机"));
  const userId = String(profile?.uid ?? profile?.data?.uid ?? "").trim();
  if (!/^\d+$/.test(userId)) throw new Error("拓竹云端未返回有效用户 ID");
  const devices = Array.isArray(devicesData?.devices) ? devicesData.devices : Array.isArray(devicesData?.data?.devices) ? devicesData.data.devices : [];
  if (devices.length > 0 && !devices.some((device) => String(device?.dev_id || "").trim().toUpperCase() === serial)) {
    throw new Error("该序列号不在当前拓竹账号的已绑定设备中");
  }
  return { userId };
}

export async function buildConfiguration(input) {
  const base = validateBaseConfiguration(input);
  const reuseToken = Boolean(input?.reuseToken && configuration?.accessToken && configuration?.region === base.region);
  const auth = reuseToken
    ? { accessToken: configuration.accessToken, tokenExpiresAt: configuration.tokenExpiresAt || null }
    : await loginToCloud(base.region, input);
  const identity = await resolveCloudIdentity(base.region, base.serial, auth.accessToken);
  return validateStoredConfiguration({ ...base, ...auth, ...identity });
}

async function saveConfiguration(next) {
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(configPath, 0o600);
}

export async function configureAdapter(input) {
  const next = await buildConfiguration(input);
  await saveConfiguration(next);
  configuration = next;
  connectPrinter(next);
  return getAdapterStatus();
}

async function forwardLatest() {
  if (!latestPayload || !configuration || sending || Date.now() - lastSentAt < 4000) return;
  sending = true;
  const payload = latestPayload;
  latestPayload = null;
  try {
    const response = await fetch(`${configuration.siteUrl}/api/printers/ingest`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${configuration.bridgeToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ printerId: configuration.printerId, adapter: configuration.adapter, payload }),
    });
    if (!response.ok) throw new Error(`PrintFlow 接口返回 ${response.status}`);
    lastSentAt = Date.now();
    lastForwardAt = new Date().toISOString();
    lastError = "";
  } catch (error) {
    latestPayload = mergeReportPayload(payload, latestPayload);
    lastError = error instanceof Error ? error.message : "状态同步失败";
  } finally {
    sending = false;
  }
}

function connectPrinter(next) {
  if (client) client.end(true);
  connected = false;
  lastError = "";
  const reportTopic = `device/${next.serial}/report`;
  client = mqtt.connect({
    protocol: "mqtts",
    host: cloudRegions[next.region].mqttHost,
    port: 8883,
    username: `u_${next.userId}`,
    password: next.accessToken,
    rejectUnauthorized: true,
    reconnectPeriod: 10000,
    connectTimeout: 15000,
    clientId: `printflow_cloud_${Math.random().toString(16).slice(2, 10)}`,
  });
  client.on("connect", () => {
    connected = true;
    lastError = "";
    client.subscribe(reportTopic, { qos: 0 }, (error) => {
      if (error) lastError = `云端 MQTT 订阅失败：${error.message}`;
    });
  });
  client.on("message", (_topic, message) => {
    try {
      latestPayload = mergeReportPayload(latestPayload, JSON.parse(message.toString("utf8")));
      lastMessageAt = new Date().toISOString();
      void forwardLatest();
    } catch (error) {
      lastError = error instanceof Error ? error.message : "无法解析云端 MQTT 数据";
    }
  });
  client.on("close", () => { connected = false; });
  client.on("offline", () => { connected = false; });
  client.on("error", (error) => { lastError = `云端 MQTT：${error.message}`; });
}

async function loadSavedConfiguration() {
  try {
    configuration = validateStoredConfiguration(JSON.parse(await readFile(configPath, "utf8")));
    connectPrinter(configuration);
  } catch (error) {
    configuration = null;
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    lastError = "检测到旧配置或令牌无效，请在打印机设置中重新登录";
  }
}

export async function startAdapterService({ siteUrl = "" } = {}) {
  await mkdir(dataDirectory, { recursive: true });
  await loadSavedConfiguration();
  if (configuration && siteUrl) {
    configuration = validateStoredConfiguration({ ...configuration, siteUrl });
    await saveConfiguration(configuration);
  }
  forwardTimer = setInterval(() => void forwardLatest(), 4000);
  console.log("[PrintFlow] 云端 MQTT Adapter 已并入 PrintFlow 服务");
}

export async function stopAdapterService() {
  if (forwardTimer) {
    clearInterval(forwardTimer);
    forwardTimer = null;
  }
  if (client) {
    client.end(true);
    client = null;
  }
  connected = false;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await startAdapterService().catch((error) => {
    console.error(`[PrintFlow] 云端 MQTT Adapter 无法启动：${error.message}`);
    process.exit(1);
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await stopAdapterService();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
