import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { printers } from "../../../../db/schema";
import { getPrinterAdapter } from "../../../../lib/printers/registry";
import { ensurePrinterSchema, sha256 } from "../../../../lib/printers/store";

export async function POST(request: Request) {
  try {
    await ensurePrinterSchema();
    const authorization = request.headers.get("authorization") || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!token) return Response.json({ error: "缺少桥接凭证" }, { status: 401 });

    const payload = await request.json() as Record<string, unknown>;
    const printerId = String(payload.printerId || "");
    const adapterId = String(payload.adapter || "");
    if (!printerId || !adapterId || !payload.payload) return Response.json({ error: "MQTT 数据不完整" }, { status: 400 });

    const db = getDb();
    const printer = (await db.select().from(printers).where(eq(printers.id, printerId)).limit(1))[0];
    if (!printer || printer.bridgeTokenHash !== await sha256(token)) return Response.json({ error: "桥接凭证无效" }, { status: 401 });
    if (printer.adapter !== adapterId) return Response.json({ error: "适配器与打印机配置不匹配" }, { status: 409 });

    const adapter = getPrinterAdapter(adapterId);
    if (!adapter) return Response.json({ error: "不支持的打印机适配器" }, { status: 400 });
    const telemetry = adapter.normalize(payload.payload);
    const now = new Date().toISOString();
    await db.update(printers).set({ telemetry, lastSeen: now, updatedAt: now }).where(eq(printers.id, printer.id));
    return Response.json({ ok: true, state: telemetry.state, receivedAt: telemetry.receivedAt });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "接收 MQTT 数据失败" }, { status: 500 });
  }
}
