import { buildBarkPushUrl } from "../../../lib/bark";

export async function POST(request: Request) {
  let payload: { endpoint?: string; key?: string; title?: string; body?: string };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return Response.json({ error: "通知请求格式无效" }, { status: 400 });
  }

  let url: URL;
  try {
    url = buildBarkPushUrl(payload);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Bark 配置无效" }, { status: 400 });
  }

  try {
    const result = await fetch(url);
    const data = await result.json().catch(() => ({}));
    if (!result.ok) throw new Error("Bark 服务未接受本次通知");
    return Response.json({ ok: true, result: data });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "通知发送失败" }, { status: 502 });
  }
}
