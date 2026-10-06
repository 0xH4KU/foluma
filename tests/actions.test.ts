import assert from "node:assert/strict";
import { test } from "node:test";
import { createActionRunner } from "../sdk/actions.ts";

test("actions prevent reentry and release busy state after success, failure and thrown reports", async () => {
  let active = 0;
  const errors: unknown[] = [], states: boolean[] = [];
  const host = { setBusy: (busy: boolean) => { active += busy ? 1 : -1; }, notify: () => {},
    report: (error: unknown) => { errors.push(error); } };
  const run = createActionRunner(host, (busy) => states.push(busy));
  let finish!: () => void;
  const first = run(() => new Promise<void>((resolve) => { finish = resolve; }));
  assert.equal(active, 1);
  assert.equal(await run(async () => { assert.fail("A second action must not start before the first ends"); }), false);
  finish();
  assert.equal(await first, true);
  assert.equal(active, 0);
  const failure = new Error("Failed to save");
  assert.equal(await run(async () => { throw failure; }), false);
  assert.deepEqual(errors, [failure]);
  await assert.rejects(run(async () => { throw failure; }, false), failure);
  host.report = (error) => { throw error; };
  await assert.rejects(run(async () => { throw failure; }), failure);
  assert.equal(active, 0);
  assert.equal(await run(async () => {}), true, "A failure must not leave the runner locked");
  assert.deepEqual(states, [true, false, true, false, true, false, true, false, true, false]);
});
