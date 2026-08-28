import { env } from "cloudflare:workers";
import {
  createSession,
  ensureAuthSchema,
  hashPassword,
  hasAnyUser,
  normalizeAccount,
  validateAccount,
  validateNickname,
  validatePassword,
} from "../../../../lib/auth";

export async function POST(request: Request) {
  try {
    await ensureAuthSchema();
    if (await hasAnyUser()) return Response.json({ error: "管理员账号已经创建，请直接登录" }, { status: 409 });

    const payload = await request.json() as Record<string, unknown>;
    const account = normalizeAccount(payload.account);
    const nickname = String(payload.nickname || "").trim();
    const password = String(payload.password || "");
    const error = validateAccount(account) || validateNickname(nickname) || validatePassword(password);
    if (error) return Response.json({ error }, { status: 400 });

    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    try {
      await env.DB.prepare(
        "INSERT INTO users (id, account, nickname, password_hash, role) VALUES (?, ?, ?, ?, 'admin')",
      ).bind(id, account, nickname, passwordHash).run();
    } catch (insertError) {
      const message = insertError instanceof Error ? insertError.message : "";
      if (message.includes("UNIQUE constraint")) {
        return Response.json({ error: "管理员账号已经创建，请直接登录" }, { status: 409 });
      }
      throw insertError;
    }

    const cookie = await createSession(id, request);
    return Response.json({
      ok: true,
      user: { id, account, nickname, role: "admin", createdAt: new Date().toISOString() },
    }, { status: 201, headers: { "Set-Cookie": cookie } });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "请求格式无效" }, { status: 400 });
    return Response.json({ error: error instanceof Error ? error.message : "创建管理员失败" }, { status: 500 });
  }
}
