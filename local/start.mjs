import { spawn } from "node:child_process";
import { createServer, request as createProxyRequest } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configureAdapter,
  getAdapterStatus,
  requestVerificationCode,
  startAdapterService,
  stopAdapterService,
  VerificationRequiredError,
} from "./adapter-service.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webPort = Number(process.env.PRINTFLOW_WEB_PORT || 8082);
const webIp = String(process.env.PRINTFLOW_WEB_IP || "0.0.0.0");
const internalWebPort = Number(process.env.PRINTFLOW_INTERNAL_WEB_PORT || webPort + 1);
const internalWebIp = "127.0.0.1";
const internalSiteUrl = `http://${webIp === "0.0.0.0" ? "127.0.0.1" : webIp}:${webPort}`;
const persistDirectory = String(process.env.PRINTFLOW_WRANGLER_PERSIST_DIR || ".data/wrangler");
const wrangler = resolve(projectRoot, "node_modules/.bin/wrangler");
const children = [];
const useProcessGroups = process.platform !== "win32";
let stopping = false;

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new Error("配置内容过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function proxyToWeb(request, response) {
  const upstream = createProxyRequest({
    hostname: internalWebIp,
    port: internalWebPort,
    path: request.url || "/",
    method: request.method,
    headers: request.headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => {
    if (!response.headersSent) return sendJson(response, 502, { error: "PrintFlow 网页服务正在启动，请稍后刷新" });
    response.end();
  });
  request.pipe(upstream);
}

const gateway = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || `localhost:${webPort}`}`);
  if (url.pathname === "/api/adapter/status") {
    if (request.method === "GET") return sendJson(response, 200, getAdapterStatus());
    return sendJson(response, 405, { error: "请求方法不支持" });
  }
  if (url.pathname === "/api/adapter/verification-code") {
    if (request.method !== "POST") return sendJson(response, 405, { error: "请求方法不支持" });
    try {
      const { region, account } = await readJson(request);
      await requestVerificationCode(region, account);
      const isEmail = String(account || "").includes("@");
      return sendJson(response, 200, { ok: true, message: isEmail ? "验证码已发送到账号邮箱" : "验证码已发送到账号手机" });
    } catch (error) {
      return sendJson(response, 400, { error: error instanceof Error ? error.message : "验证码发送失败" });
    }
  }
  if (url.pathname === "/api/adapter/configure") {
    if (request.method !== "POST") return sendJson(response, 405, { error: "请求方法不支持" });
    try {
      const status = await configureAdapter({ ...(await readJson(request)), siteUrl: internalSiteUrl });
      return sendJson(response, 200, { ok: true, status });
    } catch (error) {
      if (error instanceof VerificationRequiredError) {
        return sendJson(response, 428, { error: error.message, verificationRequired: true });
      }
      return sendJson(response, 400, { error: error instanceof Error ? error.message : "保存云端 MQTT 配置失败" });
    }
  }
  return proxyToWeb(request, response);
});

function runWebService() {
  const child = spawn(wrangler, [
    "dev",
    "--config",
    "wrangler.local.jsonc",
    "--local",
    "--ip",
    internalWebIp,
    "--port",
    String(internalWebPort),
    "--persist-to",
    persistDirectory,
  ], {
    cwd: projectRoot,
    env: process.env,
    stdio: ["ignore", "ignore", "inherit"],
    detached: useProcessGroups,
  });
  children.push(child);
  child.on("error", (error) => {
    if (!stopping) console.error(`[PrintFlow] 网页服务无法启动：${error.message}`);
    void shutdown(1);
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    if (signal || code !== 0) console.error(`[PrintFlow] 网页服务异常退出：${signal || code}`);
    void shutdown(code || (signal ? 1 : 0));
  });
}

function localAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(`http://${entry.address}:${webPort}`);
    }
  }
  return [...new Set(addresses)];
}

function terminate(child, signal) {
  if (child.exitCode !== null || !child.pid) return;
  try {
    if (useProcessGroups) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The child may have exited between the status check and the signal.
  }
}

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) terminate(child, "SIGTERM");
  await Promise.race([
    Promise.all([
      stopAdapterService(),
      gateway.listening ? new Promise((resolveClose) => gateway.close(resolveClose)) : Promise.resolve(),
    ]),
    new Promise((resolveWait) => setTimeout(resolveWait, 1200)),
  ]);
  for (const child of children) terminate(child, "SIGKILL");
  process.exit(exitCode);
}

try {
  await startAdapterService({ siteUrl: internalSiteUrl });
  await new Promise((resolveStart, rejectStart) => {
    const onError = (error) => rejectStart(error);
    gateway.once("error", onError);
    gateway.listen(webPort, webIp, () => {
      gateway.off("error", onError);
      resolveStart();
    });
  });
  runWebService();
} catch (error) {
  console.error(`[PrintFlow] 一体服务无法启动：${error instanceof Error ? error.message : error}`);
  await stopAdapterService();
  process.exit(1);
}

console.log("");
console.log("[PrintFlow] 网页、API 与云端 MQTT Adapter 已一体启动");
console.log(`[PrintFlow] 本机访问：http://localhost:${webPort}`);
for (const address of localAddresses()) console.log(`[PrintFlow] 局域网访问：${address}`);
console.log("[PrintFlow] 首次使用请进入“打印机”设置，登录拓竹账号并填写设备序列号。");
console.log("");

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
