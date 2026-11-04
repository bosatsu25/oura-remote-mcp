import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_PAGES, OURA } from "../../src/config";
import { fetchCollection, OuraApiError } from "../../src/core/oura-client";

function fetchStub(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>): { fetchFn: typeof fetch; calls: URL[] } {
  const calls: URL[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe("oura-client", () => {
  it("only ever calls the fixed Oura base URL with the bearer token and a User-Agent", async () => {
    const { fetchFn, calls } = fetchStub((_u, init) => {
      const h = new Headers(init?.headers);
      assert.equal(h.get("authorization"), "Bearer TOK");
      assert.ok(h.get("user-agent"));
      return Response.json({ data: [{ day: "2026-11-01" }], next_token: null });
    });
    const r = await fetchCollection({ fetchFn, accessToken: "TOK" }, "daily_sleep", { start_date: "2026-11-01", end_date: "2026-11-02", nope: undefined });
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.toString().startsWith(`${OURA.API_BASE}/daily_sleep?`));
    assert.equal(calls[0]!.searchParams.get("nope"), null);
    assert.equal(r.data.length, 1);
    assert.equal(r.truncated, false);
  });

  it("follows next_token and stops at MAX_PAGES", async () => {
    const { fetchFn, calls } = fetchStub((u) => {
      const n = Number(u.searchParams.get("next_token") ?? "0");
      return Response.json({ data: [{ n }], next_token: String(n + 1) });
    });
    const r = await fetchCollection({ fetchFn, accessToken: "T" }, "sleep", {});
    assert.equal(calls.length, MAX_PAGES);
    assert.equal(r.pages, MAX_PAGES);
    assert.equal(r.truncated, true);
    assert.equal(r.data.length, MAX_PAGES);
  });

  it("maps upstream statuses to typed errors without exposing bodies", async () => {
    for (const [status, msg] of [[401, /rejected/], [403, /scope/], [429, /rate limit/], [500, /HTTP 500/]] as const) {
      const { fetchFn } = fetchStub(() => new Response("leaky upstream body", { status }));
      await assert.rejects(
        fetchCollection({ fetchFn, accessToken: "T" }, "sleep", {}),
        (e: unknown) => e instanceof OuraApiError && e.status === status && msg.test(e.message) && !e.message.includes("leaky"),
      );
    }
  });

  it("rejects malformed envelopes", async () => {
    const { fetchFn } = fetchStub(() => Response.json({ nope: true }));
    await assert.rejects(fetchCollection({ fetchFn, accessToken: "T" }, "sleep", {}), (e: unknown) => e instanceof OuraApiError && e.status === 502);
  });
});
