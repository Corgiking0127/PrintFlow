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

export async function POST(request: Request) {
  try {
    const { url } = (await request.json()) as { url?: string };
    if (!url) return Response.json({ error: "请粘贴 MakerWorld 链接" }, { status: 400 });
    const target = new URL(url);
    if (!/(^|\.)makerworld\.com$/i.test(target.hostname)) {
      return Response.json({ error: "目前仅支持 makerworld.com 链接" }, { status: 400 });
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
    const plates = precisePlates || Number(profilePair?.[2]) || plateMatches.find((value) => value > 0 && value < 100) || 1;
    let durationMinutes = Math.round((preciseHours || Number(profilePair?.[1]) || hourMatches.find((value) => value > 0 && value < 500) || 0) * 60);
    if (!durationMinutes) durationMinutes = minuteMatches.find((value) => value > 0 && value < 30000) || 60;

    return Response.json({
      project: { name, sourceUrl: target.toString(), plates, durationMinutes, material: "PLA", color: "自然色" },
      confidence: { name: "high", plates: plateMatches.length ? "medium" : "low", duration: hourMatches.length || minuteMatches.length ? "medium" : "low" },
      note: "MakerWorld 可能包含多个打印配置，请在录入前确认系统选中的盘数与总时长。",
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "无法读取该页面" }, { status: 502 });
  }
}
