import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const SUPPORTED_SERVER_SHA = "72738d48d14057665260f59a7be80c6a5bf11a3896587b4a2adb1789c62742a9";
const MARKER = "// Local bounded-history guard v1 (2026-09-21)";
export const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export function patchHistoryServer(source: string): string {
  if (digest(source) !== SUPPORTED_SERVER_SHA) throw new Error("Unsupported app-tools server: refusing to patch unknown bytes");
  const anchor = "  const requestId = String(extra.requestId);";
  if (source.split(anchor).length !== 2) throw new Error("MCP handler patch anchor is not unique");
  return `${MARKER}\nimport { protectLocalHistoryRead as localBoundedHistoryGuard } from './history-guard-adapter.mjs';\n` + source.replace(anchor,
    "  const guardedHistory = await localBoundedHistoryGuard(request.params.name, request.params.arguments, extra.signal);\n  if (guardedHistory !== null) return guardedHistory;\n" + anchor);
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "--check";
  const plugin = join(homedir(), ".codex/plugins/cache/openai-bundled/codex-app-tools/0.1.4");
  const server = join(plugin, "server.mjs");
  const receiptPath = join(plugin, "history-guard-receipt.json");
  const source = readFileSync(server, "utf8");
  if (mode === "--restore") {
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (digest(source) !== receipt.patchedSha) throw new Error("Server changed since guard install; restore refused");
    const backup = readFileSync(join(receipt.backup, "server.mjs"));
    if (digest(backup) !== SUPPORTED_SERVER_SHA) throw new Error("Backup checksum mismatch");
    writeFileSync(server + ".restore.tmp", backup); renameSync(server + ".restore.tmp", server);
    console.log(JSON.stringify({ restored: true, sha: digest(readFileSync(server)), restartRequiredForExistingMcpServers: true }));
  } else if (mode === "--check" || mode === "--apply") {
    if (source.startsWith(MARKER) && existsSync(receiptPath)) {
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      if (digest(source) !== receipt.patchedSha) throw new Error("Guarded server checksum mismatch");
      for (const [file, sha] of Object.entries(receipt.fileHashes)) {
        if (digest(readFileSync(join(plugin, file))) !== sha) throw new Error(`Guard helper changed: ${file}`);
      }
      const sourceRoot = dirname(fileURLToPath(import.meta.url));
      const updates = ["history-guard-adapter.mjs", "bounded-thread-history.ts"]
        .map(name => ({ name, content: readFileSync(join(sourceRoot, name)) }))
        .filter(file => digest(file.content) !== receipt.fileHashes[file.name]);
      if (mode === "--apply" && updates.length) {
        const backup = resolve(homedir(), ".codex-chatgpt-web/backups", `desktop-history-guard-update-${Date.now()}`);
        mkdirSync(backup, { recursive: true });
        copyFileSync(receiptPath, join(backup, "history-guard-receipt.json"));
        for (const file of updates) copyFileSync(join(plugin, file.name), join(backup, file.name));
        const applied: string[] = [];
        try {
          for (const file of updates) {
            const target = join(plugin, file.name);
            if (digest(readFileSync(target)) !== receipt.fileHashes[file.name]) throw new Error("Guard helper changed during update");
            const staged = `${target}.update.tmp`;
            writeFileSync(staged, file.content, { flag: "wx" }); renameSync(staged, target);
            applied.push(file.name);
          }
          receipt.previousFilesBackup = backup;
          receipt.updatedAt = new Date().toISOString();
          receipt.restartRequiredForExistingMcpServers = updates.some(file => file.name === "history-guard-adapter.mjs"
            && file.content.toString("utf8").replace(/\r\n/g, "\n")
              !== readFileSync(join(backup, file.name), "utf8").replace(/\r\n/g, "\n"));
          for (const file of updates) receipt.fileHashes[file.name] = digest(file.content);
          const stagedReceipt = `${receiptPath}.update.tmp`;
          writeFileSync(stagedReceipt, JSON.stringify(receipt, null, 2), { flag: "wx" }); renameSync(stagedReceipt, receiptPath);
        } catch (error) {
          for (const name of applied) copyFileSync(join(backup, name), join(plugin, name));
          throw error;
        }
      }
      console.log(JSON.stringify({ installed: true, ...receipt, sourceAligned: mode === "--apply" || updates.length === 0,
        ...(mode === "--check" ? { pendingSourceUpdates: updates.map(file => file.name) } : {}) }));
    } else {
      const patched = patchHistoryServer(source);
      const bun = join(homedir(), ".codex-chatgpt-web/versions/5.0.8-win32-x64/runtime/bun.exe");
      if (!existsSync(bun)) throw new Error("Expected Bun runtime unavailable");
      const sourceRoot = dirname(fileURLToPath(import.meta.url));
      const files = new Map<string, string>([
        ["history-guard-adapter.mjs", readFileSync(join(sourceRoot, "history-guard-adapter.mjs"), "utf8")],
        ["bounded-thread-history.ts", readFileSync(join(sourceRoot, "bounded-thread-history.ts"), "utf8")],
        ["history-guard-config.json", JSON.stringify({ bun }, null, 2)],
      ]);
      if (mode === "--check") console.log(JSON.stringify({ supported: true, originalSha: digest(source), patchedSha: digest(patched), files: [...files.keys()] }));
      else {
        // No app.asar/MSIX/config/marketplace edits; this exact bundled MCP server version only.
        const backup = resolve(homedir(), ".codex-chatgpt-web/backups", `desktop-history-guard-${Date.now()}`);
        mkdirSync(backup, { recursive: true }); copyFileSync(server, join(backup, "server.mjs"));
        for (const [file, content] of files) {
          const target = join(plugin, file);
          if (existsSync(target)) copyFileSync(target, join(backup, file));
          writeFileSync(target, content);
        }
        const staged = join(plugin, "server.history-guard-staged.mjs"); writeFileSync(staged, patched);
        const node = join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe");
        const check = spawnSync(node, ["--check", staged], { encoding: "utf8", windowsHide: true, timeout: 15000 });
        if (check.status !== 0) throw new Error(`Staged MCP server syntax check failed: ${check.stderr}`);
        const receipt = { installedAt: new Date().toISOString(), plugin, backup, originalSha: digest(source), patchedSha: digest(patched),
          fileHashes: Object.fromEntries([...files].map(([name, value]) => [name, digest(value)])),
          appliesTo: "codex-app-tools 0.1.4 / Desktop 26.915.4065.0", restartRequiredForExistingMcpServers: true,
          updatePolicy: "Version/hash guarded; plugin upgrades may replace this local fix. Recheck after upgrade." };
        writeFileSync(join(backup, "receipt.json"), JSON.stringify(receipt, null, 2));
        renameSync(staged, server); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
        console.log(JSON.stringify({ installed: true, ...receipt }));
      }
    }
  } else throw new Error("Use --check, --apply, or --restore");
}
