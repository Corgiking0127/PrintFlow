import { MakerWorldFetchError, MakerWorldProfileNotFoundError, fetchMakerWorldDesign, makerWorldApiHost, parseMakerWorldDesign, requestedMakerWorldProfileId } from "../../../lib/makerworld";
import { requireUser } from "../../../lib/auth";

async function readStructuredProject(target: URL) {
  const designId = target.pathname.match(/\/models\/(\d+)/)?.[1];
  const apiHost = makerWorldApiHost(target);
  if (!designId) throw new Error(`链接路径 ${target.pathname} 中未找到 /models/<数字模型ID>`);
  if (!apiHost) throw new Error(`不支持的 MakerWorld 域名：${target.hostname}`);
  const apiUrl = `https://${apiHost}/v1/design-service/design/${designId}`;
  const design = await fetchMakerWorldDesign(apiUrl);
  const project = parseMakerWorldDesign(design, target);
  if (!project) {
    const profileId = requestedMakerWorldProfileId(target);
    throw new Error(`MakerWorld 已返回模型 ${designId}，但${profileId ? `打印配置 ${profileId}` : "默认打印配置"}中没有 prediction 大于 0 的打印盘数据`);
  }
  return project;
}

export async function POST(request: Request) {
  try {
    const auth = await requireUser(request);
    if ("response" in auth) return auth.response;
    const { url } = (await request.json()) as { url?: string };
    if (!url) return Response.json({ error: "请粘贴 MakerWorld 链接" }, { status: 400 });
    const target = new URL(url);
    if (!makerWorldApiHost(target)) {
      return Response.json({ error: "目前仅支持 makerworld.com 和 makerworld.com.cn 链接" }, { status: 400 });
    }

    return Response.json({
      ...await readStructuredProject(target),
      confidence: { name: "high", plates: "high", duration: "high", perPlate: "high" },
      note: "已读取每个打印盘的独立时长；可选择整项目排产或拆分到每盘。",
    });
  } catch (error) {
    if (error instanceof MakerWorldFetchError) {
      return Response.json({ error: error.message, code: error.code, attempts: error.attempts }, { status: 504 });
    }
    if (error instanceof MakerWorldProfileNotFoundError) {
      return Response.json({ error: error.message, code: error.code, profileId: error.profileId }, { status: 422 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "无法读取该页面" },
      { status: 502 },
    );
  }
}
