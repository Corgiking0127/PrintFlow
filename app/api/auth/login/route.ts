import { createSession, findUserByAccount, verifyPassword } from "../../../../lib/auth";

export async function POST(request: Request) {
  try {
    const payload = await request.json() as Record<string, unknown>;
    const user = await findUserByAccount(String(payload.account || ""));
    const password = String(payload.password || "");
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return Response.json({ error: "账号或密码不正确" }, { status: 401 });
    }
    const cookie = await createSession(user.id, request);
    return Response.json({
      ok: true,
      user: { id: user.id, account: user.account, nickname: user.nickname, role: user.role, createdAt: user.created_at },
    }, { headers: { "Set-Cookie": cookie } });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "请求格式无效" }, { status: 400 });
    return Response.json({ error: error instanceof Error ? error.message : "登录失败" }, { status: 500 });
  }
}
