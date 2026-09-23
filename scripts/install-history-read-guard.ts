import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { historyGuardFileBefore, replaceHistoryGuardFiles, type HistoryGuardFileIO } from "./history-guard-files";

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

const HELPER_NAMES = ["history-guard-adapter.mjs", "bounded-thread-history.ts"] as const;
const RECEIPT = "history-guard-receipt.json";
interface HistoryGuardReceipt {
  installedAt: string;
  plugin: string;
  backup: string;
  originalSha: string;
  patchedSha: string;
  fileHashes: Record<string, string>;
  appliesTo: string;
  restartRequiredForExistingMcpServers: boolean;
  updatePolicy: string;
  previousFilesBackup?: string;
  updatedAt?: string;
}

// The CLI retains the exact-version/hash policy. These filesystem operations take
// explicit paths so failure tests never need the user's installed plugin.
export function updateHistoryGuard(options: {
  plugin: string; sourceRoot: string; backupRoot: string; apply: boolean; io?: HistoryGuardFileIO;
}) {
  const { plugin, sourceRoot, backupRoot } = options;
  const receiptPath = join(plugin, RECEIPT);
  const receiptBytes = readFileSync(receiptPath);
  let receipt: HistoryGuardReceipt = JSON.parse(receiptBytes.toString("utf8"));
  if (digest(readFileSync(join(plugin, "server.mjs"))) !== receipt.patchedSha) throw new Error("Guarded server checksum mismatch");
  const installed = new Map<string, Buffer>();
  for (const name of [...HELPER_NAMES, "history-guard-config.json"]) {
    const content = readFileSync(join(plugin, name));
    if (digest(content) !== receipt.fileHashes[name]) throw new Error(`Guard helper changed: ${name}`);
    installed.set(name, content);
  }
  const updates = HELPER_NAMES.map(name => ({ name, content: readFileSync(join(sourceRoot, name)) }))
    .filter(file => digest(file.content) !== receipt.fileHashes[file.name]);
  if (options.apply && updates.length) {
    replaceHistoryGuardFiles({ plugin, backupRoot, backupPrefix: "desktop-history-guard-update-", io: options.io,
      files: backup => {
        receipt = { ...receipt, previousFilesBackup: backup, updatedAt: new Date().toISOString(),
          fileHashes: { ...receipt.fileHashes, ...Object.fromEntries(updates.map(file => [file.name, digest(file.content)])) },
          // Updating files does not confirm that existing MCP processes restarted.
          restartRequiredForExistingMcpServers: receipt.restartRequiredForExistingMcpServers || updates.some(file => file.name === "history-guard-adapter.mjs"
            && file.content.toString("utf8").replace(/\r\n/g, "\n") !== installed.get(file.name)!.toString("utf8").replace(/\r\n/g, "\n")),
        };
        return [...updates.map(file => ({ ...file, before: installed.get(file.name)! })),
          { name: RECEIPT, content: JSON.stringify(receipt, null, 2), before: receiptBytes }];
      },
    });
  }
  return { installed: true, ...receipt, sourceAligned: options.apply || updates.length === 0,
    ...(!options.apply ? { pendingSourceUpdates: updates.map(file => file.name) } : {}) };
}

export function installHistoryGuard(options: {
  plugin: string; backupRoot: string; source: string; patched: string; files: Map<string, string>;
  validateStagedServer(path: string): void; io?: HistoryGuardFileIO;
}) {
  const { plugin, backupRoot, source, patched, files } = options;
  let receipt!: HistoryGuardReceipt;
  const helpers = [...files].map(([name, content]) => ({ name, content, before: historyGuardFileBefore(join(plugin, name)) }));
  const receiptBefore = historyGuardFileBefore(join(plugin, RECEIPT));
  replaceHistoryGuardFiles({ plugin, backupRoot, backupPrefix: "desktop-history-guard-", io: options.io,
    files: backup => {
      receipt = { installedAt: new Date().toISOString(), plugin, backup, originalSha: digest(source), patchedSha: digest(patched),
        fileHashes: Object.fromEntries([...files].map(([name, value]) => [name, digest(value)])),
        appliesTo: "codex-app-tools 0.1.4 / Desktop 26.915.4065.0", restartRequiredForExistingMcpServers: true,
        updatePolicy: "Version/hash guarded; plugin upgrades may replace this local fix. Recheck after upgrade." };
      writeFileSync(join(backup, "receipt.json"), JSON.stringify(receipt, null, 2), { flag: "wx" });
      return [...helpers, { name: "server.mjs", content: patched, before: Buffer.from(source) },
        { name: RECEIPT, content: JSON.stringify(receipt, null, 2), before: receiptBefore }];
    },
    validate: staging => options.validateStagedServer(join(staging, "server.mjs")),
  });
  return { installed: true, ...receipt };
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "--check";
  const plugin = join(homedir(), ".codex/plugins/cache/openai-bundled/codex-app-tools/0.1.4");
  const server = join(plugin, "server.mjs");
  const receiptPath = join(plugin, "history-guard-receipt.json");
  const backupRoot = resolve(homedir(), ".codex-chatgpt-web/backups");
  const sourceRoot = dirname(fileURLToPath(import.meta.url));
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
      console.log(JSON.stringify(updateHistoryGuard({ plugin, sourceRoot, backupRoot, apply: mode === "--apply" })));
    } else {
      const patched = patchHistoryServer(source);
      const bun = join(homedir(), ".codex-chatgpt-web/versions/5.0.8-win32-x64/runtime/bun.exe");
      if (!existsSync(bun)) throw new Error("Expected Bun runtime unavailable");
      const files = new Map<string, string>([
        ["history-guard-adapter.mjs", readFileSync(join(sourceRoot, "history-guard-adapter.mjs"), "utf8")],
        ["bounded-thread-history.ts", readFileSync(join(sourceRoot, "bounded-thread-history.ts"), "utf8")],
        ["history-guard-config.json", JSON.stringify({ bun }, null, 2)],
      ]);
      if (mode === "--check") console.log(JSON.stringify({ supported: true, originalSha: digest(source), patchedSha: digest(patched), files: [...files.keys()] }));
      else {
        // No app.asar/MSIX/config/marketplace edits; this exact bundled MCP server version only.
        const node = join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe");
        console.log(JSON.stringify(installHistoryGuard({ plugin, backupRoot, source, patched, files,
          validateStagedServer: staged => {
            const check = spawnSync(node, ["--check", staged], { encoding: "utf8", windowsHide: true, timeout: 15000 });
            if (check.status !== 0) throw new Error(`Staged MCP server syntax check failed: ${check.error?.message ?? check.stderr}`);
          },
        })));
      }
    }
  } else throw new Error("Use --check, --apply, or --restore");
}
