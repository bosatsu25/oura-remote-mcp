import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays, formatIsoDate, parseIsoDate, validateDateRange, validateNextToken, ValidationError } from "../../src/core/validate";

const NOW = new Date("2026-11-04T12:00:00Z");

describe("validate", () => {
  it("accepts a normal range", () => {
    const r = validateDateRange("2026-10-01", "2026-10-07", { now: NOW });
    assert.deepEqual(r, { start: "2026-10-01", end: "2026-10-07", days: 7 });
  });

  it("rejects malformed and impossible dates", () => {
    for (const bad of ["2026/10/01", "20261001", "2026-13-01", "2026-02-30", "", 42, null, "2026-10-01T00:00:00Z"]) {
      assert.throws(() => validateDateRange(bad, "2026-10-07", { now: NOW }), ValidationError, String(bad));
    }
  });

  it("rejects reversed, future, and oversized ranges", () => {
    assert.throws(() => validateDateRange("2026-10-07", "2026-10-01", { now: NOW }), /end_date must be/);
    assert.throws(() => validateDateRange("2026-11-01", "2026-11-06", { now: NOW }), /future/);
    assert.throws(() => validateDateRange("2026-09-01", "2026-10-15", { now: NOW }), /exceeds 31/);
    assert.throws(() => validateDateRange("2026-10-01", "2026-10-04", { now: NOW, maxDays: 3 }), /exceeds 3/);
  });

  it("allows one day of slack past today (timezone-safe)", () => {
    assert.doesNotThrow(() => validateDateRange("2026-11-04", "2026-11-05", { now: NOW }));
  });

  it("rejects injection-looking date strings", () => {
    assert.throws(() => parseIsoDate("2026-10-01&next_token=x", "f"), ValidationError);
  });

  it("formats and adds days in UTC", () => {
    const d = parseIsoDate("2026-12-31", "f");
    assert.equal(formatIsoDate(addDays(d, 1)), "2027-01-01");
  });

  it("validates next_token conservatively", () => {
    assert.equal(validateNextToken(undefined), undefined);
    assert.equal(validateNextToken(""), undefined);
    assert.equal(validateNextToken("abc.DEF-123_="), "abc.DEF-123_=");
    assert.throws(() => validateNextToken("a b"), ValidationError);
    assert.throws(() => validateNextToken("x".repeat(513)), ValidationError);
  });
});
