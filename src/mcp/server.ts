/**
 * MCP server factory: four read-only tools. No resources, no prompts, no writes.
 *
 * Every tool:
 *  1. re-checks the grant identity (defense in depth; the OAuth layer already did),
 *  2. validates arguments with the dependency-free validators in core/validate,
 *  3. obtains a short-lived Oura access token from the vault,
 *  4. calls the fixed Oura endpoint and returns a compact, shaped result.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import * as z from "zod";
import { assertAllowed, IdentityError } from "../auth/github";
import { MAX_HEARTRATE_RANGE_DAYS, MAX_RANGE_DAYS } from "../config";
import { fetchCollection, OuraApiError } from "../core/oura-client";
import { log, safeErrorMessage } from "../core/redact";
import {
  aggregateHeartRateHourly,
  shapeDailySleep,
  shapeReadiness,
  shapeSleepPeriods,
  type OuraDailyReadinessDoc,
  type OuraDailySleepDoc,
  type OuraHeartRateSample,
  type OuraSleepDoc,
} from "../core/shape";
import { VaultError } from "../core/token-vault-core";
import { addDays, formatIsoDate, parseIsoDate, validateDateRange, ValidationError } from "../core/validate";
import { vault } from "../do/token-vault";
import type { Env, GrantProps } from "../env";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

function requireOwner(env: Env): GrantProps {
  const props = getMcpAuthContext()?.props as Partial<GrantProps> | undefined;
  if (!props || typeof props.userId !== "number" || typeof props.login !== "string") {
    throw new IdentityError("missing grant identity");
  }
  assertAllowed(env, { id: props.userId, login: props.login });
  return { userId: props.userId, login: props.login };
}

/** Uniform error mapping; messages are safe to show to the client and never include upstream bodies. */
async function guarded(tool: string, env: Env, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  const started = Date.now();
  try {
    requireOwner(env);
    const result = await fn();
    log.info({ event: "tool_ok", tool, ms: Date.now() - started });
    return result;
  } catch (err) {
    log.warn({ event: "tool_error", tool, ms: Date.now() - started, reason: safeErrorMessage(err) });
    if (err instanceof ValidationError) return fail(`Invalid arguments: ${err.message}`);
    if (err instanceof IdentityError) return fail("Forbidden.");
    if (err instanceof VaultError) {
      if (err.code === "not_linked") return fail("Oura is not linked. Open /oura/connect on the server once.");
      return fail("Oura token refresh failed. Re-link via /oura/connect.");
    }
    if (err instanceof OuraApiError) {
      if (err.status === 401) return fail("Oura rejected the token. Re-link via /oura/connect.");
      if (err.status === 403) return fail("Oura scope missing for this data.");
      if (err.status === 429) return fail("Oura rate limit reached; try again later.");
      return fail("Oura API error.");
    }
    return fail("Internal error.");
  }
}

export function createServer(env: Env): McpServer {
  const server = new McpServer({ name: "oura-remote-mcp", version: "0.1.0" });

  server.registerTool(
    "oura_status",
    {
      description: "Whether an Oura account is linked and when its token expires. Contains no health data.",
      inputSchema: z.object({}),
    },
    async () =>
      guarded("oura_status", env, async () => {
        const s = await vault(env).status();
        return ok({
          linked: s.linked,
          token_expires_at: s.expiresAt ? new Date(s.expiresAt).toISOString() : null,
          scope: s.scope ?? null,
          linked_at: s.linkedAt ? new Date(s.linkedAt).toISOString() : null,
        });
      }),
  );

  server.registerTool(
    "get_sleep",
    {
      description:
        `Sleep periods between start_date and end_date (inclusive, max ${MAX_RANGE_DAYS} days): bedtime start/end, ` +
        "total sleep, efficiency, latency, stages, average HRV, lowest/average heart rate. " +
        "By default only the main nightly sleep (type long_sleep) is returned; set include_all_periods for naps.",
      inputSchema: z.object({
        start_date: DATE,
        end_date: DATE,
        include_all_periods: z.boolean().optional(),
      }),
    },
    async ({ start_date, end_date, include_all_periods }) =>
      guarded("get_sleep", env, async () => {
        const range = validateDateRange(start_date, end_date);
        const accessToken = await vault(env).getAccessToken();
        // Oura's /sleep treats end_date as exclusive; widen by one day so the last day is included.
        const endExclusive = formatIsoDate(addDays(parseIsoDate(range.end, "end_date"), 1));
        const { data, pages, truncated } = await fetchCollection<OuraSleepDoc>(
          { fetchFn: fetch, accessToken },
          "sleep",
          { start_date: range.start, end_date: endExclusive },
        );
        const periods = shapeSleepPeriods(data, include_all_periods === true).filter(
          (p) => p.day >= range.start && p.day <= range.end,
        );
        log.info({ event: "oura_fetch", tool: "get_sleep", pages, records: periods.length });
        return ok({ range, periods, truncated });
      }),
  );

  server.registerTool(
    "get_sleep_scores",
    {
      description: `Daily sleep scores with contributors (deep sleep, efficiency, latency, REM, restfulness, timing, total sleep). Max ${MAX_RANGE_DAYS} days.`,
      inputSchema: z.object({ start_date: DATE, end_date: DATE }),
    },
    async ({ start_date, end_date }) =>
      guarded("get_sleep_scores", env, async () => {
        const range = validateDateRange(start_date, end_date);
        const accessToken = await vault(env).getAccessToken();
        const { data, pages, truncated } = await fetchCollection<OuraDailySleepDoc>(
          { fetchFn: fetch, accessToken },
          "daily_sleep",
          { start_date: range.start, end_date: range.end },
        );
        const days = shapeDailySleep(data);
        log.info({ event: "oura_fetch", tool: "get_sleep_scores", pages, records: days.length });
        return ok({ range, days, truncated });
      }),
  );

  server.registerTool(
    "get_readiness",
    {
      description: `Daily readiness (recovery) scores with contributors such as resting heart rate, HRV balance, body temperature, recovery index. Max ${MAX_RANGE_DAYS} days.`,
      inputSchema: z.object({ start_date: DATE, end_date: DATE }),
    },
    async ({ start_date, end_date }) =>
      guarded("get_readiness", env, async () => {
        const range = validateDateRange(start_date, end_date);
        const accessToken = await vault(env).getAccessToken();
        const { data, pages, truncated } = await fetchCollection<OuraDailyReadinessDoc>(
          { fetchFn: fetch, accessToken },
          "daily_readiness",
          { start_date: range.start, end_date: range.end },
        );
        const days = shapeReadiness(data);
        log.info({ event: "oura_fetch", tool: "get_readiness", pages, records: days.length });
        return ok({ range, days, truncated });
      }),
  );

  server.registerTool(
    "get_heart_rate",
    {
      description: `Heart rate aggregated per hour (UTC) between start_date and end_date (max ${MAX_HEARTRATE_RANGE_DAYS} days): samples, min/avg/max bpm.`,
      inputSchema: z.object({ start_date: DATE, end_date: DATE }),
    },
    async ({ start_date, end_date }) =>
      guarded("get_heart_rate", env, async () => {
        const range = validateDateRange(start_date, end_date, { maxDays: MAX_HEARTRATE_RANGE_DAYS });
        const accessToken = await vault(env).getAccessToken();
        const endExclusive = formatIsoDate(addDays(parseIsoDate(range.end, "end_date"), 1));
        const { data, pages, truncated } = await fetchCollection<OuraHeartRateSample>(
          { fetchFn: fetch, accessToken },
          "heartrate",
          { start_datetime: `${range.start}T00:00:00+00:00`, end_datetime: `${endExclusive}T00:00:00+00:00` },
        );
        const hourly = aggregateHeartRateHourly(data);
        log.info({ event: "oura_fetch", tool: "get_heart_rate", pages, records: hourly.length });
        return ok({ range, hourly, truncated });
      }),
  );

  return server;
}
