import { env } from "cloudflare:workers";

export async function ensurePrinterSchema() {
  const d1 = env.DB;
  await d1.batch([
    d1.prepare(`CREATE TABLE IF NOT EXISTS printers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'Bambu Lab X2D + AMS 2 Pro',
      adapter TEXT NOT NULL DEFAULT 'bambu-x2d-ams2pro',
      serial TEXT NOT NULL,
      local_ip TEXT NOT NULL,
      bridge_token_hash TEXT NOT NULL,
      telemetry TEXT,
      last_seen TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_printers_serial ON printers(serial)"),
  ]);
}

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createBridgeToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function safePrinterId(serial: string): string {
  const suffix = serial.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-16);
  return `x2d-${suffix || crypto.randomUUID().slice(0, 8)}`;
}
