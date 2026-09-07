/** One-time, guarded migration of an existing bridge installation to its own CODEX_HOME. */
import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadConfig, getConfigDir, atomicWriteFile } from "../src/config";
import { getCodexJournalPath, getCodexJournalRecoveryPath, snapshotFile, restoreFileSnapshot } from "../src/codex-integration-shared";
import { installCodexIntegration, uninstallCodexIntegration, inspectCodexIntegration } from "../src/codex-integration";

const nativeHome = resolve(process.argv[2] || join(homedir(), ".codex"));
const webHome = resolve(join(getConfigDir(), "codex-home"));
if (nativeHome.toLowerCase() === webHome.toLowerCase()) throw new Error("Native and Web homes must differ");
const config = loadConfig();
if (!config.solAvailable || !config.proAvailable) throw new Error("This Web Pro migration requires Sol and Pro availability");
if (existsSync(join(webHome, "config.toml"))) throw new Error("Web home already exists; inspect it instead of repeating migration");
const journalPath = getCodexJournalPath();
const journal = JSON.parse(readFileSync(journalPath, "utf8"));
if (resolve(journal.configPath).toLowerCase() !== join(nativeHome, "config.toml").toLowerCase()) {
  throw new Error("Existing journal does not target the requested native home");
}
const participants = [join(nativeHome, "config.toml"), join(nativeHome, "models_cache.json"), journalPath,
  getCodexJournalRecoveryPath(), join(webHome, "config.toml"), join(webHome, "auth.json"), join(webHome, "AGENTS.md")];
const snapshots = participants.map(snapshotFile);
const backupDir = join(getConfigDir(), "backups", `native-web-isolation-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const manifest = snapshots.filter(s => s.exists).map((s, i) => {
  const backup = join(backupDir, `${i}.backup`);
  writeFileSync(backup, s.data!, { mode: 0o600 });
  return { path: s.path, backup, sha256: createHash("sha256").update(s.data!).digest("hex") };
});
writeFileSync(join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
const previousHome = process.env.CODEX_HOME;
try {
  process.env.CODEX_HOME = nativeHome;
  const before = inspectCodexIntegration();
  if (before.errors.length) throw new Error(before.errors.join("; "));
  uninstallCodexIntegration(); // Existing journal restores only bridge-owned native settings.
  mkdirSync(webHome, { recursive: true, mode: 0o700 });
  atomicWriteFile(join(webHome, "config.toml"), `# Web-only Codex profile. Native Codex uses its original home.\nmodel = "chatgpt-web/pro"\nmodel_reasoning_effort = "ultra"\ndeveloper_instructions = """\nUse Web routes for delegated work in this profile. The user authorizes useful subagent delegation. Usually omit model and reasoning_effort to use the configured chatgpt-web/extra-high child default (Web Sol xHigh). For a difficult or critical subtask you may explicitly select chatgpt-web/pro with reasoning_effort ultra (Web Astra Pro). You may choose another supported Web effort when appropriate. Do not route children to native model slugs.\n"""\n\n[agents]\ndefault_subagent_model = "chatgpt-web/extra-high"\n\n[windows]\nsandbox = "elevated"\n`);
  // Copy local login without printing credentials; subsequent refreshes belong to each home.
  for (const name of ["auth.json", "AGENTS.md"]) {
    if (existsSync(join(nativeHome, name))) {
      copyFileSync(join(nativeHome, name), join(webHome, name));
      if (process.platform !== "win32") chmodSync(join(webHome, name), 0o600);
    }
  }
  process.env.CODEX_HOME = webHome;
  installCodexIntegration(config);
  const after = inspectCodexIntegration();
  if (after.errors.length || !after.active) throw new Error(`Web profile validation failed: ${after.errors.join("; ")}`);
  console.log(JSON.stringify({ nativeHome, webHome, backupDir, active: after.active }));
} catch (error) {
  const failures: string[] = [];
  for (const snapshot of snapshots.toReversed()) {
    try { restoreFileSnapshot(snapshot); } catch (e) { failures.push(String(e)); }
  }
  throw new Error(`${error}${failures.length ? `; rollback failed: ${failures.join("; ")}` : ""}`);
} finally {
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
}