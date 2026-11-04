/**
 * Shared harness for the Workers integration tests: a fake GitHub + Oura behind the global
 * fetch, request helpers that look like real traffic, and the owner's Oura link flow.
 */
import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, expect, vi } from "vitest";

export const BASE = "https://example.workers.dev";
export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
export const ALLOWED = { id: 123456, login: "bosatsu25" };

// ---------- helpers ----------

export const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** Each test gets its own client IP so the per-IP rate limiter never interferes. */
let ip = "203.0.113.1";
let ipCounter = 1;

export function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", ip);
  // Real traffic always carries Host; the MCP handler rejects requests without it (DNS-rebinding guard).
  headers.set("host", new URL(BASE).host);
  return SELF.fetch(`${BASE}${path}`, { redirect: "manual", ...init, headers });
}

export function location(res: Response): URL {
  const loc = res.headers.get("location");
  expect(loc, `expected a redirect, got HTTP ${res.status}`).toBeTruthy();
  return new URL(loc!);
}

// ---------- fake upstreams ----------

export interface Upstream {
  githubUser: { id: number; login: string };
  /** code_challenge the Worker sent to Oura's authorize endpoint; checked at token exchange. */
  ouraChallenge?: string;
  ouraTokens: { access: string; refresh: string; expiresIn: number };
  refreshCount: number;
  revoked: string[];
  apiCalls: Array<{ resource: string; params: URLSearchParams; token: string }>;
}

/** State of the fake GitHub/Oura for the current test (reset before each test). */
export let up: Upstream;
const realFetch = globalThis.fetch;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function formOf(req: Request): Promise<URLSearchParams> {
  const fd = await req.formData();
  const out = new URLSearchParams();
  for (const [k, v] of fd) out.append(k, String(v));
  return out;
}

async function fakeUpstream(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const url = new URL(req.url);

  if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") {
    const form = await formOf(req);
    expect(form.get("client_id")).toBe("gh-id");
    expect(form.get("client_secret")).toBe("gh-secret");
    expect(form.get("redirect_uri")).toBe(`${BASE}/callback`);
    return json({ access_token: `gho_${form.get("code")}`, token_type: "bearer", scope: "" });
  }
  if (url.origin === "https://api.github.com" && url.pathname === "/user") {
    expect(req.headers.get("authorization")).toMatch(/^Bearer gho_/);
    return json(up.githubUser);
  }
  if (url.origin === "https://api.ouraring.com" && url.pathname === "/oauth/token") {
    const form = await formOf(req);
    expect(form.get("client_id")).toBe("oura-id");
    expect(form.get("client_secret")).toBe("oura-secret");
    if (form.get("grant_type") === "authorization_code") {
      expect(form.get("redirect_uri")).toBe(`${BASE}/oura/callback`);
      // PKCE: the verifier the Worker kept server-side must hash to the challenge it sent.
      expect(await s256(form.get("code_verifier") ?? "")).toBe(up.ouraChallenge);
      return json({
        access_token: up.ouraTokens.access,
        refresh_token: up.ouraTokens.refresh,
        expires_in: up.ouraTokens.expiresIn,
        token_type: "bearer",
        scope: "daily heartrate",
      });
    }
    if (form.get("grant_type") === "refresh_token") {
      expect(form.get("refresh_token")).toBe(up.ouraTokens.refresh);
      up.refreshCount += 1;
      up.ouraTokens = { access: `oura-at-${up.refreshCount + 1}`, refresh: `oura-rt-${up.refreshCount + 1}`, expiresIn: 86_400 };
      return json({
        access_token: up.ouraTokens.access,
        refresh_token: up.ouraTokens.refresh,
        expires_in: up.ouraTokens.expiresIn,
        token_type: "bearer",
      });
    }
    return json({ error: "unsupported_grant_type" }, 400);
  }
  if (url.origin === "https://api.ouraring.com" && url.pathname === "/oauth/revoke") {
    up.revoked.push(url.searchParams.get("access_token") ?? "");
    return new Response(null, { status: 200 });
  }
  if (url.origin === "https://api.ouraring.com" && url.pathname.startsWith("/v2/usercollection/")) {
    const resource = url.pathname.slice("/v2/usercollection/".length);
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    up.apiCalls.push({ resource, params: url.searchParams, token });
    if (token !== up.ouraTokens.access) return json({ detail: "invalid token" }, 401);
    return json(ouraFixture(resource, url.searchParams));
  }
  throw new Error(`unexpected outbound fetch: ${req.method} ${req.url}`);
}

function ouraFixture(resource: string, q: URLSearchParams): { data: unknown[]; next_token: null } {
  const day = q.get("start_date") ?? isoDay(-1);
  switch (resource) {
    case "sleep":
      return {
        data: [
          {
            id: "s1", day, type: "long_sleep",
            bedtime_start: `${day}T00:30:00+09:00`, bedtime_end: `${day}T07:00:00+09:00`,
            total_sleep_duration: 21600, time_in_bed: 23400, efficiency: 92, latency: 540, awake_time: 1800,
            deep_sleep_duration: 4500, light_sleep_duration: 12600, rem_sleep_duration: 4500,
            average_hrv: 45, average_heart_rate: 55.2, lowest_heart_rate: 48, average_breath: 14.1,
          },
          {
            id: "s2", day, type: "late_nap",
            bedtime_start: `${day}T15:00:00+09:00`, bedtime_end: `${day}T15:30:00+09:00`,
            total_sleep_duration: 1500, time_in_bed: 1800, efficiency: 83, latency: 120, awake_time: 300,
            deep_sleep_duration: 0, light_sleep_duration: 1500, rem_sleep_duration: 0,
            average_hrv: null, average_heart_rate: 60, lowest_heart_rate: 57, average_breath: 15,
          },
        ],
        next_token: null,
      };
    case "daily_sleep":
      return { data: [{ day, score: 84, contributors: { deep_sleep: 90, efficiency: 88 } }], next_token: null };
    case "daily_readiness":
      return {
        data: [{ day, score: 79, temperature_deviation: -0.12, contributors: { resting_heart_rate: 92, hrv_balance: 75 } }],
        next_token: null,
      };
    case "heartrate":
      return {
        data: [
          { bpm: 52, source: "sleep", timestamp: `${day}T01:05:00+00:00` },
          { bpm: 58, source: "sleep", timestamp: `${day}T01:35:00+00:00` },
          { bpm: 71, source: "awake", timestamp: `${day}T02:10:00+00:00` },
        ],
        next_token: null,
      };
    default:
      return { data: [], next_token: null };
  }
}

/** Install the fake upstreams around every test of the calling file. */
export function useFakeUpstreams(): void {
  beforeEach(() => {
    ip = `203.0.113.${++ipCounter}`;
    up = {
      githubUser: ALLOWED,
      ouraTokens: { access: "oura-at-1", refresh: "oura-rt-1", expiresIn: 86_400 },
      refreshCount: 0,
      revoked: [],
      apiCalls: [],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(fakeUpstream as typeof fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    expect(globalThis.fetch).toBe(realFetch);
  });
}

/** Owner links Oura: /oura/connect -> GitHub -> /callback -> Oura consent -> /oura/callback. */
export async function linkOura(): Promise<void> {
  const start = await call("/oura/connect");
  const gh = location(start);
  expect(gh.origin + gh.pathname).toBe("https://github.com/login/oauth/authorize");

  const afterGh = await call(`/callback?code=gh-code-2&state=${gh.searchParams.get("state")}`);
  expect(afterGh.status, await afterGh.clone().text()).toBe(302);
  const oura = location(afterGh);
  expect(oura.origin + oura.pathname).toBe("https://cloud.ouraring.com/oauth/authorize");
  expect(oura.searchParams.get("client_id")).toBe("oura-id");
  expect(oura.searchParams.get("redirect_uri")).toBe(`${BASE}/oura/callback`);
  expect(oura.searchParams.get("scope")).toBe("daily heartrate");
  expect(oura.searchParams.get("code_challenge_method")).toBe("S256");
  up.ouraChallenge = oura.searchParams.get("code_challenge")!;

  const done = await call(`/oura/callback?code=oura-code-1&state=${oura.searchParams.get("state")}`);
  expect(done.status, await done.clone().text()).toBe(200);
  expect(await done.text()).toContain("Oura account linked");
}
