import { env } from "cloudflare:workers";
import { MakerWorldDesign, MakerWorldFetchError, MakerWorldProfileNotFoundError, fetchMakerWorldDesign, makerWorldApiHost, parseMakerWorldDesign, requestedMakerWorldProfileId, serializeErrorForDiagnostics } from "../../../lib/makerworld";
import { requireUser } from "../../../lib/auth";

function runtimeDetails() {
  return {
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "navigator unavailable",
    nodeVersion: typeof process !== "undefined" ? process.version : "process unavailable",
  };
}

async function readStructuredProject(target: URL, injectedDesign?: MakerWorldDesign) {
  const designId = target.pathname.match(/\/models\/(\d+)/)?.[1];
  const apiHost = makerWorldApiHost(target);
  if (!designId) throw new Error(`链接路径 ${target.pathname} 中未找到 /models/<数字模型ID>`);
  if (!apiHost) throw new Error(`不支持的 MakerWorld 域名：${target.hostname}`);
  const apiUrl = `https://${apiHost}/v1/design-service/design/${designId}`;
  const design = injectedDesign || await fetchMakerWorldDesign(apiUrl);
  const project = parseMakerWorldDesign(design, target);
  if (!project) {
    const profileId = requestedMakerWorldProfileId(target);
    throw new Error(`MakerWorld 已返回模型 ${designId}，但${profileId ? `打印配置 ${profileId}` : "默认打印配置"}中没有 prediction 大于 0 的打印盘数据`);
  }
  return project;
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  try {
    const auth = await requireUser(request);
    if ("response" in auth) return auth.response;
    const { url, design } = (await request.json()) as { url?: string; design?: MakerWorldDesign };
    if (!url) return Response.json({ error: "请粘贴 MakerWorld 链接" }, { status: 400 });
    if (design) {
      const expectedSecret = String((env as unknown as Record<string, unknown>).PRINTFLOW_INTERNAL_SECRET || "");
      const suppliedSecret = request.headers.get("x-printflow-internal-secret") || "";
      if (!expectedSecret || suppliedSecret !== expectedSecret) {
        return Response.json({ error: "不允许从外部注入 MakerWorld 结构化数据" }, { status: 403 });
      }
    }
    const target = new URL(url);
    if (!makerWorldApiHost(target)) {
      return Response.json({ error: "目前仅支持 makerworld.com 和 makerworld.com.cn 链接" }, { status: 400 });
    }

    return Response.json({
      ...await readStructuredProject(target, design),
      confidence: { name: "high", plates: "high", duration: "high", perPlate: "high" },
      note: "已读取每个打印盘的独立时长；可选择整项目排产或拆分到每盘。",
    });
  } catch (error) {
    const finishedAtMs = Date.now();
    const errorLog = {
      requestId,
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      runtime: runtimeDetails(),
      request: { method: request.method, endpoint: new URL(request.url).pathname },
      error: serializeErrorForDiagnostics(error),
      attempts: error instanceof MakerWorldFetchError ? error.attempts : [],
    };
    console.error(`[PrintFlow MakerWorld import ${requestId}]\n${JSON.stringify(errorLog, null, 2)}`);
    if (error instanceof MakerWorldFetchError) {
      const status = error.code === "MAKERWORLD_UPSTREAM_TIMEOUT" ? 504 : 502;
      return Response.json({ error: error.message, code: error.code, attempts: error.attempts, errorLog }, { status });
    }
    if (error instanceof MakerWorldProfileNotFoundError) {
      return Response.json({ error: error.message, code: error.code, profileId: error.profileId, errorLog }, { status: 422 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "无法读取该页面", code: "MAKERWORLD_IMPORT_UNEXPECTED", errorLog },
      { status: 502 },
    );
  }
}
