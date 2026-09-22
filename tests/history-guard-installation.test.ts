import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { digest, installHistoryGuard, patchHistoryServer, updateHistoryGuard } from "../scripts/install-history-read-guard";
import { historyGuardFileIO, type HistoryGuardFileIO } from "../scripts/history-guard-files";

const ADAPTER = "history-guard-adapter.mjs";
const WORKER = "bounded-thread-history.ts";
const CONFIG = "history-guard-config.json";
const RECEIPT = "history-guard-receipt.json";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(installed = true, restartRequired = true) {
  const root = mkdtempSync(join(tmpdir(), "history-guard-install-test-"));
  roots.push(root);
  const plugin = join(root, "plugin"), sourceRoot = join(root, "source"), backupRoot = join(root, "backups");
  mkdirSync(plugin); mkdirSync(sourceRoot);
  const source = "// synthetic stock server\n", patched = "// synthetic patched server\n";
  const files = new Map([[ADAPTER, "// new adapter\n"], [WORKER, "// new worker\n"], [CONFIG, '{"bun":"synthetic-runtime"}']]);
  for (const [name, content] of files) writeFileSync(join(sourceRoot, name), content);
  writeFileSync(join(plugin, "server.mjs"), installed ? patched : source);
  if (installed) {
    const oldFiles = new Map([[ADAPTER, "// old adapter\n"], [WORKER, "// old worker\n"], [CONFIG, files.get(CONFIG)!]]);
    for (const [name, content] of oldFiles) writeFileSync(join(plugin, name), content);
    writeFileSync(join(plugin, RECEIPT), JSON.stringify({ installedAt: "original-date", plugin, backup: join(root, "original-backup"),
      originalSha: digest(source), patchedSha: digest(patched),
      fileHashes: Object.fromEntries([...oldFiles].map(([name, content]) => [name, digest(content)])),
      restartRequiredForExistingMcpServers: restartRequired, appliesTo: "fixture", updatePolicy: "fixture" }));
  }
  return { plugin, sourceRoot, backupRoot, source, patched, files,
    update: (apply = true, io?: HistoryGuardFileIO) => updateHistoryGuard({ plugin, sourceRoot, backupRoot, apply, io }),
    install: (io?: HistoryGuardFileIO, validateStagedServer = (_path: string) => {}) =>
      installHistoryGuard({ plugin, backupRoot, source, patched, files, io, validateStagedServer }),
  };
}
function snapshot(plugin: string) {
  return Object.fromEntries(readdirSync(plugin).sort().map(name => [name, readFileSync(join(plugin, name)).toString("base64")]));
}
function failOnce(operation: "write" | "rename", name: string): HistoryGuardFileIO {
  let failed = false;
  return {
    ...historyGuardFileIO,
    write(path, content) {
      if (operation === "write" && basename(path) === name && !failed) {
        failed = true;
        // Simulate an ENOSPC-like partial staging write, not only a pre-write error.
        writeFileSync(path, "partial staging bytes", { flag: "wx" });
        throw new Error(`injected write ${name}`);
      }
      historyGuardFileIO.write(path, content);
    },
    rename(from, to) {
      if (operation === "rename" && basename(to) === name && !failed) {
        failed = true;
        throw new Error(`injected rename ${name}`);
      }
      historyGuardFileIO.rename(from, to);
    },
  };
}

for (const operation of ["write", "rename"] as const) {
  for (const name of [ADAPTER, WORKER, RECEIPT]) {
    test(`update ${operation} failure at ${name} restores exact bytes and can retry`, () => {
      const f = fixture(), before = snapshot(f.plugin);
      expect(() => f.update(true, failOnce(operation, name))).toThrow(`injected ${operation}`);
      expect(snapshot(f.plugin)).toEqual(before);
      const updated = f.update();
      expect(updated.sourceAligned).toBe(true);
      expect(f.update(false).pendingSourceUpdates).toEqual([]);
      expect(readFileSync(join(updated.previousFilesBackup!, RECEIPT)).toString("base64")).toBe(before[RECEIPT]!);
      expect(updated.backup).toBe(JSON.parse(Buffer.from(before[RECEIPT]!, "base64").toString()).backup);
    });
  }
}

test("stale update staging files and abandoned staging directories do not block retry or get deleted", () => {
  const f = fixture();
  for (const name of [ADAPTER, WORKER, RECEIPT]) writeFileSync(join(f.plugin, `${name}.update.tmp`), "abandoned");
  const stale = join(f.plugin, ".history-guard-stage-abandoned");
  mkdirSync(stale); writeFileSync(join(stale, "partial"), "abandoned");
  expect(f.update().sourceAligned).toBe(true);
  for (const name of [ADAPTER, WORKER, RECEIPT]) expect(readFileSync(join(f.plugin, `${name}.update.tmp`), "utf8")).toBe("abandoned");
  expect(readdirSync(f.plugin).filter(name => name.startsWith(".history-guard-stage-"))).toEqual([basename(stale)]);
  expect(readFileSync(join(stale, "partial"), "utf8")).toBe("abandoned");
});

test("check is read-only and successful no-op apply creates no additional backups", () => {
  const f = fixture(), before = snapshot(f.plugin);
  expect(f.update(false).pendingSourceUpdates).toEqual([ADAPTER, WORKER]);
  expect(snapshot(f.plugin)).toEqual(before);
  expect(existsSync(f.backupRoot)).toBe(false);
  f.update();
  const updated = snapshot(f.plugin), backups = readdirSync(f.backupRoot);
  f.update();
  expect(snapshot(f.plugin)).toEqual(updated);
  expect(readdirSync(f.backupRoot)).toEqual(backups);
});

for (const name of [ADAPTER, WORKER, CONFIG, "server.mjs"]) {
  test(`changed installed ${name} is refused before any update`, () => {
    const f = fixture();
    writeFileSync(join(f.plugin, name), "external change");
    const before = snapshot(f.plugin);
    expect(() => f.update()).toThrow(name === "server.mjs" ? "checksum mismatch" : "Guard helper changed");
    expect(snapshot(f.plugin)).toEqual(before);
    expect(existsSync(f.backupRoot)).toBe(false);
  });
}

test("worker-only and line-ending-only updates do not introduce a restart requirement", () => {
  const f = fixture(true, false);
  writeFileSync(join(f.sourceRoot, ADAPTER), "// old adapter\r\n");
  expect(f.update().restartRequiredForExistingMcpServers).toBe(false);
  writeFileSync(join(f.sourceRoot, WORKER), "// another worker\n");
  expect(f.update().restartRequiredForExistingMcpServers).toBe(false);
  writeFileSync(join(f.sourceRoot, ADAPTER), "// another adapter\n");
  expect(f.update().restartRequiredForExistingMcpServers).toBe(true);
  writeFileSync(join(f.sourceRoot, WORKER), "// worker after adapter change\n");
  expect(f.update().restartRequiredForExistingMcpServers).toBe(true);
  expect(f.update(false).restartRequiredForExistingMcpServers).toBe(true);
});

for (const adapter of ["// old adapter\n", "// old adapter\r\n"]) {
  test(`pending restart survives worker update with ${adapter.includes("\r") ? "line-ending-only" : "unchanged"} adapter`, () => {
    const f = fixture();
    writeFileSync(join(f.sourceRoot, ADAPTER), adapter);
    expect(f.update().restartRequiredForExistingMcpServers).toBe(true);
    expect(f.update(false).restartRequiredForExistingMcpServers).toBe(true);
    expect(f.update().restartRequiredForExistingMcpServers).toBe(true);
  });
}

for (const operation of ["write", "rename"] as const) {
  for (const name of [WORKER, "server.mjs", RECEIPT]) {
    test(`initial install ${operation} failure at ${name} restores existing files and removes newly installed files`, () => {
      const f = fixture(false);
      writeFileSync(join(f.plugin, ADAPTER), "pre-existing helper");
      writeFileSync(join(f.plugin, RECEIPT), "pre-existing receipt");
      const before = snapshot(f.plugin);
      expect(() => f.install(failOnce(operation, name))).toThrow(`injected ${operation}`);
      expect(snapshot(f.plugin)).toEqual(before);
      const installed = f.install();
      expect(readFileSync(join(installed.backup, "server.mjs"), "utf8")).toBe(f.source);
      expect(f.update(false).pendingSourceUpdates).toEqual([]);
    });
  }
}

test("syntax validation runs on staged server before changing any installed file", () => {
  const f = fixture(false), before = snapshot(f.plugin);
  expect(() => f.install(undefined, path => {
    expect(readFileSync(path, "utf8")).toBe(f.patched);
    expect(readFileSync(join(f.plugin, "server.mjs"), "utf8")).toBe(f.source);
    expect(existsSync(join(f.plugin, ADAPTER))).toBe(false);
    throw new Error("syntax failure");
  })).toThrow("syntax failure");
  expect(snapshot(f.plugin)).toEqual(before);
  expect(f.install().installed).toBe(true);
});

test("failed first receipt installation leaves a clean uninstalled plugin and can retry", () => {
  const f = fixture(false), before = snapshot(f.plugin);
  expect(() => f.install(failOnce("rename", RECEIPT))).toThrow("injected rename");
  expect(snapshot(f.plugin)).toEqual(before);
  expect(existsSync(join(f.plugin, RECEIPT))).toBe(false);
  expect(f.install().installed).toBe(true);
  expect(f.update(false).pendingSourceUpdates).toEqual([]);
});

test("a helper changed during update is preserved while earlier replacements roll back", () => {
  const f = fixture(), before = snapshot(f.plugin);
  const io: HistoryGuardFileIO = { ...historyGuardFileIO, rename(from, to) {
    historyGuardFileIO.rename(from, to);
    if (basename(to) === ADAPTER) writeFileSync(join(f.plugin, WORKER), "external edit");
  } };
  expect(() => f.update(true, io)).toThrow(`Guard file changed during update: ${WORKER}`);
  expect(readFileSync(join(f.plugin, WORKER), "utf8")).toBe("external edit");
  expect(readFileSync(join(f.plugin, ADAPTER)).toString("base64")).toBe(before[ADAPTER]!);
  expect(readFileSync(join(f.plugin, RECEIPT)).toString("base64")).toBe(before[RECEIPT]!);
  expect(readdirSync(f.plugin).some(name => name.startsWith(".history-guard-stage-"))).toBe(false);
});

test("rollback refuses to overwrite an external edit to an already replaced helper", () => {
  const f = fixture(), before = snapshot(f.plugin);
  const io: HistoryGuardFileIO = { ...historyGuardFileIO, rename(from, to) {
    if (basename(to) === RECEIPT) {
      writeFileSync(join(f.plugin, WORKER), "external edit");
      throw new Error("receipt unavailable");
    }
    historyGuardFileIO.rename(from, to);
  } };
  expect(() => f.update(true, io)).toThrow("rollback incomplete; backups retained at");
  expect(readFileSync(join(f.plugin, WORKER), "utf8")).toBe("external edit");
  expect(readFileSync(join(f.plugin, ADAPTER)).toString("base64")).toBe(before[ADAPTER]!);
  expect(readFileSync(join(f.plugin, RECEIPT)).toString("base64")).toBe(before[RECEIPT]!);
});

test("rollback continues after a restore failure and reports retained backup for recovery", () => {
  const f = fixture(), before = snapshot(f.plugin);
  let receiptFailed = false;
  const io: HistoryGuardFileIO = { ...historyGuardFileIO, rename(from, to) {
    if (basename(to) === RECEIPT) { receiptFailed = true; throw new Error("receipt unavailable"); }
    if (receiptFailed && basename(to) === WORKER) throw new Error("worker restore unavailable");
    historyGuardFileIO.rename(from, to);
  } };
  let failure: unknown;
  try { f.update(true, io); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).message).toContain("rollback incomplete; backups retained at");
  expect((failure as AggregateError).errors).toHaveLength(2);
  expect(readFileSync(join(f.plugin, ADAPTER)).toString("base64")).toBe(before[ADAPTER]!);
  expect(readFileSync(join(f.plugin, RECEIPT)).toString("base64")).toBe(before[RECEIPT]!);
  const backup = join(f.backupRoot, readdirSync(f.backupRoot)[0]!);
  expect(readFileSync(join(backup, WORKER)).toString("base64")).toBe(before[WORKER]!);
  expect(readdirSync(f.plugin).some(name => name.startsWith(".history-guard-stage-"))).toBe(false);
});

for (const rollbackFails of [false, true]) {
  test(`cleanup failure preserves ${rollbackFails ? "rollback AggregateError" : "original update error"} and its evidence`, () => {
    const f = fixture(), before = snapshot(f.plugin);
    const updateError = new Error("receipt unavailable");
    const rollbackError = new Error("worker restore unavailable");
    const cleanupError = new Error("staging cleanup unavailable");
    let receiptFailed = false, staging = "";
    const io: HistoryGuardFileIO = { ...historyGuardFileIO,
      rename(from, to) {
        if (basename(to) === RECEIPT) { receiptFailed = true; throw updateError; }
        if (receiptFailed && rollbackFails && basename(to) === WORKER) throw rollbackError;
        historyGuardFileIO.rename(from, to);
      },
      removeStaging(path) { staging = path; throw cleanupError; },
    };
    let failure: unknown;
    try { f.update(true, io); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors;
    expect(errors).toHaveLength(2);
    if (rollbackFails) {
      expect(errors[0]).toBeInstanceOf(AggregateError);
      expect(errors[0].errors).toEqual([updateError, rollbackError]);
      expect(errors[0].message).toContain("rollback incomplete; backups retained at");
    } else expect(errors[0]).toBe(updateError);
    expect(errors[1].cause).toBe(cleanupError);
    expect(errors[1].message).toContain(staging);
    expect(existsSync(staging)).toBe(true);
    expect(readFileSync(join(f.plugin, ADAPTER)).toString("base64")).toBe(before[ADAPTER]!);
    expect(readFileSync(join(f.plugin, RECEIPT)).toString("base64")).toBe(before[RECEIPT]!);
    const backup = join(f.backupRoot, readdirSync(f.backupRoot)[0]!);
    expect(readFileSync(join(backup, WORKER)).toString("base64")).toBe(before[WORKER]!);
    if (!rollbackFails) expect(f.update().sourceAligned).toBe(true);
  });
}

test("cleanup-only failure reports that files committed and preserves the valid new receipt", () => {
  const f = fixture(), cleanupError = new Error("staging cleanup unavailable");
  let staging = "", failure: unknown;
  try {
    f.update(true, { ...historyGuardFileIO, removeStaging(path) { staging = path; throw cleanupError; } });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("files committed; staging cleanup failed");
  expect((failure as Error).message).toContain(staging);
  expect((failure as Error).cause).toBe(cleanupError);
  expect(f.update(false).sourceAligned).toBe(true);
  expect(f.update().sourceAligned).toBe(true);
  expect(existsSync(staging)).toBe(true);
});

test("unsupported server bytes cannot enter the CLI's installation plan", () => {
  expect(() => patchHistoryServer("  const requestId = String(extra.requestId);")).toThrow("Unsupported app-tools server");
});
