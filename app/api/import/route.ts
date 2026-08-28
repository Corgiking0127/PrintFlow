import { MakerWorldDesign, MakerWorldProfileNotFoundError, makerWorldApiHost, parseMakerWorldDesign, requestedMakerWorldProfileId } from "../../../lib/makerworld";
import { requireUser } from "../../../lib/auth";

function cleanText(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

function matchMeta(html: string, key: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"),
  ];
  return patterns.map((pattern) => html.match(pattern)?.[1]).find(Boolean) || "";
}

async function readStructuredProject(target: URL) {
  const designId = target.pathname.match(/\/models\/(\d+)/)?.[1];
  const apiHost = makerWorldApiHost(target);
  if (!designId || !apiHost) return null;
  const response = await fetch(`https://${apiHost}/v1/design-service/design/${designId}`, {
    headers: { Accept: "application/json", "User-Agent": "PrintFlow/1.1" },
  });
  if (!response.ok) return null;
  const design = await response.json() as MakerWorldDesign;
  return parseMakerWorldDesign(design, target);
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

    const structured = await readStructuredProject(target).catch((error) => {
      if (error instanceof MakerWorldProfileNotFoundError) throw error;
      return null;
    });
    if (structured) {
      return Response.json({
        ...structured,
        confidence: { name: "high", plates: "high", duration: "high", perPlate: "high" },
        note: `已读取 ${structured.project.plates} 个打印盘的独立时长；可选择整项目排产或拆分到每盘。`,
      });
    }

    if (requestedMakerWorldProfileId(target)) {
      throw new Error("暂时无法读取链接指定的打印配置，请稍后重试；为避免盘数和时间错误，本次未使用其他配置代替");
    }

    const response = await fetch(target.toString(), {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PrintFlow/1.0; +https://makerworld.com)" },
      redirect: "follow",
    });
    let html = await response.text();
    let readerFallback = false;
    const reader = await fetch(`https://r.jina.ai/${target.toString()}`, {
      headers: { Accept: "text/plain", "X-Return-Format": "markdown" },
    });
    if (reader.ok) {
      const markdown = await reader.text();
      if (/^Title:/m.test(markdown)) html = markdown;
      readerFallback = true;
    } else if (!response.ok || /Just a moment|cf-chl|Enable JavaScript and cookies/i.test(html)) {
      throw new Error("MakerWorld 暂时阻止了自动读取，请稍后重试或手动录入");
    }
    const plain = readerFallback ? html.replace(/\s+/g, " ").trim() : cleanText(html);
    const titleRaw = readerFallback
      ? html.match(/^Title:\s*(.+)$/m)?.[1] || html.match(/^#\s+(.+)$/m)?.[1] || "MakerWorld 项目"
      : matchMeta(html, "og:title") || html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] || "MakerWorld 项目";
    const name = cleanText(titleRaw)
      .replace(/\s*(?:by\s+.+?)?\s*[-|:]\s*(?:Free 3D Print Model\s*[-|:]\s*)?MakerWorld.*$/i, "")
      .replace(/\s*[-|:]\s*Free 3D Print Model.*$/i, "")
      .trim();

    const profileBlock = readerFallback ? (html.split(/####\s+Print Profile[^\n]*/i)[1]?.split(/###\s+Description/i)[0] || html) : plain;
    const profileLines = profileBlock.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    let preciseHours = 0;
    let precisePlates = 0;
    for (let index = 0; index < profileLines.length; index += 1) {
      const durationLine = profileLines[index].match(/^(\d+(?:\.\d+)?)\s*h$/i);
      if (!durationLine) continue;
      const plateLine = profileLines.slice(index + 1, index + 5).map((line) => line.match(/^(\d+)\s*plates?$/i)).find(Boolean);
      if (plateLine) {
        preciseHours = Number(durationLine[1]);
        precisePlates = Number(plateLine[1]);
        break;
      }
    }
    const profilePair = profileBlock.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h|小时)[\s\S]{0,100}?(\d+)\s*(?:plates?|打印盘|盘)/i);
    const plateMatches = [...profileBlock.matchAll(/(\d+)\s*(?:plates?|打印盘|盘)/gi)].map((match) => Number(match[1]));
    const hourMatches = [...profileBlock.matchAll(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h|小时)/gi)].map((match) => Number(match[1]));
    const minuteMatches = [...profileBlock.matchAll(/(\d+)\s*(?:minutes?|mins?|分钟)/gi)].map((match) => Number(match[1]));
    const plates = precisePlates || Number(profilePair?.[2]) || plateMatches.find((value) => value > 0 && value < 100) || 0;
    let durationMinutes = Math.round((preciseHours || Number(profilePair?.[1]) || hourMatches.find((value) => value > 0 && value < 500) || 0) * 60);
    if (!durationMinutes) durationMinutes = minuteMatches.find((value) => value > 0 && value < 30000) || 0;
    if (!plates || !durationMinutes) {
      throw new Error("未能读取真实的打印盘数和打印时间；为避免错误排产，本次没有填入默认值");
    }

    return Response.json({
      project: { name, sourceUrl: target.toString(), plates, durationMinutes, plateDurations: [], plateNames: [], splitByPlate: false, material: "PLA", color: "自然色" },
      confidence: { name: "high", plates: plateMatches.length ? "medium" : "low", duration: hourMatches.length || minuteMatches.length ? "medium" : "low", perPlate: "low" },
      note: "该配置未返回逐盘数据，将按整项目排产；你也可以手动填写每盘时间。",
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "无法读取该页面" },
      { status: error instanceof MakerWorldProfileNotFoundError ? 422 : 502 },
    );
  }
}
