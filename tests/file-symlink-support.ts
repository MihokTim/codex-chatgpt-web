import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Windows may require Developer Mode or administrator privileges for file symlinks. */
export function supportsFileSymlinks(): boolean {
  const root = mkdtempSync(join(tmpdir(), "cgw-symlink-capability-"));
  try {
    const target = join(root, "target");
    writeFileSync(target, "probe");
    symlinkSync(target, join(root, "alias"));
    return true;
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
