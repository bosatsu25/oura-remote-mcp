/**
 * Worker entry point.
 *
 *   OAuthProvider (workers-oauth-provider)
 *     ├─ /mcp               bearer-protected  -> createMcpHandler(createServer)
 *     ├─ /oauth/token       provider-owned
 *     ├─ /oauth/register    provider-owned (DCR; Claude registers itself)
 *     ├─ /.well-known/...   provider-owned (RFC 8414 / RFC 9728 metadata)
 *     └─ everything else    handleDefault (authorize, GitHub/Oura callbacks, health)
 *
 * Before the provider runs: kill switch, then per-IP rate limiting.
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { handleDefault } from "./auth/handlers";
import { MCP_SCOPE_READ } from "./config";
import { sha256Hex } from "./core/crypto";
import { log } from "./core/redact";
import type { Env } from "./env";
import { createServer } from "./mcp/server";

export { OuraTokenVault } from "./do/token-vault";

function buildProvider(env: Env) {
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const resource = `${base}/mcp`;

  const mcp = createMcpHandler(() => createServer(env), {
    route: "/mcp",
    allowedHostnames: [new URL(base).hostname],
    corsOptions: false,
  });

  return new OAuthProvider<Env>({
    apiHandlers: {
      "/mcp": { fetch: (request: Request, e: Env, ctx: ExecutionContext) => mcp(request, e, ctx) },
    },
    defaultHandler: { fetch: (request: Request, e: Env) => handleDefault(request, e) },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [MCP_SCOPE_READ],
    // Published as the protected resource metadata's scopes_supported (1.x rejects setting both).
    requiredScopes: [MCP_SCOPE_READ],
    resourceMetadata: {
      resource,
      authorization_servers: [base],
      resource_name: "oura-remote-mcp",
    },
    // Implicit flow: workers-oauth-provider 1.x no longer implements it at all (no opt-in to disable).
    // Claude Code (loopback) registers as a public client; keep DCR open but rate-limited.
    disallowPublicClientRegistration: false,
  });
}

const RATE_LIMITED_PREFIXES = ["/mcp", "/oauth/", "/authorize", "/callback", "/oura/"];

let provider: ReturnType<typeof buildProvider> | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (env.KILL_SWITCH === "1") {
      return new Response("service disabled", { status: 503, headers: { "cache-control": "no-store" } });
    }

    const url = new URL(request.url);
    if (RATE_LIMITED_PREFIXES.some((p) => url.pathname.startsWith(p))) {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        log.warn({ event: "rate_limited", route: url.pathname, ip_hash: (await sha256Hex(ip)).slice(0, 12) });
        return new Response("too many requests", { status: 429, headers: { "retry-after": "60", "cache-control": "no-store" } });
      }
    }

    provider ??= buildProvider(env);
    const res = await provider.fetch(request, env, ctx);

    // Harden every response, including provider-generated ones.
    const headers = new Headers(res.headers);
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
} satisfies ExportedHandler<Env>;
