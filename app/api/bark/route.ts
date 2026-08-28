export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as { key?: string; title?: string; body?: string };
    const key = payload.key?.trim().replace(/^https?:\/\/api\.day\.app\//, "").replace(/\/$/, "");
    if (!key || !/^[A-Za-z0-9_-]{6,}$/.test(key)) {
      return Response.json({ error: "请填写有效的 Bark Key" }, { status: 400 });
    }
    const title = encodeURIComponent(payload.title || "PrintFlow 测试通知");
    const body = encodeURIComponent(payload.body || "Bark 已连接，打印提醒可以正常送达。");
    const result = await fetch(`https://api.day.app/${key}/${title}/${body}?group=PrintFlow&sound=bell&level=timeSensitive`);
    const data = await result.json().catch(() => ({}));
    if (!result.ok) throw new Error("Bark 服务未接受本次通知");
    return Response.json({ ok: true, result: data });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "通知发送失败" }, { status: 502 });
  }
}
