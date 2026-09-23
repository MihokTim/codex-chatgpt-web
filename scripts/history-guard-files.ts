import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Injectable filesystem boundaries let tests fail actual staging/rename operations.
export interface HistoryGuardFileIO {
  write(path: string, content: string | Buffer): void;
  rename(from: string, to: string): void;
  removeStaging(path: string): void;
}
export const historyGuardFileIO: HistoryGuardFileIO = {
  write: (path, content) => writeFileSync(path, content, { flag: "wx" }),
  rename: renameSync,
  removeStaging: path => rmSync(path, { recursive: true, force: true }),
};
export interface HistoryGuardFile {
  name: string;
  content: string | Buffer;
  before: Buffer | null;
}
export function historyGuardFileBefore(path: string): Buffer | null {
  try { return readFileSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function sameBytes(a: Buffer | null, b: Buffer | null): boolean {
  return a === null ? b === null : b !== null && a.equals(b);
}

// Receipt must be the final entry. This handles ordinary I/O failures, not crash
// recovery or atomic visibility across files to already-running MCP processes.
export function replaceHistoryGuardFiles(options: {
  plugin: string;
  backupRoot: string;
  backupPrefix: string;
  files(backup: string): HistoryGuardFile[];
  validate?(staging: string): void;
  io?: HistoryGuardFileIO;
}): string {
  const io = options.io ?? historyGuardFileIO;
  mkdirSync(options.backupRoot, { recursive: true });
  const backup = mkdtempSync(join(options.backupRoot, options.backupPrefix));
  const staging = mkdtempSync(join(options.plugin, ".history-guard-stage-"));
  const applied: HistoryGuardFile[] = [];
  const failures: unknown[] = [];
  try {
    const files = options.files(backup);
    for (const file of files) {
      if (!sameBytes(historyGuardFileBefore(join(options.plugin, file.name)), file.before)) {
        throw new Error(`Guard file changed before staging: ${file.name}`);
      }
      if (file.before !== null) writeFileSync(join(backup, file.name), file.before, { flag: "wx" });
      io.write(join(staging, file.name), file.content);
    }
    options.validate?.(staging);
    for (const file of files) {
      const target = join(options.plugin, file.name);
      if (!sameBytes(historyGuardFileBefore(target), file.before)) {
        throw new Error(`Guard file changed during update: ${file.name}`);
      }
      io.rename(join(staging, file.name), target);
      applied.push(file);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const file of applied.reverse()) {
      try {
        const target = join(options.plugin, file.name);
        // Do not overwrite a third party's edit during rollback.
        if (!sameBytes(historyGuardFileBefore(target), Buffer.from(file.content))) {
          throw new Error(`Guard file changed before rollback: ${file.name}`);
        }
        if (file.before === null) rmSync(target);
        else {
          const restored = join(staging, file.name);
          copyFileSync(join(backup, file.name), restored);
          io.rename(restored, target);
        }
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    failures.push(rollbackErrors.length
      ? new AggregateError([error, ...rollbackErrors], `History guard rollback incomplete; backups retained at ${backup}`)
      : error);
  } finally {
    // Only remove our unique staging directory; stale/foreign files are untouched.
    try { io.removeStaging(staging); }
    catch (error) {
      failures.push(new Error(`History guard ${failures.length ? "operation failed" : "files committed"}; staging cleanup failed at ${staging}`, { cause: error }));
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `History guard operation and staging cleanup failed; backups retained at ${backup}`);
  return backup;
}
