import { env } from "cloudflare:workers";

export const SESSION_COOKIE = "printflow_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const PASSWORD_ITERATIONS = 120_000;
const encoder = new TextEncoder();
let schemaReady: Promise<void> | null = null;

export type UserRole = "admin" | "user";

export type AuthUser = {
  id: string;
  account: string;
  nickname: string;
  role: UserRole;
  createdAt: string;
};

type UserRow = {
  id: string;
  account: string;
  nickname: string;
  password_hash: string;
  role: UserRole;
  created_at: string;
};

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function publicUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    account: row.account,
    nickname: row.nickname,
    role: row.role,
    createdAt: row.created_at,
  };
}

export function normalizeAccount(value: unknown) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function validateAccount(account: string) {
  if (account.length < 3 || account.length > 32) return "账号需为 3–32 个字符";
  if (!/^[\p{L}\p{N}_.-]+$/u.test(account)) return "账号只能包含文字、数字、下划线、点或短横线";
  return null;
}

export function validateNickname(nickname: string) {
  if (!nickname || nickname.length > 32) return "昵称需为 1–32 个字符";
  return null;
}

export function validatePassword(password: string) {
  if (password.length < 8) return "密码至少需要 8 个字符";
  if (password.length > 128) return "密码不能超过 128 个字符";
  return null;
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PASSWORD_ITERATIONS },
    key,
    256,
  );
  return `pbkdf2_sha256$${PASSWORD_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, encodedHash: string) {
  const [algorithm, iterationsValue, saltValue, expectedValue] = encodedHash.split("$");
  const iterations = Number(iterationsValue);
  if (algorithm !== "pbkdf2_sha256" || !iterations || !saltValue || !expectedValue) return false;
  try {
    const salt = base64ToBytes(saltValue);
    const expected = base64ToBytes(expectedValue);
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      key,
      expected.byteLength * 8,
    );
    const actual = new Uint8Array(bits);
    if (actual.byteLength !== expected.byteLength) return false;
    let difference = 0;
    for (let index = 0; index < actual.byteLength; index += 1) difference |= actual[index] ^ expected[index];
    return difference === 0;
  } catch {
    return false;
  }
}

export async function ensureAuthSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const d1 = env.DB;
      await d1.batch([
        d1.prepare(`CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          account TEXT NOT NULL,
          nickname TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare(`CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_account ON users(account)"),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_admin ON users(role) WHERE role = 'admin'"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)"),
      ]);
      await d1.prepare("PRAGMA optimize").run();
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

export async function hasAnyUser() {
  await ensureAuthSchema();
  const row = await env.DB.prepare("SELECT id FROM users LIMIT 1").first<{ id: string }>();
  return Boolean(row);
}

export async function findUserByAccount(account: string) {
  await ensureAuthSchema();
  const row = await env.DB.prepare(
    "SELECT id, account, nickname, password_hash, role, created_at FROM users WHERE account = ? LIMIT 1",
  ).bind(normalizeAccount(account)).first<UserRow>();
  return row || null;
}

function readCookie(request: Request, name: string) {
  const cookie = request.headers.get("cookie") || "";
  for (const entry of cookie.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() === name) return decodeURIComponent(entry.slice(separator + 1).trim());
  }
  return "";
}

export async function getCurrentUser(request: Request) {
  await ensureAuthSchema();
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(`SELECT u.id, u.account, u.nickname, u.password_hash, u.role, u.created_at, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? LIMIT 1`).bind(tokenHash).first<UserRow & { expires_at: string }>();
  if (!row) return null;
  if (row.expires_at <= new Date().toISOString()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }
  return publicUser(row);
}

export async function requireUser(request: Request) {
  const user = await getCurrentUser(request);
  if (!user) return { response: Response.json({ error: "请先登录" }, { status: 401 }) } as const;
  return { user } as const;
}

export async function requireAdmin(request: Request) {
  const auth = await requireUser(request);
  if ("response" in auth) return auth;
  if (auth.user.role !== "admin") {
    return { response: Response.json({ error: "只有管理员可以执行此操作" }, { status: 403 }) } as const;
  }
  return auth;
}

export async function createSession(userId: string, request: Request) {
  await ensureAuthSchema();
  const token = randomToken();
  const tokenHash = await sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(new Date().toISOString()),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(tokenHash, userId, expiresAt),
  ]);
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

export async function destroySession(request: Request) {
  await ensureAuthSchema();
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export async function currentSessionHash(request: Request) {
  const token = readCookie(request, SESSION_COOKIE);
  return token ? sha256(token) : "";
}

export function toPublicUser(row: UserRow) {
  return publicUser(row);
}
