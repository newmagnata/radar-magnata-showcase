import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { authenticator } from "otplib";
import type { Db } from "./db.ts";

const FULL_SESSION = 7 * 86_400_000;
const PRE_SESSION = 20 * 60_000;
const WINDOW = 15 * 60_000;
const MAX_FAILURES = 8;
const DUMMY_HASH = await hash(randomBytes(16).toString("hex"));

// Tolera 3 minutos de diferença entre o relógio do servidor e o do celular.
authenticator.options = { window: 6 };

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  totp_secret_enc: string;
  totp_enabled: number;
  last_totp_step: number;
}

export interface SessionInfo {
  userId: number;
  totpOk: boolean;
}

function key(secret: string): Buffer {
  return scryptSync(secret, "radar-magnata-totp", 32);
}

export function encrypt(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64")).join(".");
}

export function decrypt(payload: string, secret: string): string {
  const [iv, tag, data] = payload.split(".").map((part) => Buffer.from(part, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(secret), iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(data!), decipher.final()]).toString("utf8");
}

export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");

export class AuthService {
  private readonly db: Db;
  private readonly secret: string;

  constructor(db: Db, secret: string) {
    this.db = db;
    this.secret = secret;
  }

  needsSetup(): boolean {
    return !this.db.prepare("SELECT 1 FROM users WHERE totp_enabled = 1 LIMIT 1").get();
  }

  async createOwner(email: string, password: string): Promise<{ userId: number; secret: string }> {
    const secret = authenticator.generateSecret();
    const passwordHash = await hash(password);
    this.db.exec("DELETE FROM users WHERE totp_enabled = 0");
    const row = this.db
      .prepare("INSERT INTO users (email, password_hash, totp_secret_enc) VALUES (?, ?, ?) RETURNING id")
      .get(email.toLowerCase(), passwordHash, encrypt(secret, this.secret)) as { id: number };
    return { userId: row.id, secret };
  }

  locked(attemptKey: string): boolean {
    const row = this.db.prepare("SELECT failures, window_start FROM login_attempts WHERE key = ?").get(attemptKey) as
      | { failures: number; window_start: number }
      | undefined;
    return Boolean(row && Date.now() - row.window_start < WINDOW && row.failures >= MAX_FAILURES);
  }

  fail(attemptKey: string): void {
    this.db
      .prepare(
        `INSERT INTO login_attempts (key, failures, window_start) VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET
           failures = CASE WHEN ? - window_start >= ? THEN 1 ELSE failures + 1 END,
           window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END`,
      )
      .run(attemptKey, Date.now(), Date.now(), WINDOW, Date.now(), WINDOW, Date.now());
  }

  clearFailures(attemptKey: string): void {
    this.db.prepare("DELETE FROM login_attempts WHERE key = ?").run(attemptKey);
  }

  async checkPassword(email: string, password: string): Promise<UserRow | null> {
    const user = this.db.prepare("SELECT * FROM users WHERE email = ? AND totp_enabled = 1").get(email.toLowerCase()) as
      | UserRow
      | undefined;
    const valid = await verify(user?.password_hash ?? DUMMY_HASH, password);
    return user && valid ? user : null;
  }

  /** Aceita cada código uma única vez, mesmo dentro da janela de tolerância. */
  checkTotp(userId: number, code: string): boolean {
    const user = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
    if (!user || !/^\d{6}$/.test(code)) return false;
    const delta = authenticator.checkDelta(code, decrypt(user.totp_secret_enc, this.secret));
    if (delta === null) return false;
    const step = Math.floor(Date.now() / 30_000) + delta;
    if (step <= user.last_totp_step) return false;
    this.db.prepare("UPDATE users SET last_totp_step = ?, totp_enabled = 1 WHERE id = ?").run(step, userId);
    return true;
  }

  startSession(userId: number, totpOk: boolean): string {
    const token = randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO sessions (token_hash, user_id, totp_ok, expires_at) VALUES (?, ?, ?, ?)")
      .run(tokenHash(token), userId, totpOk ? 1 : 0, Date.now() + (totpOk ? FULL_SESSION : PRE_SESSION));
    return token;
  }

  session(token: string | undefined): SessionInfo | null {
    if (!token) return null;
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
    const row = this.db.prepare("SELECT user_id, totp_ok FROM sessions WHERE token_hash = ?").get(tokenHash(token)) as
      | { user_id: number; totp_ok: number }
      | undefined;
    return row ? { userId: row.user_id, totpOk: row.totp_ok === 1 } : null;
  }

  endSession(token: string | undefined): void {
    if (token) this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
  }

  otpauth(email: string, secret: string): string {
    return authenticator.keyuri(email, "Radar Magnata", secret);
  }
}
