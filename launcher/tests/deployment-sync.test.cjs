const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { verifyDeployment } = require("../../scripts/verify-deployment.cjs");

test("deployment gate rejects stale checkout, remote, provenance and runtime bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-deployment-test-"));
  const repo = path.join(root, "repo"), runtime = path.join(root, "runtime");
  fs.mkdirSync(repo); fs.mkdirSync(runtime);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (name, data) => { const file = path.join(runtime, ...name.split("/")); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
  const sha = data => createHash("sha256").update(data).digest("hex");
  const manifest = () => {
    const files = [];
    const walk = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name !== "manifest.json") { const data = fs.readFileSync(file); files.push({ path: path.relative(runtime, file).split(path.sep).join("/"), size: data.length, sha256: sha(data) }); }
    } };
    walk(runtime); files.sort((a, b) => a.path < b.path ? -1 : 1);
    write("manifest.json", JSON.stringify({ schemaVersion: 2, appVersion: "6.1.2", platform: process.platform, arch: process.arch,
      bunVersion: "1.4.0", playwright: "1.62.0", entrypoint: "app/cli.js", launcher: `bin/${process.platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web"}`,
      files, bundleId: sha(files.map(f => `${f.path}\0${f.size}\0${f.sha256}\0`).join("")) }));
  };
  try {
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "source.txt"), "one"); git("add", ".");
    const commit = () => git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    commit(); const head = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD^{tree}");
    git("branch", "published"); git("remote", "add", "origin", repo);
    for (const name of ["app/cli.js", "app/browser-helper.cjs", `runtime/${process.platform === "win32" ? "bun.exe" : "bun"}`, `bin/${process.platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web"}`]) write(name, "fixture");
    if (process.platform !== "win32") fs.chmodSync(path.join(runtime, "runtime", "bun"), 0o755);
    write("build-source.json", JSON.stringify({ source: { commit: head, tree, clean: true } })); manifest();
    const spec = { repository: repo, runtimes: [runtime], branches: ["published"] };
    assert.equal(verifyDeployment(spec).status, "SYNCHRONIZED");
    write("app/cli.js", "tampered"); assert.throws(() => verifyDeployment(spec), /mismatch/i);
    write("app/cli.js", "fixture");
    write("build-source.json", JSON.stringify({ source: { commit: "0".repeat(40), tree, clean: true } })); manifest();
    assert.throws(() => verifyDeployment(spec), /clean source commit/);
    fs.writeFileSync(path.join(repo, "source.txt"), "two"); assert.throws(() => verifyDeployment(spec), /not clean/);
    git("add", "."); commit(); assert.throws(() => verifyDeployment(spec), /Remote .* differs/);
  } finally {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unsafe fixture cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
