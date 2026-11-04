/**
 * Strict input validation for tool arguments. Independent of any schema
 * library so it can be unit-tested without dependencies; the MCP layer
 * additionally declares zod schemas for the client-facing contract.
 */

import { MAX_RANGE_DAYS } from "../config";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export class ValidationError extends Error {
  override readonly name = "ValidationError";
}

/** Parse YYYY-MM-DD into a UTC Date at midnight; rejects impossible dates. */
export function parseIsoDate(value: unknown, field: string): Date {
  if (typeof value !== "string") throw new ValidationError(`${field}: must be a string YYYY-MM-DD`);
  const m = DATE_RE.exec(value);
  if (!m) throw new ValidationError(`${field}: must match YYYY-MM-DD`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    throw new ValidationError(`${field}: not a real calendar date`);
  }
  return date;
}

export function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export interface DateRange {
  start: string;
  end: string;
  days: number;
}

/**
 * Validate a closed date range [start, end].
 *  - end >= start
 *  - end <= today + 1 (ring data is written in the user's local day; allow one day of slack)
 *  - span <= maxDays
 */
export function validateDateRange(
  startRaw: unknown,
  endRaw: unknown,
  opts: { maxDays?: number; now?: Date } = {},
): DateRange {
  const maxDays = opts.maxDays ?? MAX_RANGE_DAYS;
  const now = opts.now ?? new Date();
  const start = parseIsoDate(startRaw, "start_date");
  const end = parseIsoDate(endRaw, "end_date");
  if (end.getTime() < start.getTime()) throw new ValidationError("end_date must be >= start_date");
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (end.getTime() > addDays(todayUtc, 1).getTime()) {
    throw new ValidationError("end_date is in the future");
  }
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days > maxDays) throw new ValidationError(`range exceeds ${maxDays} days`);
  return { start: formatIsoDate(start), end: formatIsoDate(end), days };
}

/** Oura's next_token is opaque; only accept a conservative character set. */
export function validateNextToken(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9._~+/=-]+$/.test(value)) {
    throw new ValidationError("invalid pagination token");
  }
  return value;
}
