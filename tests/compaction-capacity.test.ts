import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

test("concurrent compactions reserve failure capacity without evicting replay fences", () => {
  // Exhaust the real registry in a child process so other tests keep their own budgets.
  const moduleUrl = new URL("../src/adapters/chatgpt-web/compaction-handoff.ts", import.meta.url).href;
  const script = `
    import { strict as assert } from "node:assert";
    const { runStructuredCompactionOnce: run, structuredCompactionFailureCapacity: capacity } = await import(${JSON.stringify(moduleUrl)});
    const owner = key => ({ ownerKey: key, traceIds: [], rememberFailure: true });
    let releaseSuccess;
    const success = run("success", owner("success"), () => new Promise(resolve => { releaseSuccess = resolve; }));
    assert.equal(capacity().used, 1);
    assert.equal(run("success", owner("success"), () => { throw Error("duplicate"); }), success);
    await Promise.resolve();
    releaseSuccess("summary");
    await success;
    assert.equal(capacity().used, 0);
    for (let index = 0; index < 511; index++) {
      await run("seed-" + index, owner("seed-" + index), async () => { throw Error("failed"); }).catch(() => {});
    }
    let release;
    let starts = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const runs = [0, 1].map(index => run("last-" + index, owner("last-" + index), async () => {
      starts++; await gate; throw Error("failed");
    }));
    const settled = Promise.allSettled(runs);
    release();
    const results = await settled;
    assert.equal(starts, 1);
    assert.equal(results[1].reason.code, "compaction_failure_tracking_full");
    assert.deepEqual(capacity(), { used: 512, limit: 512, remaining: 0 });
    await assert.rejects(run("seed-0", owner("seed-0"), async () => "must not replay"), /failed/);
    console.log("COMPACTION_CAPACITY_OK");
  `;
  const result = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toEqual({ status: 0, error: undefined, stderr: "" });
  expect(result.stdout).toContain("COMPACTION_CAPACITY_OK");
});
