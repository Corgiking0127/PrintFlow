import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startAdapterService, stopAdapterService } from "./adapter-service.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webPort = String(process.env.PRINTFLOW_WEB_PORT || 8082);
const webIp = String(process.env.PRINTFLOW_WEB_IP || "127.0.0.1");
const wrangler = resolve(projectRoot, "node_modules/.bin/wrangler");
const children = [];
const useProcessGroups = process.platform !== "win32";

function run(command, args, extraEnvironment = {}) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: { ...process.env, ...extraEnvironment },
    stdio: "inherit",
    detached: useProcessGroups,
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (stopping) return;
    if (signal || code !== 0) console.error(`[PrintFlow] 本地网页异常退出：${command} (${signal || code})`);
    void shutdown(code || (signal ? 1 : 0));
  });
  return child;
}

await startAdapterService().catch((error) => {
  console.error(`[PrintFlow] 本地 Adapter 无法启动：${error.message}`);
  process.exit(1);
});
run(wrangler, ["dev", "--config", "wrangler.local.jsonc", "--local", "--ip", webIp, "--port", webPort, "--persist-to", ".data/wrangler"]);

console.log("");
console.log(`[PrintFlow] 本地网页与云端 MQTT Adapter 正在一起启动：`);
console.log(`[PrintFlow] 打开 http://localhost:${webPort}`);
console.log("[PrintFlow] 首次使用请进入“打印机”设置，登录拓竹账号并填写设备序列号。");
console.log("");

let stopping = false;
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
    stopAdapterService(),
    new Promise((resolveWait) => setTimeout(resolveWait, 1200)),
  ]);
  for (const child of children) terminate(child, "SIGKILL");
  process.exit(exitCode);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
