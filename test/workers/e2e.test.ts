/**
 * End-to-end on the Workers runtime: the real OAuthProvider, Durable Object, KV and MCP
 * handler, with only the two upstreams (GitHub, Oura) replaced by an in-test fake.
 *
 * Flow covered:
 *   Claude registers (DCR) -> /authorize -> GitHub login -> /callback -> code
 *   -> /oauth/token (PKCE) -> MCP initialize / tools/list / tools/call
 *   -> /oura/connect -> GitHub -> Oura consent (PKCE S256 verified) -> /oura/callback
 *   -> every tool returns shaped data -> access-token refresh -> /oura/disconnect
 *
 * Any outbound request to a host other than GitHub/Oura fails the test.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ALLOWED,
  b64url,
  BASE,
  call,
  CLAUDE_CALLBACK,
  isoDay,
  linkOura,
  location,
  s256,
  up,
  useFakeUpstreams,
} from "./helpers";

useFakeUpstreams();


// ---------- MCP client side ----------

interface Grant {
  accessToken: string;
  refreshToken: string;
  clientId: string;
}

async function registerClient(): Promise<string> {
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
async function authorizeViaGitHub(clientId: string, verifier: string, clientState: string): Promise<Response> {
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

async function obtainGrant(): Promise<Grant> {
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
async function mcp(grant: Grant, method: string, params: Record<string, unknown> = {}): Promise<any> {
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

async function initialize(grant: Grant): Promise<any> {
  return mcp(grant, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1.0.0" },
  });
}

async function tool(grant: Grant, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; data: any }> {
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

// ---------- tests ----------

describe("end to end", () => {
  it("Claude connects, the owner links Oura, and every tool returns shaped data", async () => {
    const grant = await obtainGrant();

    const init = await initialize(grant);
    expect(init.serverInfo.name).toBe("oura-remote-mcp");
    expect(init.capabilities.tools).toBeDefined();

    const { tools } = await mcp(grant, "tools/list");
    expect((tools as Array<{ name: string }>).map((t) => t.name).sort()).toEqual(
      ["get_heart_rate", "get_readiness", "get_sleep", "get_sleep_scores", "oura_status"],
    );

    // Before linking: status says so, data tools explain how to link instead of failing opaquely.
    expect((await tool(grant, "oura_status")).data).toMatchObject({ linked: false });
    const notLinked = await tool(grant, "get_sleep", { start_date: isoDay(-2), end_date: isoDay(-1) });
    expect(notLinked.isError).toBe(true);
    expect(notLinked.text).toContain("/oura/connect");
    expect(up.apiCalls).toHaveLength(0);

    await linkOura();

    const status = await tool(grant, "oura_status");
    expect(status.data).toMatchObject({ linked: true, scope: "daily heartrate" });
    expect(status.text).not.toContain("oura-at-1");
    expect(status.text).not.toContain("oura-rt-1");

    const day = isoDay(-1);

    const sleep = await tool(grant, "get_sleep", { start_date: day, end_date: day });
    expect(sleep.isError, sleep.text).toBe(false);
    expect(sleep.data.periods).toHaveLength(1); // nap filtered out by default
    expect(sleep.data.periods[0]).toMatchObject({ day, type: "long_sleep", total_sleep_h: 6, latency_min: 9, lowest_hr_bpm: 48 });
    const sleepCall = up.apiCalls.at(-1)!;
    expect(sleepCall.resource).toBe("sleep");
    expect(sleepCall.params.get("end_date")).toBe(isoDay(0)); // end widened by one day (Oura end is exclusive)

    const withNaps = await tool(grant, "get_sleep", { start_date: day, end_date: day, include_all_periods: true });
    expect(withNaps.data.periods.map((p: { type: string }) => p.type)).toEqual(["long_sleep", "late_nap"]);

    const scores = await tool(grant, "get_sleep_scores", { start_date: day, end_date: day });
    expect(scores.data.days).toEqual([{ day, score: 84, contributors: { deep_sleep: 90, efficiency: 88 } }]);

    const readiness = await tool(grant, "get_readiness", { start_date: day, end_date: day });
    expect(readiness.data.days[0]).toMatchObject({ day, score: 79, temperature_deviation_c: -0.12 });

    const hr = await tool(grant, "get_heart_rate", { start_date: day, end_date: day });
    expect(hr.data.hourly).toEqual([
      { hour_start: `${day}T01:00:00.000Z`, samples: 2, min_bpm: 52, avg_bpm: 55, max_bpm: 58 },
      { hour_start: `${day}T02:00:00.000Z`, samples: 1, min_bpm: 71, avg_bpm: 71, max_bpm: 71 },
    ]);
    expect(up.apiCalls.at(-1)!.params.get("start_datetime")).toBe(`${day}T00:00:00+00:00`);

    // Invalid arguments are rejected before any upstream call.
    const callsBefore = up.apiCalls.length;
    const tooLong = await tool(grant, "get_heart_rate", { start_date: isoDay(-10), end_date: day });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.text).toContain("Invalid arguments");
    expect(up.apiCalls.length).toBe(callsBefore);

    // Every Oura call used the vault's token and only the fixed base URL.
    expect(up.apiCalls.every((c) => c.token === "oura-at-1")).toBe(true);
    expect(up.refreshCount).toBe(0);

    // Access token about to expire -> exactly one refresh, rotated pair persisted, new token used.
    await env.TOKEN_VAULT.get(env.TOKEN_VAULT.idFromName("primary")).storeTokens({
      accessToken: "oura-at-1",
      refreshToken: "oura-rt-1",
      expiresAt: Date.now() + 60_000,
      scope: "daily heartrate",
    });
    const afterRefresh = await tool(grant, "get_readiness", { start_date: day, end_date: day });
    expect(afterRefresh.isError, afterRefresh.text).toBe(false);
    expect(up.refreshCount).toBe(1);
    expect(up.apiCalls.at(-1)!.token).toBe("oura-at-2");
    await tool(grant, "get_sleep_scores", { start_date: day, end_date: day });
    expect(up.refreshCount).toBe(1); // fresh token is reused, not refreshed again

    // Disconnect requires a fresh GitHub login, revokes at Oura and wipes the vault.
    const disc = await call("/oura/disconnect");
    const gh = location(disc);
    const wiped = await call(`/callback?code=gh-code-3&state=${gh.searchParams.get("state")}`);
    expect(wiped.status, await wiped.clone().text()).toBe(200);
    expect(await wiped.text()).toContain("revoked and deleted");
    expect(up.revoked).toEqual(["oura-at-2"]);
    expect((await tool(grant, "oura_status")).data).toMatchObject({ linked: false });
  });

  it("an MCP refresh token yields a working access token", async () => {
    const grant = await obtainGrant();
    const res = await call("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: grant.refreshToken,
        client_id: grant.clientId,
        resource: `${BASE}/mcp`,
      }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const t = (await res.json()) as { access_token: string; refresh_token: string };
    const renewed: Grant = { ...grant, accessToken: t.access_token, refreshToken: t.refresh_token };
    await initialize(renewed);
    expect((await tool(renewed, "oura_status")).data).toMatchObject({ linked: false });
  });
});

describe("end to end: refusals", () => {
  it("a GitHub account that is not allow-listed never gets a code", async () => {
    up.githubUser = { id: 999, login: "someone-else" };
    const clientId = await registerClient();
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const res = await authorizeViaGitHub(clientId, verifier, "s");
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
  });

  it("the same login name with a different numeric id is refused", async () => {
    up.githubUser = { id: 7, login: ALLOWED.login };
    const clientId = await registerClient();
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const res = await authorizeViaGitHub(clientId, verifier, "s");
    expect(res.status).toBe(403);
  });

  it("a wrong PKCE verifier and a replayed code are both rejected", async () => {
    const clientId = await registerClient();
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const back = await authorizeViaGitHub(clientId, verifier, "s");
    const code = location(back).searchParams.get("code")!;
    const exchange = (v: string) =>
      call("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: CLAUDE_CALLBACK,
          client_id: clientId,
          code_verifier: v,
          resource: `${BASE}/mcp`,
        }),
      });
    expect((await exchange("x".repeat(64))).status).toBe(400);
    // A failed attempt must not have consumed... or leaked a token; a correct one may succeed once at most.
    const first = await exchange(verifier);
    const second = await exchange(verifier);
    expect([first.status, second.status].filter((s) => s === 200).length).toBeLessThanOrEqual(1);
    expect(second.status).toBe(400);
  });

  it("an Oura callback whose state came from a different flow kind is refused", async () => {
    // A state minted by /authorize (mcp_authorize) must not complete an Oura link.
    const clientId = await registerClient();
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLAUDE_CALLBACK,
      scope: "oura:read",
      state: "s",
      code_challenge: await s256(verifier),
      code_challenge_method: "S256",
      resource: `${BASE}/mcp`,
    });
    const gh = location(await call(`/authorize?${q}`));
    const res = await call(`/oura/callback?code=oura-code&state=${gh.searchParams.get("state")}`);
    expect(res.status).toBe(400);
    expect(up.apiCalls).toHaveLength(0);
  });
});
