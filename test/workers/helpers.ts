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

// ---------- MCP client side ----------

export interface Grant {
  accessToken: string;
  refreshToken: string;
  clientId: string;
}

export async function registerClient(): Promise<string> {
  const res = await call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [CLAUDE_CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const body = (await res.json()) as { client_id: string };
  expect(body.client_id).toBeTruthy();
  return body.client_id;
}

/** Runs /authorize -> GitHub -> /callback and returns the /callback response (redirect to Claude, or an error). */
export async function authorizeViaGitHub(clientId: string, verifier: string, clientState: string): Promise<Response> {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    scope: "oura:read",
    state: clientState,
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
    resource: `${BASE}/mcp`,
  });
  const start = await call(`/authorize?${q}`);
  expect(start.status, await start.clone().text()).toBe(302);
  const gh = location(start);
  expect(gh.origin + gh.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(gh.searchParams.get("client_id")).toBe("gh-id");
  expect(gh.searchParams.get("redirect_uri")).toBe(`${BASE}/callback`);
  const state = gh.searchParams.get("state")!;
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return call(`/callback?code=gh-code-1&state=${state}`);
}

export async function obtainGrant(): Promise<Grant> {
  const clientId = await registerClient();
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const back = await authorizeViaGitHub(clientId, verifier, "claude-state-1");
  expect(back.status, await back.clone().text()).toBe(302);
  const cb = location(back);
  expect(cb.origin + cb.pathname).toBe(CLAUDE_CALLBACK);
  expect(cb.searchParams.get("state")).toBe("claude-state-1");
  const code = cb.searchParams.get("code")!;
  expect(code).toBeTruthy();

  const tok = await call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CLAUDE_CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${BASE}/mcp`,
    }),
  });
  expect(tok.status, await tok.clone().text()).toBe(200);
  const t = (await tok.json()) as { access_token: string; refresh_token: string; token_type: string; scope: string };
  expect(t.token_type.toLowerCase()).toBe("bearer");
  expect(t.scope).toContain("oura:read");
  return { accessToken: t.access_token, refreshToken: t.refresh_token, clientId };
}

let rpcId = 0;

/** One JSON-RPC request over Streamable HTTP; accepts either a JSON or an SSE response. */
export async function mcp(grant: Grant, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const res = await call("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${grant.accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  const payload = res.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .find((l) => l.includes('"id"'))
    : text;
  const msg = JSON.parse(payload ?? "null");
  expect(msg?.error, JSON.stringify(msg?.error)).toBeUndefined();
  return msg.result;
}

export async function initialize(grant: Grant): Promise<any> {
  return mcp(grant, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1.0.0" },
  });
}

export async function tool(grant: Grant, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; data: any }> {
  const result = await mcp(grant, "tools/call", { name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>).map((c) => c.text).join("");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { isError: result.isError === true, text, data };
}
