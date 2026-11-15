// Structured JSON logger. Any loaded secret value is redacted from every line,
// so even an accidental `log.info({ headers })` cannot leak a secret.
import { config, secretValues } from "./config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

function threshold(): number {
  return LEVELS[(config.logLevel as Level)] ?? LEVELS.info;
}

function redact(line: string): string {
  let out = line;
  for (const s of secretValues()) out = out.split(s).join("[REDACTED]");
  return out;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold()) return;
  const rec = { ts: new Date().toISOString(), level, msg, ...fields };
  let line: string;
  try {
    line = JSON.stringify(rec, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    line = JSON.stringify({ ts: rec.ts, level, msg, note: "unserializable fields" });
  }
  const safe = redact(line);
  if (level === "error" || level === "warn") process.stderr.write(safe + "\n");
  else process.stdout.write(safe + "\n");
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
