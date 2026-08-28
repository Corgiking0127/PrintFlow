import { env } from "cloudflare:workers";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { events, projects, settings } from "../../../db/schema";
import { requireUser } from "../../../lib/auth";

const defaultSettings = {
  weekdayMorning: "08:00-08:30",
  weekdayNoon: "12:00-13:30",
  weekdayEvening: "18:00-23:30",
  weekend: "08:00-23:30",
  reminderMinutes: 10,
  overdueMinutes: 20,
  autoReschedule: true,
  failureBuffer: 8,
  barkEndpoint: "https://api.day.app",
  barkKey: "",
};

async function ensureSchema() {
  const d1 = env.DB;
  await d1.batch([
    d1.prepare(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_url TEXT NOT NULL DEFAULT '',
      plates INTEGER NOT NULL DEFAULT 1,
      duration_minutes INTEGER NOT NULL DEFAULT 60,
      plate_durations TEXT NOT NULL DEFAULT '[]',
      plate_names TEXT NOT NULL DEFAULT '[]',
      split_by_plate INTEGER NOT NULL DEFAULT 0,
      urgent INTEGER NOT NULL DEFAULT 0,
      deadline TEXT,
      material TEXT NOT NULL DEFAULT 'PLA',
      color TEXT NOT NULL DEFAULT '自然色',
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      project_id TEXT,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_projects_status_deadline ON projects(status, deadline)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at)"),
  ]);
  const columns = await d1.prepare("PRAGMA table_info(projects)").all<{ name: string }>();
  const columnNames = new Set((columns.results || []).map((column) => column.name));
  const additions = [
    !columnNames.has("plate_durations") ? d1.prepare("ALTER TABLE projects ADD COLUMN plate_durations TEXT NOT NULL DEFAULT '[]'") : null,
    !columnNames.has("plate_names") ? d1.prepare("ALTER TABLE projects ADD COLUMN plate_names TEXT NOT NULL DEFAULT '[]'") : null,
    !columnNames.has("split_by_plate") ? d1.prepare("ALTER TABLE projects ADD COLUMN split_by_plate INTEGER NOT NULL DEFAULT 0") : null,
  ].filter((statement): statement is D1PreparedStatement => Boolean(statement));
  if (additions.length) await d1.batch(additions);
}

export async function GET(request: Request) {
  try {
    const auth = await requireUser(request);
    if ("response" in auth) return auth.response;
    await ensureSchema();
    const db = getDb();
    const [projectRows, settingRows, eventRows] = await Promise.all([
      db.select().from(projects).orderBy(desc(projects.createdAt)),
      db.select().from(settings),
      db.select().from(events).orderBy(desc(events.id)).limit(12),
    ]);
    const saved = Object.fromEntries(settingRows.map((row) => [row.key, JSON.parse(row.value)]));
    return Response.json({ projects: projectRows, settings: { ...defaultSettings, ...saved }, events: eventRows });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "读取数据失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireUser(request);
    if ("response" in auth) return auth.response;
    await ensureSchema();
    const payload = (await request.json()) as Record<string, unknown>;
    const action = String(payload.action || "");
    const db = getDb();

    if (action === "save_project") {
      const project = payload.project as typeof projects.$inferInsert;
      if (!project?.id || !project?.name) return Response.json({ error: "项目名称不能为空" }, { status: 400 });
      await db.insert(projects).values(project).onConflictDoUpdate({
        target: projects.id,
        set: {
          name: project.name,
          sourceUrl: project.sourceUrl ?? "",
          plates: project.plates ?? 1,
          durationMinutes: project.durationMinutes ?? 60,
          plateDurations: project.plateDurations ?? [],
          plateNames: project.plateNames ?? [],
          splitByPlate: project.splitByPlate ?? false,
          urgent: project.urgent ?? false,
          deadline: project.deadline ?? null,
          material: project.material ?? "PLA",
          color: project.color ?? "自然色",
          status: project.status ?? "queued",
        },
      });
      await db.insert(events).values({ type: "project_saved", projectId: project.id, detail: project.name });
      return Response.json({ ok: true });
    }

    if (action === "delete_project") {
      const id = String(payload.id || "");
      await db.delete(projects).where(eq(projects.id, id));
      await db.insert(events).values({ type: "project_deleted", projectId: id, detail: "已移除项目" });
      return Response.json({ ok: true });
    }

    if (action === "save_settings") {
      const values = payload.settings as Record<string, unknown>;
      for (const [key, value] of Object.entries(values || {})) {
        await db.insert(settings).values({ key, value: JSON.stringify(value) }).onConflictDoUpdate({
          target: settings.key,
          set: { value: JSON.stringify(value), updatedAt: new Date().toISOString() },
        });
      }
      await db.insert(events).values({ type: "settings_saved", detail: "排产规则已更新" });
      return Response.json({ ok: true });
    }

    if (action === "log_event") {
      await db.insert(events).values({
        type: String(payload.type || "activity"),
        projectId: payload.projectId ? String(payload.projectId) : null,
        detail: String(payload.detail || ""),
      });
      return Response.json({ ok: true });
    }

    return Response.json({ error: "未知操作" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "保存失败" }, { status: 500 });
  }
}
