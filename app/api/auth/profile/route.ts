import { env } from "cloudflare:workers";
import {
  currentSessionHash,
  findUserByAccount,
  hashPassword,
  normalizeAccount,
  requireUser,
  validateAccount,
  validateNickname,
  validatePassword,
  verifyPassword,
} from "../../../../lib/auth";

export async function PATCH(request: Request) {
  try {
    const auth = await requireUser(request);
    if ("response" in auth) return auth.response;
    const payload = await request.json() as Record<string, unknown>;
    const account = normalizeAccount(payload.account);
    const nickname = String(payload.nickname || "").trim();
    const currentPassword = String(payload.currentPassword || "");
    const newPassword = String(payload.newPassword || "");
    const error = validateAccount(account) || validateNickname(nickname) || (newPassword ? validatePassword(newPassword) : null);
    if (error) return Response.json({ error }, { status: 400 });

    const existing = await env.DB.prepare(
      "SELECT id, account, nickname, password_hash, role, created_at FROM users WHERE id = ? LIMIT 1",
    ).bind(auth.user.id).first<{ id: string; account: string; nickname: string; password_hash: string; role: "admin" | "user"; created_at: string }>();
    if (!existing) return Response.json({ error: "用户不存在" }, { status: 404 });

    const sensitiveChange = account !== existing.account || Boolean(newPassword);
    if (sensitiveChange && !(await verifyPassword(currentPassword, existing.password_hash))) {
      return Response.json({ error: "当前密码不正确" }, { status: 400 });
    }
    const accountOwner = await findUserByAccount(account);
    if (accountOwner && accountOwner.id !== existing.id) return Response.json({ error: "该账号已被使用" }, { status: 409 });

    const passwordHash = newPassword ? await hashPassword(newPassword) : existing.password_hash;
    await env.DB.prepare(
      "UPDATE users SET account = ?, nickname = ?, password_hash = ?, updated_at = ? WHERE id = ?",
    ).bind(account, nickname, passwordHash, new Date().toISOString(), existing.id).run();

    if (newPassword) {
      const sessionHash = await currentSessionHash(request);
      await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(existing.id, sessionHash).run();
    }
    return Response.json({
      ok: true,
      user: { id: existing.id, account, nickname, role: existing.role, createdAt: existing.created_at },
    });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "请求格式无效" }, { status: 400 });
    const message = error instanceof Error ? error.message : "资料保存失败";
    const duplicate = message.includes("UNIQUE constraint failed: users.account");
    return Response.json({ error: duplicate ? "该账号已被使用" : message }, { status: duplicate ? 409 : 500 });
  }
}
