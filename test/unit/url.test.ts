import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTrailingSlashes } from "../../src/core/url";

describe("stripTrailingSlashes", () => {
  it("removes one or more trailing slashes", () => {
    assert.equal(stripTrailingSlashes("https://example.workers.dev/"), "https://example.workers.dev");
    assert.equal(stripTrailingSlashes("https://example.workers.dev///"), "https://example.workers.dev");
  });

  it("leaves other slashes and slash-free input untouched", () => {
    assert.equal(stripTrailingSlashes("https://example.workers.dev"), "https://example.workers.dev");
    assert.equal(stripTrailingSlashes("https://example.workers.dev/a/b"), "https://example.workers.dev/a/b");
  });

  it("handles empty and all-slash input", () => {
    assert.equal(stripTrailingSlashes(""), "");
    assert.equal(stripTrailingSlashes("////"), "");
  });

  it("matches the regex it replaces", () => {
    for (const s of ["", "/", "a", "a/", "a//", "/a", "//a//", "https://x.dev/p/", "x".repeat(10) + "/".repeat(50)]) {
      assert.equal(stripTrailingSlashes(s), s.replace(/\/+$/, ""), JSON.stringify(s));
    }
  });

  it("stays fast on long runs of slashes", () => {
    const input = "a" + "/".repeat(200_000) + "b" + "/".repeat(200_000);
    const t0 = performance.now();
    assert.equal(stripTrailingSlashes(input).length, 200_002);
    assert.ok(performance.now() - t0 < 100, "linear-time strip");
  });
});
