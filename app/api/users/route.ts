import { env } from "cloudflare:workers";
import {
  hashPassword,
  normalizeAccount,
  requireAdmin,
  validateAccount,
  validateNickname,
  validatePassword,
} from "../../../lib/auth";

type ListedUser = {
  id: string;
  account: string;
  nickname: string;
  role: "admin" | "user";
  created_at: string;
};

export async function GET(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if ("response" in auth) return auth.response;
    const rows = await env.DB.prepare(
      "SELECT id, account, nickname, role, created_at FROM users ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, created_at ASC",
    ).all<ListedUser>();
    return Response.json({
      users: (rows.results || []).map((user) => ({
        id: user.id,
        account: user.account,
        nickname: user.nickname,
        role: user.role,
        createdAt: user.created_at,
      })),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "读取用户失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if ("response" in auth) return auth.response;
    const payload = await request.json() as Record<string, unknown>;
    const account = normalizeAccount(payload.account);
    const nickname = String(payload.nickname || "").trim();
    const password = String(payload.password || "");
    const error = validateAccount(account) || validateNickname(nickname) || validatePassword(password);
    if (error) return Response.json({ error }, { status: 400 });

    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    await env.DB.prepare(
      "INSERT INTO users (id, account, nickname, password_hash, role) VALUES (?, ?, ?, ?, 'user')",
    ).bind(id, account, nickname, passwordHash).run();
    return Response.json({
      ok: true,
      user: { id, account, nickname, role: "user", createdAt: new Date().toISOString() },
    }, { status: 201 });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "请求格式无效" }, { status: 400 });
    const message = error instanceof Error ? error.message : "创建用户失败";
    const duplicate = message.includes("UNIQUE constraint failed: users.account");
    return Response.json({ error: duplicate ? "该账号已被使用" : message }, { status: duplicate ? 409 : 500 });
  }
}
