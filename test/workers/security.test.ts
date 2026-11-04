/**
 * Integration tests on the Workers runtime (miniflare via @cloudflare/vitest-pool-workers).
 * These exercise the real OAuthProvider + Durable Object wiring.
 *
 * Run with: npm run test:workers
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "https://example.workers.dev";

describe("perimeter", () => {
  it("rejects unauthenticated MCP requests with 401 and no body leakage", async () => {
    const res = await SELF.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").toMatch(/Bearer/i);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toContain("max-age");
  });

  it("rejects a forged bearer token", async () => {
    const res = await SELF.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-real-token", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("publishes RFC 9728 protected resource metadata pointing at itself", async () => {
    const res = await SELF.fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(json.resource).toBe(`${BASE}/mcp`);
    expect(json.authorization_servers).toContain(BASE);
  });

  it("publishes RFC 8414 authorization server metadata without implicit flow", async () => {
    const res = await SELF.fetch(`${BASE}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { response_types_supported: string[]; code_challenge_methods_supported: string[] };
    expect(json.response_types_supported).not.toContain("token");
    expect(json.code_challenge_methods_supported).toContain("S256");
  });

  it("honours the kill switch for every route", async () => {
    const killed = { ...env, KILL_SWITCH: "1" };
    const mod = await import("../../src/index");
    for (const path of ["/healthz", "/mcp", "/authorize", "/oura/connect"]) {
      const res = await mod.default.fetch(new Request(`${BASE}${path}`), killed, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
      expect(res.status, path).toBe(503);
    }
  });

  it("/authorize with an unknown client is rejected locally (no open redirect)", async () => {
    const url = new URL(`${BASE}/authorize`);
    url.searchParams.set("client_id", "does-not-exist");
    url.searchParams.set("redirect_uri", "https://attacker.example/cb");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", "x".repeat(43));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", "s");
    const res = await SELF.fetch(url.toString(), { redirect: "manual" });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("/callback with an unknown state is rejected and never contacts GitHub", async () => {
    const res = await SELF.fetch(`${BASE}/callback?code=abc&state=${"A".repeat(43)}`, { redirect: "manual" });
    expect(res.status).toBe(400);
  });

  it("/oura/callback cannot be used without a verified link flow", async () => {
    const res = await SELF.fetch(`${BASE}/oura/callback?code=abc&state=${"B".repeat(43)}`, { redirect: "manual" });
    expect(res.status).toBe(400);
  });

  it("unknown routes 404 with hardened headers", async () => {
    const res = await SELF.fetch(`${BASE}/admin`);
    expect(res.status).toBe(404);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});

describe("token vault durable object", () => {
  it("stores and returns an access token without refreshing when fresh", async () => {
    const id = env.TOKEN_VAULT.idFromName("primary");
    const stub = env.TOKEN_VAULT.get(id);
    await stub.storeTokens({ accessToken: "AT", refreshToken: "RT", expiresAt: Date.now() + 3_600_000, scope: "daily" });
    expect(await stub.getAccessToken()).toEqual({ ok: true, token: "AT" });
    const status = await stub.status();
    expect(status.linked).toBe(true);
    await stub.clearTokens();
    expect((await stub.status()).linked).toBe(false);
    // Expected failures cross the RPC boundary as data, with their code intact.
    expect(await stub.getAccessToken()).toEqual({ ok: false, code: "not_linked" });
  });

  it("flow state is single-use and kind-checked", async () => {
    const id = env.TOKEN_VAULT.idFromName("primary");
    const stub = env.TOKEN_VAULT.get(id);
    await stub.putFlow("state-1", { kind: "oura_link" });
    expect(await stub.takeFlow("state-1", "mcp_authorize")).toBeUndefined(); // wrong kind consumes it
    expect(await stub.takeFlow("state-1", "oura_link")).toBeUndefined(); // already consumed
  });
});
