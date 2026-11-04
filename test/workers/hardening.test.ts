/**
 * Tests for the SECURITY.md controls that had no test of their own:
 *
 *   T1/T2  per-IP rate limit on the OAuth and MCP routes
 *   T6     Host pinning and foreign browser Origins on /mcp (DNS rebinding / cross-site use)
 *   T1     tools re-check the grant identity against the allow-list (defense in depth)
 *   T3     OAuth flow state expires after FLOW_TTL_MS, and the alarm garbage-collects it
 *   T5     the Durable Object's storage never holds a plaintext token
 *   T7     a full connect -> link -> use -> refresh -> disconnect run logs no secret
 */
import { createExecutionContext, env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { createMcpHandler } from "agents/mcp/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FLOW_TTL_MS } from "../../src/config";
import type { PendingFlow } from "../../src/do/token-vault";
import { createServer } from "../../src/mcp/server";
import { BASE, call, initialize, isoDay, linkOura, location, obtainGrant, tool, up, useFakeUpstreams } from "./helpers";

useFakeUpstreams();

const HOST = new URL(BASE).host;

describe("T1/T2 rate limiting", () => {
  it("limits each client IP to 60 requests per minute on protected routes, independently", async () => {
    const hit = (path: string, ip: string) =>
      SELF.fetch(`${BASE}${path}`, { redirect: "manual", headers: { "cf-connecting-ip": ip, host: HOST } });
    const noisy = "198.51.100.10";
    const statuses: number[] = [];
    for (let i = 0; i < 60; i++) statuses.push((await hit("/authorize", noisy)).status);
    expect(statuses.filter((s) => s === 429)).toHaveLength(0); // limit is 60 per 60 s (wrangler.jsonc)

    const limited = await hit("/authorize", noisy);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("cache-control")).toContain("no-store");
    // Every protected prefix shares the same per-IP budget.
    for (const path of ["/oauth/token", "/oauth/register", "/mcp", "/callback", "/oura/connect"]) {
      expect((await hit(path, noisy)).status, path).toBe(429);
    }

    // Another client is unaffected, and so is the unprotected health check for the noisy one.
    expect((await hit("/authorize", "198.51.100.11")).status).not.toBe(429);
    expect((await hit("/healthz", noisy)).status).toBe(200);
  });
});

describe("T6 Host pinning and Origin checks on /mcp", () => {
  async function raw(grantToken: string, headers: Record<string, string>): Promise<Response> {
    return SELF.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${grantToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "cf-connecting-ip": "198.51.100.20",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "oura_status", arguments: {} } }),
    });
  }

  it("serves a valid token only on the configured host and to non-browser or same-site callers", async () => {
    const grant = await obtainGrant();
    await initialize(grant);
    const before = up.apiCalls.length;

    // Control: the right Host with no Origin (server-to-server, like Claude) works.
    expect((await raw(grant.accessToken, { host: HOST })).status).toBe(200);

    // A rebinding attacker's hostname is refused even with a valid token.
    const rebound = await raw(grant.accessToken, { host: "attacker.example" });
    expect(rebound.status).toBe(403);
    expect(await rebound.text()).not.toContain("linked");

    // A request with no Host header at all is refused.
    const hostless = await SELF.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${grant.accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(hostless.status).toBe(403);

    // A page on another site cannot drive the endpoint from a browser, even holding a token.
    // (workers-oauth-provider reflects the Origin in CORS headers on every API response; the
    // MCP handler's Origin check is what refuses the request, so that is what is asserted.)
    const crossSite = await raw(grant.accessToken, { host: HOST, origin: "https://attacker.example" });
    expect(crossSite.status).toBe(403);
    const crossBody = await crossSite.text();
    expect(crossBody).toContain("Invalid Origin");
    expect(crossBody).not.toContain("linked");

    // A localhost-class Origin (e.g. MCP Inspector during development) is accepted.
    expect((await raw(grant.accessToken, { host: HOST, origin: "http://localhost:6274" })).status).toBe(200);

    expect(up.apiCalls.length).toBe(before); // nothing reached Oura on any refused request
  });
});

describe("T1 tools re-check the grant identity (defense in depth)", () => {
  /** The MCP server exactly as production builds it, with an explicit grant identity. */
  async function callStatusAs(props: Record<string, unknown> | undefined, envOverride: Partial<typeof env> = {}): Promise<string> {
    const handler = createMcpHandler(() => createServer({ ...env, ...envOverride }), {
      route: "/mcp",
      allowedHostnames: [new URL(BASE).hostname],
      corsOptions: false,
      ...(props ? { authContext: { props } } : {}),
    });
    const res = await handler(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: { host: HOST, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "oura_status", arguments: {} } }),
      }),
      env,
      createExecutionContext(),
    );
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const line = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? text;
    const msg = JSON.parse(line) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    return `${msg.result.isError ? "ERROR " : ""}${msg.result.content[0]!.text}`;
  }

  it("runs a tool only for the allow-listed account named in the grant", async () => {
    expect(await callStatusAs({ userId: 123456, login: "bosatsu25" })).toContain('"linked"');
  });

  it("refuses a grant whose identity is no longer allow-listed (allow-list rotated after issuance)", async () => {
    expect(await callStatusAs({ userId: 123456, login: "bosatsu25" }, { ALLOWED_GITHUB_USER_ID: "999" })).toBe("ERROR Forbidden.");
  });

  it("refuses grants with a different id, a different login, or no identity at all", async () => {
    expect(await callStatusAs({ userId: 7, login: "bosatsu25" })).toBe("ERROR Forbidden.");
    expect(await callStatusAs({ userId: 123456, login: "someone-else" })).toBe("ERROR Forbidden.");
    expect(await callStatusAs({ userId: "123456", login: "bosatsu25" })).toBe("ERROR Forbidden."); // wrong type
    expect(await callStatusAs(undefined)).toBe("ERROR Forbidden.");
  });
});

describe("T3 OAuth flow state lifetime", () => {
  const stub = () => env.TOKEN_VAULT.get(env.TOKEN_VAULT.idFromName("flow-ttl"));

  async function age(state: string, ms: number): Promise<void> {
    await runInDurableObject(stub(), async (_instance, s) => {
      const flow = await s.storage.get<PendingFlow>(`flow:${state}`);
      await s.storage.put(`flow:${state}`, { ...flow!, createdAt: flow!.createdAt - ms });
    });
  }

  it("rejects a state older than FLOW_TTL_MS and accepts a fresh one", async () => {
    await stub().putFlow("old", { kind: "oura_link" });
    await age("old", FLOW_TTL_MS + 1_000);
    expect(await stub().takeFlow("old", "oura_link")).toBeUndefined();

    await stub().putFlow("fresh", { kind: "oura_link" });
    expect(await stub().takeFlow("fresh", "oura_link")).toMatchObject({ kind: "oura_link" });
  });

  it("garbage-collects expired states on the alarm and keeps live ones", async () => {
    await stub().putFlow("stale", { kind: "oura_unlink" });
    await stub().putFlow("live", { kind: "oura_unlink" });
    await age("stale", FLOW_TTL_MS + 1_000);
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    const keys = await runInDurableObject(stub(), async (_i, s) => [...(await s.storage.list({ prefix: "flow:" })).keys()]);
    expect(keys).toEqual(["flow:live"]);
  });
});

describe("T5 tokens at rest in the Durable Object", () => {
  it("stores no plaintext token in Durable Object storage", async () => {
    const vault = env.TOKEN_VAULT.get(env.TOKEN_VAULT.idFromName("primary"));
    await vault.storeTokens({ accessToken: "AT-plaintext-marker", refreshToken: "RT-plaintext-marker", expiresAt: Date.now() + 3_600_000, scope: "daily" });
    const dump = await runInDurableObject(vault, async (_i, s) => JSON.stringify([...(await s.storage.list()).entries()]));
    expect(dump.length).toBeGreaterThan(0);
    expect(dump).not.toContain("AT-plaintext-marker");
    expect(dump).not.toContain("RT-plaintext-marker");
    expect(await vault.getAccessToken()).toEqual({ ok: true, token: "AT-plaintext-marker" });
    await vault.clearTokens();
  });
});

describe("T7 no secret reaches the logs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs nothing secret during connect, link, tool calls, refresh, failures and disconnect", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }

    const grant = await obtainGrant();
    await initialize(grant);
    await linkOura();
    const day = isoDay(-1);
    await tool(grant, "get_sleep", { start_date: day, end_date: day });
    await tool(grant, "get_heart_rate", { start_date: isoDay(-10), end_date: day }); // validation failure path
    // Force a refresh, then an upstream 401, so the error paths log too.
    const vault = env.TOKEN_VAULT.get(env.TOKEN_VAULT.idFromName("primary"));
    await vault.storeTokens({ accessToken: "oura-at-1", refreshToken: "oura-rt-1", expiresAt: Date.now() + 60_000, scope: "daily heartrate" });
    await tool(grant, "get_readiness", { start_date: day, end_date: day });
    up.ouraTokens.access = "rotated-elsewhere";
    expect((await tool(grant, "get_sleep_scores", { start_date: day, end_date: day })).text).toContain("Re-link");
    // Bad bearer and a non-allow-listed login also log.
    await call("/mcp", { method: "POST", headers: { authorization: "Bearer forged-token-value", "content-type": "application/json" }, body: "{}" });
    const disc = location(await call("/oura/disconnect"));
    await call(`/callback?code=gh-code-9&state=${disc.searchParams.get("state")}`);

    expect(lines.length).toBeGreaterThan(5); // the run did log; the check below is not vacuous
    const secrets = [
      grant.accessToken,
      grant.refreshToken,
      "oura-at-1", "oura-rt-1", "oura-at-2", "oura-rt-2", // Oura tokens before and after refresh
      "gho_", // GitHub access tokens issued by the fake
      "gh-secret", "oura-secret", // client secrets
      env.TOKEN_ENCRYPTION_KEY,
      "gh-code-1", "gh-code-2", "gh-code-9", "oura-code-1", // authorization codes
      "forged-token-value",
    ];
    for (const secret of secrets) {
      const leak = lines.find((l) => l.includes(secret));
      expect(leak, `secret ${JSON.stringify(secret.slice(0, 12))} appeared in a log line`).toBeUndefined();
    }
  });
});
