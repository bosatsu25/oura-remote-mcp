import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPromiseLock } from "../../src/core/lock";

describe("promise lock", () => {
  it("serializes critical sections in order", async () => {
    const lock = createPromiseLock();
    const order: string[] = [];
    await Promise.all([
      lock.run(async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 10));
        order.push("a-end");
      }),
      lock.run(async () => {
        order.push("b-start");
        order.push("b-end");
      }),
    ]);
    assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
  });

  it("keeps working after a rejected section", async () => {
    const lock = createPromiseLock();
    await assert.rejects(lock.run(async () => { throw new Error("boom"); }));
    assert.equal(await lock.run(async () => 42), 42);
  });
});
