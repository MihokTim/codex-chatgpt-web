import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const windowsTest = test.skipIf(process.platform !== "win32");
const sourceRoot = resolve(import.meta.dir, "..");
function runFixture(scenario: string, installer = false) {
  const root = mkdtempSync(join(tmpdir(), "incident readiness test-"));
  try {
    const result = Bun.spawnSync([
      "pwsh.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
      join(import.meta.dir, "fixtures", "incident-recorder-readiness.ps1"),
      "-FixtureRoot", root, "-SourceRoot", sourceRoot, "-Scenario", scenario,
      ...(installer ? ["-Installer"] : []),
    ], { stdout: "pipe", stderr: "pipe", timeout: 20_000, windowsHide: true });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString(),
      receipt: existsSync(join(root, ".codex-chatgpt-web", "diagnostics", "incident-recorder", "install-receipt.json")) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const scenario of ["ready", "partial"]) windowsTest(`installer waits for ${scenario} running status and copies its helper`, () => {
  const result = runFixture(scenario, true);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  expect(result.receipt).toBe(true);
  const receipt = JSON.parse(result.out);
  expect(receipt.recorderPid).toBeGreaterThan(0);
  expect(Date.parse(receipt.firstObservedSampleAt)).toBeGreaterThanOrEqual(Date.parse(receipt.recorderStartedAt));
}, 20_000);

for (const [scenario, reason] of [
  ["wmi-failure", "Detached recorder launch failed: 5"],
  ["exit", "exited before"],
  ["missing", "readiness timed out"],
]) windowsTest(`installer fails without a success receipt: ${scenario}`, () => {
  const result = runFixture(scenario, true);
  expect(result.code).not.toBe(0);
  expect(result.receipt).toBe(false);
  expect(result.err).toContain(reason);
}, 20_000);

for (const [scenario, reason] of [
  ["wrong-pid", "status PID does not match"],
  ["not-running", "status is not running=true"],
  ["string-running", "status is not running=true"],
  ["stale", "status sample timestamp is invalid"],
  ["future", "status sample timestamp is invalid"],
  ["invalid-time", "status sample timestamp is invalid"],
  ["no-sample", "status has no completed sample"],
  ["malformed", "incomplete JSON"],
  ["predates", "predates this launch"],
]) windowsTest(`readiness rejects ${scenario} using the real process identity`, () => {
  const result = runFixture(scenario);
  expect(result.code).not.toBe(0);
  expect(result.err).toContain(reason);
  if (scenario !== "predates") {
    const elapsed = Number(/readinessElapsedMs=(\d+)/.exec(result.err)?.[1]);
    expect(elapsed).toBeGreaterThanOrEqual(600);
    expect(elapsed).toBeLessThan(2000);
  }
}, 20_000);
