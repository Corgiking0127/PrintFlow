import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  sourceUrl: text("source_url").notNull().default(""),
  plates: integer("plates").notNull().default(1),
  durationMinutes: integer("duration_minutes").notNull().default(60),
  plateDurations: text("plate_durations", { mode: "json" }).$type<number[]>().notNull().default(sql`'[]'`),
  plateNames: text("plate_names", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  splitByPlate: integer("split_by_plate", { mode: "boolean" }).notNull().default(false),
  urgent: integer("urgent", { mode: "boolean" }).notNull().default(false),
  deadline: text("deadline"),
  material: text("material").notNull().default("PLA"),
  color: text("color").notNull().default("自然色"),
  status: text("status").notNull().default("queued"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_projects_status_deadline").on(table.status, table.deadline)]);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  projectId: text("project_id"),
  detail: text("detail").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_events_created_at").on(table.createdAt)]);
