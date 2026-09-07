import { existsSync, readFileSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { identity } from "../launcher/electron/web-home.cjs";
import { getConfigDir } from "./config";
import { getCodexHome, getCodexJournalPath, getCodexJournalRecoveryPath, snapshotFile, restoreFileSnapshot, withLegacyCodexHome, sha256 } from "./codex-integration-shared";
import { readJournal } from "./codex-integration-journal";
import { restoreLegacyV2, restoreManagedRoute, managedJournalIsActive, verifyRestoredRoute } from "./codex-integration-route";
import { uninstallCodexIntegration } from "./codex-integration";

export function assertNativeConfig(text: string): void {
  const config: any = Bun.TOML.parse(text.replace(/^\uFEFF/, "").replace(/\r(?!\n)/g, "\n"));
  const check = (value: any): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, field] of Object.entries(value)) {
      if (["model", "default_subagent_model", "developer_instructions"].includes(key)
        && typeof field === "string" && field.includes("chatgpt-web/")) {
        throw new Error(`Native config contains unmanaged Web ${key}; resolve it before migration`);
      }
      if (typeof field === "object") check(field);
    }
  };
  check(config);
}
export function planHomeMigration() {
  const webHome = getCodexHome(); // Validate physical isolation before reading or writing any journal.
  const candidates = [getCodexJournalPath(), getCodexJournalRecoveryPath()].filter(existsSync);
  if (!candidates.length) return undefined;
  const raw = candidates.flatMap(path => {
    try { return [JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""))]; } catch { return []; }
  })[0];
  if (!raw) { readJournal(); throw new Error("Invalid integration journals"); }
  if (typeof raw.configPath !== "string") throw new Error("Invalid integration journal target");
  if (identity(raw.configPath) === identity(join(webHome, "config.toml"))) return undefined;
  const nativeHome = dirname(raw.configPath);
  if (identity(nativeHome) === identity(webHome)) throw new Error("Native and Web homes must differ");
  if (existsSync(webHome) && readdirSync(webHome).length) throw new Error("Migration target Web home is not empty; refusing to overwrite it");
  const journal = withLegacyCodexHome(nativeHome, () => readJournal());
  if (!journal) throw new Error("Legacy journal disappeared");
  const current = readFileSync(journal.configPath, "utf8");
  let restored: string;
  if (journal.version === 2) restored = restoreLegacyV2(current, journal);
  else if (managedJournalIsActive(journal)) restored = restoreManagedRoute(current, journal);
  else { verifyRestoredRoute(current, journal as Exclude<typeof journal, {version: 3}>); restored = current; }
  assertNativeConfig(restored);
  return { nativeHome, webHome, journal, restored };
}
export function migrateHome<T>(plan: NonNullable<ReturnType<typeof planHomeMigration>>, install: () => T, fault?: (step: string) => void): T {
  const { nativeHome, webHome, journal } = plan;
  const paths = [journal.configPath, join(nativeHome, "models_cache.json"), getCodexJournalPath(), getCodexJournalRecoveryPath(),
    ...["config.toml", "models_cache.json", "auth.json", "AGENTS.md"].map(name => join(webHome, name)),
    ...(journal.version === 2 ? [journal.catalogPath] : [])];
  const snapshots = paths.map(snapshotFile);
  const backupDir = join(getConfigDir(), "backups", `home-isolation-${Date.now()}`);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const manifest = snapshots.filter(s => s.exists).map((s, i) => {
    const backup = join(backupDir, `${i}.backup`);
    writeFileSync(backup, s.data!, { mode: 0o600 });
    return { path: s.path, backup, sha256: sha256(s.data!) };
  });
  writeFileSync(join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  try {
    withLegacyCodexHome(nativeHome, uninstallCodexIntegration);
    assertNativeConfig(readFileSync(journal.configPath, "utf8"));
    fault?.("native-restored");
    mkdirSync(webHome, { recursive: true, mode: 0o700 });
    for (const name of ["auth.json", "AGENTS.md"]) {
      if (existsSync(join(nativeHome, name))) {
        copyFileSync(join(nativeHome, name), join(webHome, name));
        if (process.platform !== "win32") chmodSync(join(webHome, name), 0o600);
      }
    }
    const result = install();
    fault?.("web-installed");
    return result;
  } catch (error) {
    const failures: string[] = [];
    for (const s of snapshots.toReversed()) {
      try { restoreFileSnapshot(s); } catch (e) { failures.push(String(e)); }
    }
    throw new Error(`${error}${failures.length ? `; rollback failed: ${failures.join("; ")}` : ""}`);
  }
}
