import { destroySession } from "../../../../lib/auth";

export async function POST(request: Request) {
  try {
    const cookie = await destroySession(request);
    return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie } });
  } catch {
    return Response.json({ ok: true });
  }
}
