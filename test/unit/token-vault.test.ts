import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { importAesKey } from "../../src/core/crypto";
import { createPromiseLock } from "../../src/core/lock";
import { exchangeOuraCode, TokenVaultCore, VaultError, type KeyValueStore } from "../../src/core/token-vault-core";

const KEY = Buffer.alloc(32, 3).toString("base64");

function memoryStore(): KeyValueStore & { raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  return {
    raw,
    get: async <T,>(k: string) => raw.get(k) as T | undefined,
    put: async (k, v) => {
      raw.set(k, v);
    },
    delete: async (k) => {
      raw.delete(k);
    },
  };
}

interface FakeOura {
  fetchFn: typeof fetch;
  refreshCalls: Array<{ refresh_token: string }>;
  issued: number;
  failNext?: number;
}

/** Simulates Oura's single-use refresh tokens with network latency. */
function fakeOura(delayMs = 5): FakeOura {
  const spent = new Set<string>();
  const state: FakeOura = { refreshCalls: [], issued: 0, fetchFn: undefined as unknown as typeof fetch };
  state.fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body));
    await new Promise((r) => setTimeout(r, delayMs));
    if (state.failNext) {
      state.failNext -= 1;
      return new Response("nope", { status: 500 });
    }
    if (body.get("grant_type") === "refresh_token") {
      const rt = body.get("refresh_token")!;
      state.refreshCalls.push({ refresh_token: rt });
      if (spent.has(rt)) return new Response('{"error":"invalid_grant"}', { status: 400 });
      spent.add(rt);
    }
    state.issued += 1;
    return Response.json({
      access_token: `AT${state.issued}`,
      refresh_token: `RT${state.issued}`,
      expires_in: 2592000,
      token_type: "bearer",
      scope: "extapi:daily extapi:heartrate",
    });
  }) as typeof fetch;
  return state;
}

async function makeVault(oura: FakeOura, now: () => number) {
  const store = memoryStore();
  const key = await importAesKey(KEY);
  const vault = new TokenVaultCore({ store, lock: createPromiseLock(), key, fetchFn: oura.fetchFn, now });
  return { vault, store };
}

describe("TokenVaultCore", () => {
  it("stores tokens encrypted at rest", async () => {
    let t = 1_000_000;
    const oura = fakeOura();
    const { vault, store } = await makeVault(oura, () => t);
    await vault.store({ accessToken: "AT-plain", refreshToken: "RT-plain", expiresAt: t + 10_000_000, scope: "daily" });
    const serialized = JSON.stringify(Array.from(store.raw.entries()));
    assert.ok(!serialized.includes("AT-plain"));
    assert.ok(!serialized.includes("RT-plain"));
    assert.equal(await vault.getAccessToken({ clientId: "c", clientSecret: "s" }), "AT-plain");
    const s = await vault.status();
    assert.equal(s.linked, true);
    assert.equal(s.scope, "daily");
  });

  it("throws not_linked when empty", async () => {
    const { vault } = await makeVault(fakeOura(), () => 0);
    await assert.rejects(vault.getAccessToken({ clientId: "c", clientSecret: "s" }), (e: unknown) => e instanceof VaultError && e.code === "not_linked");
  });

  it("refreshes once under concurrency and persists the rotated refresh token", async () => {
    let t = 1_000_000;
    const oura = fakeOura(10);
    const { vault } = await makeVault(oura, () => t);
    await vault.store({ accessToken: "AT0", refreshToken: "RT0", expiresAt: t + 1000, scope: "daily" }); // expiring within skew

    // Ten concurrent callers: exactly one refresh must hit Oura.
    const tokens = await Promise.all(Array.from({ length: 10 }, () => vault.getAccessToken({ clientId: "c", clientSecret: "s" })));
    assert.deepEqual(new Set(tokens), new Set(["AT1"]));
    assert.equal(oura.refreshCalls.length, 1);
    assert.equal(oura.refreshCalls[0]!.refresh_token, "RT0");

    // Later: a second refresh must use the rotated token RT1, not the spent RT0.
    t += 2592000 * 1000;
    const next = await vault.getAccessToken({ clientId: "c", clientSecret: "s" });
    assert.equal(next, "AT2");
    assert.equal(oura.refreshCalls[1]!.refresh_token, "RT1");
  });

  it("does not refresh when the token is still fresh", async () => {
    let t = 1_000_000;
    const oura = fakeOura();
    const { vault } = await makeVault(oura, () => t);
    await vault.store({ accessToken: "AT0", refreshToken: "RT0", expiresAt: t + 60 * 60 * 1000, scope: "daily" });
    assert.equal(await vault.getAccessToken({ clientId: "c", clientSecret: "s" }), "AT0");
    assert.equal(oura.refreshCalls.length, 0);
  });

  it("surfaces refresh failures without corrupting stored state", async () => {
    let t = 1_000_000;
    const oura = fakeOura();
    const { vault } = await makeVault(oura, () => t);
    await vault.store({ accessToken: "AT0", refreshToken: "RT0", expiresAt: t + 1000, scope: "daily" });
    oura.failNext = 1;
    await assert.rejects(vault.getAccessToken({ clientId: "c", clientSecret: "s" }), (e: unknown) => e instanceof VaultError && e.code === "refresh_failed");
    // Retry succeeds with the still-unspent RT0.
    assert.equal(await vault.getAccessToken({ clientId: "c", clientSecret: "s" }), "AT1");
    assert.equal(oura.refreshCalls.at(-1)!.refresh_token, "RT0");
  });

  it("clear() removes everything", async () => {
    const { vault, store } = await makeVault(fakeOura(), () => 0);
    await vault.store({ accessToken: "a", refreshToken: "r", expiresAt: 10, scope: "" });
    await vault.clear();
    assert.equal(store.raw.size, 0);
    assert.deepEqual(await vault.status(), { linked: false });
  });

  it("exchangeOuraCode sends PKCE verifier and never leaks the body on error", async () => {
    let seen: URLSearchParams | undefined;
    const fetchFn = (async (_u: string | URL | Request, init?: RequestInit) => {
      seen = new URLSearchParams(String(init?.body));
      return Response.json({ access_token: "A", refresh_token: "R", expires_in: 100, scope: "extapi:daily" });
    }) as typeof fetch;
    const out = await exchangeOuraCode(fetchFn, { clientId: "cid", clientSecret: "sec" }, { code: "CODE", redirectUri: "https://x/oura/callback", codeVerifier: "VER" });
    assert.equal(seen!.get("code_verifier"), "VER");
    assert.equal(seen!.get("grant_type"), "authorization_code");
    assert.equal(out.refreshToken, "R");

    const failing = (async () => new Response("secret-ish body", { status: 400 })) as typeof fetch;
    await assert.rejects(
      exchangeOuraCode(failing, { clientId: "c", clientSecret: "s" }, { code: "x", redirectUri: "u", codeVerifier: "v" }),
      (e: unknown) => e instanceof VaultError && !e.message.includes("secret-ish"),
    );
  });
});
