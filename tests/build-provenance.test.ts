import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { assertBuildSourceUnchanged, buildInputHash, readBuildSource } from "../scripts/build-provenance";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const target = resolve(root);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes("cgw-provenance-")) {
      throw new Error(`Unsafe fixture cleanup: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
  }
});

function fixture(withGit = true) {
  const root = mkdtempSync(join(tmpdir(), "cgw-provenance-"));
  roots.push(root);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr || "Git fixture command failed");
  };
  write("src/cli.ts", '#!/usr/bin/env bun\nimport { value } from "./value"; console.log(value);\n');
  write("src/value.ts", "export const value = 1;\n");
  write("src/adapters/chatgpt-web/browser-helper-main.ts", 'export { value } from "../../value";\n');
  write("scripts/build-runtime-bundle.ts", 'import "./builder-helper";\n');
  write("scripts/builder-helper.ts", "export const recipe = 1;\n");
  write("scripts/generate-third-party-notices.ts", "export {};\n");
  write("package.json", '{"type":"module"}\n');
  write("launcher/package.json", "{}\n");
  write("bun.lock", "lock fixture\n");
  write("LICENSE", "license fixture\n");
  write("LICENSES/dependency.txt", "notice fixture\n");
  write("fork-metadata.json", "{}\n");
  write("README.md", "documentation\n");
  write(".gitignore", "dist/\noutput/\nnode_modules/\nsrc/ignored.ts\n");
  if (withGit) {
    git("init", "-q");
    git("config", "core.autocrlf", "false");
    git("add", ".");
    git("-c", "user.name=Build Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  }
  return { root, write, git, read: () => readBuildSource(root) };
}

test("Dirty-to-dirty byte changes differ with identical HEAD/tree, size and mtime", () => {
  const f = fixture();
  f.write("src/value.ts", "export const value = 2;\n");
  const timestamp = new Date("2020-01-01T00:00:00Z");
  utimesSync(join(f.root, "src/value.ts"), timestamp, timestamp);
  const before = f.read();
  f.write("src/value.ts", "export const value = 3;\n");
  utimesSync(join(f.root, "src/value.ts"), timestamp, timestamp);
  const after = f.read();
  expect(before.clean).toBe(false);
  expect(after.clean).toBe(false);
  expect(after.commit).toBe(before.commit);
  expect(after.tree).toBe(before.tree);
  expect(after.inputHash).not.toBe(before.inputHash);
  expect(() => assertBuildSourceUnchanged(before, after)).toThrow("changed during runtime build");
  expect(() => assertBuildSourceUnchanged(after, after)).not.toThrow();
  expect(() => assertBuildSourceUnchanged(after, after, true)).toThrow("clean committed source");
});

test("staged inputs are hashed from working bytes, and index-only changes do not change the digest", () => {
  const f = fixture();
  f.write("src/value.ts", "export const value = 2;\n");
  const unstaged = f.read();
  f.git("add", "src/value.ts");
  const staged = f.read();
  expect(staged.inputHash).toBe(unstaged.inputHash);
  f.write("src/value.ts", "export const value = 3;\n");
  expect(() => assertBuildSourceUnchanged(staged, f.read())).toThrow("changed during runtime build");
});

test("unrelated checkout files, ignored output and node_modules do not change build inputs", () => {
  const f = fixture();
  const before = f.read();
  f.write("README.md", "updated docs\n");
  f.write("tests/new.test.ts", "test fixture\n");
  f.write("src/unreferenced.ts", "export const unused = 1;\n");
  f.write("dist/runtime/build-source.json", "{}\n");
  f.write("output/some-checkout/src/cli.ts", "unrelated\n");
  f.write("node_modules/example/index.js", "package cache\n");
  f.write("candidate/app/cli.js", "nonignored custom output\n");
  const after = f.read();
  expect(before.clean).toBe(true);
  expect(after.clean).toBe(false);
  expect(after.inputs).toEqual(before.inputs);
  expect(() => assertBuildSourceUnchanged(before, after)).not.toThrow();
  expect(() => assertBuildSourceUnchanged(before, after, true)).toThrow("clean committed source");
});

test("external package imports use manifests/locks, and type-only imports are not bundled inputs", () => {
  const f = fixture();
  f.write("src/cli.ts", 'import external from "example"; import type { Value } from "./types"; console.log(external as Value);\n');
  f.write("src/types.ts", "export type Value = string;\n");
  f.write("node_modules/example/package.json", '{"main":"index.js"}\n');
  f.write("node_modules/example/index.js", "module.exports = 1;\n");
  const before = f.read();
  f.write("src/types.ts", "export type Value = number;\n");
  f.write("node_modules/example/index.js", "module.exports = 2;\n");
  const after = f.read();
  expect(after.inputHash).toBe(before.inputHash);
  expect(after.inputs.some(input => input.path.startsWith("node_modules/") || input.path === "src/types.ts")).toBe(false);
});

test("deleted imported modules fail closed", () => {
  const f = fixture();
  f.read();
  rmSync(join(f.root, "src/value.ts"));
  expect(() => f.read()).toThrow();
});

test("new, ignored and renamed local imports are inputs even without Git tracking", () => {
  const f = fixture();
  const before = f.read();
  f.write("src/ignored.ts", "export const value = 2;\n");
  f.write("src/cli.ts", 'export { value } from "./ignored";\n');
  const added = f.read();
  expect(added.inputs.some(input => input.path === "src/ignored.ts")).toBe(true);
  expect(() => assertBuildSourceUnchanged(before, added)).toThrow();
  f.write("src/ignored.ts", "export const value = 3;\n");
  expect(() => assertBuildSourceUnchanged(added, f.read())).toThrow();
  renameSync(join(f.root, "src/ignored.ts"), join(f.root, "src/renamed.ts"));
  f.write("src/cli.ts", 'export { value } from "./renamed";\n');
  const renamed = f.read();
  expect(renamed.inputs.some(input => input.path === "src/ignored.ts")).toBe(false);
  expect(renamed.inputs.some(input => input.path === "src/renamed.ts")).toBe(true);
  expect(() => assertBuildSourceUnchanged(added, renamed)).toThrow();
});

test.each([
  "src/adapters/chatgpt-web/browser-helper-main.ts", "scripts/builder-helper.ts",
  "scripts/generate-third-party-notices.ts", "package.json", "bun.lock", "launcher/package.json",
  "LICENSE", "LICENSES/dependency.txt", "fork-metadata.json", "tsconfig.json", "bunfig.toml", "launcher/bun.lock",
])("tracks consumed recipe, config and copied input: %s", path => {
  const f = fixture();
  const before = f.read();
  f.write(path, path.endsWith(".ts") ? "export const changed = true;\n" : '{"changed":true}\n');
  expect(() => assertBuildSourceUnchanged(before, f.read())).toThrow("changed during runtime build");
});

test("license directory additions and removals change identity", () => {
  const f = fixture();
  const before = f.read();
  f.write("LICENSES/new.txt", "new notice\n");
  const added = f.read();
  expect(() => assertBuildSourceUnchanged(before, added)).toThrow();
  rmSync(join(f.root, "LICENSES/new.txt"));
  expect(f.read().inputHash).toBe(before.inputHash);
  expect(() => assertBuildSourceUnchanged(added, f.read())).toThrow();
});

test("source archives still detect content changes and cannot satisfy clean-source policy", () => {
  const f = fixture(false);
  const before = f.read();
  expect(before.commit).toBeNull();
  expect(before.tree).toBeNull();
  expect(before.clean).toBeNull();
  f.write("src/value.ts", "export const value = 2;\n");
  expect(() => assertBuildSourceUnchanged(before, f.read())).toThrow("changed during runtime build");
  expect(() => assertBuildSourceUnchanged(before, before, true)).toThrow("clean committed source");
});

test("HEAD changes still fail even when working inputs and Git tree are unchanged", () => {
  const f = fixture();
  const before = f.read();
  f.git("-c", "user.name=Build Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "new head");
  const after = f.read();
  expect(after.tree).toBe(before.tree);
  expect(after.inputHash).toBe(before.inputHash);
  expect(() => assertBuildSourceUnchanged(before, after)).toThrow("changed during runtime build");
});

test("pure hash is order independent and distinguishes path, absence, bytes and symlink target", () => {
  const a = { path: "a", sha256: "123" };
  const b = { path: "b", sha256: "456" };
  expect(buildInputHash([a, b])).toBe(buildInputHash([b, a]));
  for (const changed of [{ ...a, path: "renamed" }, { ...a, sha256: null }, { ...a, sha256: "789" }, { ...a, link: "target" }]) {
    expect(buildInputHash([changed, b])).not.toBe(buildInputHash([a, b]));
  }
});
