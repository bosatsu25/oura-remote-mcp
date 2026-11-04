/**
 * Claude-compatibility check: drive the server with the official MCP client SDK
 * (@modelcontextprotocol/client), including its own OAuth implementation.
 *
 * The SDK has to discover everything itself, exactly like a remote MCP client:
 *   POST /mcp -> 401 + WWW-Authenticate(resource_metadata)
 *   -> /.well-known/oauth-protected-resource/mcp -> /.well-known/oauth-authorization-server
 *   -> DCR -> authorization URL (PKCE, resource indicator) -> [GitHub login] -> callback
 *   -> finishAuth (code exchange, iss check) -> connect -> tools/list -> tools/call
 */
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";
import type { FetchLike, OAuthClientProvider } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { BASE, call, CLAUDE_CALLBACK, isoDay, linkOura, location, up, useFakeUpstreams } from "./helpers";

useFakeUpstreams();

type ProviderState = {
  client?: Awaited<ReturnType<OAuthClientProvider["clientInformation"]>>;
  tokens?: Awaited<ReturnType<OAuthClientProvider["tokens"]>>;
  verifier: string;
  authorizationUrl?: URL;
};

/** In-memory OAuth client state, standing in for Claude's per-connector storage. */
function memoryProvider(): OAuthClientProvider & { s: ProviderState } {
  const s: ProviderState = { verifier: "" };
  return {
    s,
    get redirectUrl() {
      return CLAUDE_CALLBACK;
    },
    get clientMetadata() {
      return {
        client_name: "Claude (SDK e2e)",
        redirect_uris: [CLAUDE_CALLBACK],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    state: () => "sdk-client-state",
    clientInformation: () => s.client,
    saveClientInformation: (info) => {
      s.client = info;
    },
    tokens: () => s.tokens,
    saveTokens: (t) => {
      s.tokens = t;
    },
    redirectToAuthorization: (url) => {
      s.authorizationUrl = url;
    },
    saveCodeVerifier: (v) => {
      s.verifier = v;
    },
    codeVerifier: () => s.verifier,
  };
}

/** The SDK may only ever talk to this server; anything else would leak to the real network. */
const sdkFetch: FetchLike = async (url, init) => {
  const u = new URL(url instanceof Request ? url.url : String(url));
  expect(u.origin, `SDK fetched an unexpected origin: ${u}`).toBe(BASE);
  // The SDK aborts its controller on close(). Forwarding that signal into SELF.fetch makes workerd
  // error the body of an already-finished response, which surfaces as an unhandled AbortError in the
  // test runner (a harness artifact, not server behaviour), so it is not passed through.
  const { signal: _signal, ...rest } = init ?? {};
  return call(`${u.pathname}${u.search}`, rest);
};

describe("official MCP client SDK", () => {
  it("discovers, registers, authorizes and calls tools like a remote MCP client", async () => {
    const provider = memoryProvider();
    const transport1 = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { authProvider: provider, fetch: sdkFetch });
    const client1 = new Client({ name: "sdk-e2e", version: "1.0.0" });

    // 1. No token yet: the SDK gets 401, discovers metadata, registers via DCR and asks to redirect.
    await expect(client1.connect(transport1)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(provider.s.client?.client_id).toBeTruthy();
    const authUrl = provider.s.authorizationUrl!;
    expect(authUrl.origin + authUrl.pathname).toBe(`${BASE}/authorize`);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("resource")).toBe(`${BASE}/mcp`);
    expect(authUrl.searchParams.get("scope")).toContain("oura:read");

    // 2. The user signs in with GitHub in the browser; the server redirects back to Claude.
    const toGitHub = location(await call(`${authUrl.pathname}${authUrl.search}`));
    expect(toGitHub.hostname).toBe("github.com");
    const back = await call(`/callback?code=gh-sdk&state=${toGitHub.searchParams.get("state")}`);
    expect(back.status, await back.clone().text()).toBe(302);
    const cb = location(back);
    expect(cb.origin + cb.pathname).toBe(CLAUDE_CALLBACK);

    // 3. The SDK validates the callback (state, iss) and exchanges the code.
    await transport1.finishAuth(cb.searchParams);
    expect(provider.s.tokens?.access_token).toBeTruthy();

    // 4. Reconnect with the token and use the server.
    const client = new Client({ name: "sdk-e2e", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { authProvider: provider, fetch: sdkFetch }));
    expect(client.getServerVersion()?.name).toBe("oura-remote-mcp");

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_heart_rate", "get_readiness", "get_sleep", "get_sleep_scores", "oura_status"]);
    const sleepTool = tools.find((t) => t.name === "get_sleep")!;
    expect(sleepTool.inputSchema.required).toEqual(expect.arrayContaining(["start_date", "end_date"]));

    await linkOura();

    const day = isoDay(-1);
    const result = await client.callTool({ name: "get_sleep_scores", arguments: { start_date: day, end_date: day } });
    expect(result.isError ?? false).toBe(false);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text)).toMatchObject({ days: [{ day, score: 84 }] });
    expect(up.apiCalls.at(-1)!.resource).toBe("daily_sleep");

    // Schema validation happens in the SDK layer before the handler runs.
    const bad = await client.callTool({ name: "get_sleep_scores", arguments: { start_date: "yesterday", end_date: day } });
    expect(bad.isError).toBe(true);

    await client.close();
  });
});
