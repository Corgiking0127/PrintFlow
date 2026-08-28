import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { printers } from "../../../db/schema";
import { createBridgeToken, ensurePrinterSchema, safePrinterId, sha256 } from "../../../lib/printers/store";
import { isUnconfirmedPlaceholderTelemetry, X2D_AMS2_ADAPTER_ID } from "../../../lib/printers/types";

function publicPrinter(row: typeof printers.$inferSelect) {
  const { bridgeTokenHash: _secret, ...printer } = row;
  void _secret;
  const telemetry = isUnconfirmedPlaceholderTelemetry(printer.telemetry) ? null : printer.telemetry;
  return { ...printer, telemetry, dataUpdatedAt: telemetry?.receivedAt ?? null };
}

export async function GET() {
  try {
    await ensurePrinterSchema();
    const rows = await getDb().select().from(printers).orderBy(desc(printers.updatedAt));
    return Response.json({ printers: rows.map(publicPrinter) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "读取打印机失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await ensurePrinterSchema();
    const payload = await request.json() as Record<string, unknown>;
    const action = String(payload.action || "save");
    const db = getDb();

    if (action === "delete") {
      const id = String(payload.id || "");
      if (!id) return Response.json({ error: "缺少打印机 ID" }, { status: 400 });
      await db.delete(printers).where(eq(printers.id, id));
      return Response.json({ ok: true });
    }

    if (action !== "save") return Response.json({ error: "未知操作" }, { status: 400 });

    const name = String(payload.name || "X2D 工作站").trim();
    const serial = String(payload.serial || "").trim().toUpperCase();
    const localIp = String(payload.connectionHost || payload.localIp || "").trim();
    const adapter = String(payload.adapter || X2D_AMS2_ADAPTER_ID);
    if (!serial || !localIp) return Response.json({ error: "缺少打印机序列号或云端节点" }, { status: 400 });
    if (!/^[A-Z0-9_-]{6,32}$/.test(serial)) return Response.json({ error: "打印机序列号格式不正确" }, { status: 400 });
    if (adapter !== X2D_AMS2_ADAPTER_ID) return Response.json({ error: "当前仅支持 X2D + AMS 2 Pro 适配器" }, { status: 400 });

    const requestedId = String(payload.id || "");
    const id = requestedId || safePrinterId(serial);
    const existing = requestedId ? (await db.select().from(printers).where(eq(printers.id, requestedId)).limit(1))[0] : undefined;
    const rotateToken = payload.rotateToken !== false || !existing;
    const bridgeToken = rotateToken ? createBridgeToken() : null;
    const bridgeTokenHash = bridgeToken ? await sha256(bridgeToken) : existing?.bridgeTokenHash;
    if (!bridgeTokenHash) return Response.json({ error: "无法生成桥接凭证" }, { status: 500 });
    const now = new Date().toISOString();

    await db.insert(printers).values({
      id,
      name,
      model: "Bambu Lab X2D + AMS 2 Pro",
      adapter,
      serial,
      localIp,
      bridgeTokenHash,
      telemetry: existing?.telemetry || null,
      lastSeen: existing?.lastSeen || null,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: printers.id,
      set: { name, model: "Bambu Lab X2D + AMS 2 Pro", adapter, serial, localIp, bridgeTokenHash, updatedAt: now },
    });

    const saved = (await db.select().from(printers).where(eq(printers.id, id)).limit(1))[0];
    return Response.json({ ok: true, printer: publicPrinter(saved), bridgeToken });
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存打印机失败";
    const duplicate = message.includes("UNIQUE constraint failed: printers.serial");
    return Response.json({ error: duplicate ? "该序列号已配置" : message }, { status: duplicate ? 409 : 500 });
  }
}
