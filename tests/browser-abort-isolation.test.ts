import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("cancelled browser waits cannot terminate the Node helper or its unrelated turns", async () => {
  const node = Bun.which("node");
  if (!node) throw new Error("Node is required to verify the browser helper's strict rejection policy");
  const directory = mkdtempSync(join(tmpdir(), "codex-browser-abort-"));
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "fixtures", "browser-abort-isolation.ts")],
      outdir: directory, naming: "probe.cjs", target: "node", format: "cjs", packages: "external",
    });
    expect(build.success).toBe(true);
    const child = Bun.spawn([node, "--unhandled-rejections=strict", join(directory, "probe.cjs")], {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, NODE_PATH: resolve(import.meta.dir, "..", "node_modules") },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    expect(stdout.match(/sibling survived/g)?.length).toBe(4);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30000);
