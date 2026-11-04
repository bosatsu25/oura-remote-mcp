import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLogger, redactString, safeErrorMessage, sanitizeFields } from "../../src/core/redact";

const OURA_TOKEN = "QWERTYUIOPASDFGHJKLZXCVBNM1234567890QWER"; // 40 uppercase chars, Oura-like
const GH_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";
const OPAQUE = "a".repeat(45);

describe("redact", () => {
  it("strips bearer tokens, oauth params and vendor token formats", () => {
    const s = `Authorization: Bearer ${OURA_TOKEN} code=abcdefghij12 refresh_token=${OPAQUE} ${GH_TOKEN}`;
    const out = redactString(s);
    assert.ok(!out.includes(OURA_TOKEN));
    assert.ok(!out.includes(GH_TOKEN));
    assert.ok(!out.includes(OPAQUE));
    assert.ok(!out.includes("abcdefghij12"));
    assert.ok(out.includes("[REDACTED]"));
  });

  it("only emits allow-listed fields", () => {
    const out = sanitizeFields({
      event: "x",
      tool: "get_sleep",
      // health data and secrets must be dropped by the allow-list alone:
      bedtime_start: "2026-11-03T23:40:00+09:00",
      access_token: OURA_TOKEN,
      body: '{"average_hrv":42}',
      status: 200,
    });
    assert.deepEqual(out, { event: "x", tool: "get_sleep", status: 200 });
  });

  it("redacts inside allowed string fields and truncates", () => {
    const out = sanitizeFields({ reason: `boom ${OURA_TOKEN} ` + "z".repeat(500) });
    assert.ok(!String(out.reason).includes(OURA_TOKEN));
    assert.ok(String(out.reason).length <= 200);
  });

  it("logger never writes secrets to the sink", () => {
    const lines: string[] = [];
    const logger = createLogger({ log: (l: string) => lines.push(l), warn: (l: string) => lines.push(l), error: (l: string) => lines.push(l) });
    logger.error({ event: "e", reason: `token ${OURA_TOKEN}`, access_token: OURA_TOKEN } as never);
    assert.equal(lines.length, 1);
    assert.ok(!lines[0]!.includes(OURA_TOKEN));
    assert.ok(JSON.parse(lines[0]!).level === "error");
  });

  it("safeErrorMessage handles non-Error values", () => {
    assert.equal(safeErrorMessage("plain"), "plain");
    assert.ok(!safeErrorMessage(new Error(`x ${GH_TOKEN}`)).includes(GH_TOKEN));
  });
});
