/**
 * Structured, allow-listed logging.
 *
 * Rules enforced here (and by test/unit/redact.test.ts):
 *  - Only primitive values from an explicit allow-list of keys are emitted.
 *  - Anything that looks like a bearer token, OAuth code, refresh token, or
 *    Oura/GitHub credential is replaced before it reaches console.*.
 *  - Health data never goes through this module: tool handlers must not log
 *    payloads. The allow-list simply has no key for them.
 */

const ALLOWED_KEYS = new Set([
  "event",
  "route",
  "method",
  "status",
  "ms",
  "tool",
  "reason",
  "pages",
  "records",
  "ip_hash",
  "user_id", // GitHub numeric id of the single allowed user; not secret
]);

const SECRET_PATTERNS: RegExp[] = [
  /bearer\s+[a-z0-9._~+/=-]+/gi,
  /\b(access|refresh|id)_token\b["'=:\s]*[a-z0-9._~+/=-]{8,}/gi,
  /\b(code|state|client_secret|code_verifier)=[a-z0-9._~+/=-]{8,}/gi,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\b[A-Z0-9]{32,}\b/g, // long uppercase credential-looking blobs (Oura tokens)
  /\b[A-Za-z0-9_-]{40,}\b/g, // long opaque tokens
];

export function redactString(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

export type LogFields = Record<string, string | number | boolean | undefined>;

export function sanitizeFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED_KEYS.has(k)) continue;
    if (v === undefined) continue;
    out[k] = typeof v === "string" ? redactString(v).slice(0, 200) : v;
  }
  return out;
}

export function safeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactString(msg).slice(0, 200);
}

export interface Logger {
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}

export function createLogger(sink: Pick<Console, "log" | "warn" | "error"> = console): Logger {
  return {
    info: (f) => sink.log(JSON.stringify({ level: "info", ...sanitizeFields(f) })),
    warn: (f) => sink.warn(JSON.stringify({ level: "warn", ...sanitizeFields(f) })),
    error: (f) => sink.error(JSON.stringify({ level: "error", ...sanitizeFields(f) })),
  };
}

export const log: Logger = createLogger();
