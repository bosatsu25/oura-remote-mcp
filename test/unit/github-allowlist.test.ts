import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertAllowed, IdentityError } from "../../src/auth/github";

const env = { ALLOWED_GITHUB_USER_ID: "123456", ALLOWED_GITHUB_LOGIN: "bosatsu25" };

describe("GitHub allow-list", () => {
  it("accepts the exact owner (login case-insensitive)", () => {
    assert.doesNotThrow(() => assertAllowed(env, { id: 123456, login: "bosatsu25" }));
    assert.doesNotThrow(() => assertAllowed(env, { id: 123456, login: "Bosatsu25" }));
  });

  it("rejects a different id even with the same login (login recycling)", () => {
    assert.throws(() => assertAllowed(env, { id: 999, login: "bosatsu25" }), IdentityError);
  });

  it("rejects the same id with a different login (defense in depth)", () => {
    assert.throws(() => assertAllowed(env, { id: 123456, login: "someone-else" }), IdentityError);
  });

  it("fails closed when the allow-list is unconfigured", () => {
    assert.throws(() => assertAllowed({ ...env, ALLOWED_GITHUB_USER_ID: "0" }, { id: 0, login: "bosatsu25" }), /not configured/);
    assert.throws(() => assertAllowed({ ...env, ALLOWED_GITHUB_USER_ID: "abc" }, { id: 1, login: "bosatsu25" }), /not configured/);
  });
});
