import { getCurrentUser, hasAnyUser } from "../../../../lib/auth";

export async function GET(request: Request) {
  try {
    const setupRequired = !(await hasAnyUser());
    const user = setupRequired ? null : await getCurrentUser(request);
    return Response.json({ setupRequired, authenticated: Boolean(user), user }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "无法读取登录状态" }, { status: 500 });
  }
}
