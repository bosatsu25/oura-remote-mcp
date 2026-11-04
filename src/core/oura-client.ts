/**
 * Thin, allow-listed HTTP client for the Oura v2 API.
 *
 *  - Base URL is a constant; only the resource name and known query params are variable.
 *  - Pagination follows `next_token` up to MAX_PAGES.
 *  - Response bodies are never logged.
 */

import { MAX_PAGES, OURA, UPSTREAM_TIMEOUT_MS } from "../config";

export type OuraResource = "sleep" | "daily_sleep" | "daily_readiness" | "heartrate";

export class OuraApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OuraApiError";
  }
}

interface Envelope<T> {
  data: T[];
  next_token?: string | null;
}

export interface OuraClientOptions {
  fetchFn: typeof fetch;
  accessToken: string;
}

export async function fetchCollection<T>(
  opts: OuraClientOptions,
  resource: OuraResource,
  query: Record<string, string | undefined>,
): Promise<{ data: T[]; pages: number; truncated: boolean }> {
  const all: T[] = [];
  let nextToken: string | undefined;
  let pages = 0;

  do {
    const url = new URL(`${OURA.API_BASE}/${resource}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
    if (nextToken) url.searchParams.set("next_token", nextToken);

    const res = await opts.fetchFn(url.toString(), {
      method: "GET",
      headers: {
        authorization: `Bearer ${opts.accessToken}`,
        accept: "application/json",
        "user-agent": OURA.USER_AGENT,
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (res.status === 401) throw new OuraApiError("Oura rejected the access token", 401);
    if (res.status === 403) throw new OuraApiError("Oura scope missing for this resource", 403);
    if (res.status === 429) throw new OuraApiError("Oura rate limit reached", 429);
    if (!res.ok) throw new OuraApiError(`Oura API error (HTTP ${res.status})`, res.status);

    const json = (await res.json()) as Envelope<T>;
    if (!Array.isArray(json.data)) throw new OuraApiError("Oura returned an unexpected payload", 502);
    all.push(...json.data);
    nextToken = json.next_token ?? undefined;
    pages += 1;
  } while (nextToken && pages < MAX_PAGES);

  return { data: all, pages, truncated: Boolean(nextToken) };
}
