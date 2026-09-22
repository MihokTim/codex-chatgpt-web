import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

/** Bounded reads: this collector never opens task rollouts, SQLite history, images or credentials. */
export function tail(file: string, maxBytes = 512 * 1024): string {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(Math.min(maxBytes, size));
    const text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, start)).toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { closeSync(fd); }
}

const fields = new Set(["threadId", "turnId", "conversationId", "requestId", "callId", "itemId", "toolName", "tool", "method", "durationMs", "queueWaitMs", "errorCode", "exitCode", "signal", "reason", "status", "success", "targetDestroyed", "rendererWebContentsId", "trace", "traceId", "stage", "phase", "requested", "effort", "slider", "family", "selected"]);
export function nativeMetadata(line: string): Record<string, unknown> {
  const values: Record<string, string> = {};
  for (const match of line.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)=("?[A-Za-z0-9_./:-]{1,128}"?)(?=\s|$|[,}])/g)) {
    if (fields.has(match[1]!)) values[match[1]!] = match[2]!.replaceAll('"', "");
  }
  const at = /^\d{4}-\d\d-\d\dT[^ ]+/.exec(line)?.[0];
  const markers = ["read_thread", "thread/read", "thread/turns/list", "thread/items/list", "Sending server response", "response_routed", "stream disconnected", "Reconnecting", "out of memory", "oom", "render-process-gone", "child-process-gone", "Crashpad", "upstream_stall_timeout", "chatgpt_turn_identity_conflict", "chatgpt_model_selection_failed", "connector_not_found", "submission accepted", "browser turn"].filter(label => line.toLowerCase().includes(label.toLowerCase()));
  return { at, markers, ...values };
}

function files(directory: string, recursive = false, depth = 0): string[] {
  if (!existsSync(directory)) return [];
  const output: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).slice(0, 2000)) {
    const file = join(directory, entry.name);
    if (entry.isFile()) output.push(file);
    else if (recursive && entry.isDirectory() && depth < 4) output.push(...files(file, true, depth + 1));
    if (output.length >= 2000) break;
  }
  return output.slice(0, 2000);
}

function newest(paths: string[], count: number): string[] {
  return paths.map(file => ({ file, modified: statSync(file).mtimeMs })).sort((a, b) => b.modified - a.modified).slice(0, count).map(item => item.file);
}

export async function collectIncident(base = join(homedir(), ".codex-chatgpt-web", "diagnostics", "incidents")): Promise<string> {
  base = resolve(base);
  const destination = join(base, `incident-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
  mkdirSync(destination, { recursive: true });
  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const roaming = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  const packages = join(local, "Packages");
  const codexPackages = existsSync(packages) ? readdirSync(packages).filter(name => /^OpenAI\.Codex_[A-Za-z0-9]+$/.test(name)).map(name => join(packages, name, "LocalCache")) : [];
  const sources: Record<string, unknown>[] = [];
  const write = (name: string, value: unknown) => writeFileSync(join(destination, name), JSON.stringify(value, null, 2));
  const nativeRoots = [join(local, "Codex", "Logs"), ...codexPackages.map(root => join(root, "Local", "Codex", "Logs"))];
  const nativeFiles = newest(nativeRoots.flatMap(root => files(root, true)).filter(file => file.endsWith(".log")), 12);
  for (const [index, file] of nativeFiles.entries()) {
    const records = tail(file).split(/\r?\n/).filter(line => line.length < 32_768).map(nativeMetadata).filter(record => Object.keys(record).length > 2 || (record.markers as string[]).length > 0);
    write(`native-${index}.json`, records);
    sources.push({ kind: "native_metadata", path: file, originalBytes: statSync(file).size, maxReadBytes: 512 * 1024 });
  }
  const launcherRoot = join(roaming, "Codex Web GPT", "logs");
  const launcherRecords: unknown[] = [];
  for (const file of [join(launcherRoot, "launcher.jsonl.1"), join(launcherRoot, "launcher.jsonl")].filter(existsSync)) {
    for (const line of tail(file, 4 * 1024 * 1024).split(/\r?\n/)) {
      if (line.length > 32_768) continue;
      try {
        const record = JSON.parse(line);
        const message = typeof record.detail?.line === "string" ? record.detail.line : typeof record.detail?.message === "string" ? record.detail.message : "";
        const start = message.indexOf("http_turn {");
        // http_turn's own schema contains only scalar metadata and event counts.
        let httpTurn;
        if (start >= 0) {
          try { httpTurn = JSON.parse(message.slice(start + "http_turn ".length)); } catch {}
        }
        const detail: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(record.detail ?? {})) {
          if (fields.has(key) && (typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && /^[A-Za-z0-9_./:-]{1,128}$/.test(value)))) detail[key] = value;
        }
        launcherRecords.push({ ...nativeMetadata(message), at: record.at, level: record.level, event: record.event, ...detail, ...(httpTurn ? { httpTurn } : {}) });
      } catch {}
    }
    sources.push({ kind: "launcher_metadata", path: file, originalBytes: statSync(file).size });
  }
  write("launcher-metadata.json", launcherRecords);
  const diagnostics = join(homedir(), ".codex-chatgpt-web", "diagnostics");
  const browserRoot = join(diagnostics, "browser-turns");
  const recentBrowserDirectories = existsSync(browserRoot) ? newest(readdirSync(browserRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(browserRoot, entry.name)), 10) : [];
  const browserFiles = newest(recentBrowserDirectories.flatMap(directory => files(directory)).filter(file => file.endsWith(".json")), 60);
  // These snapshots are authored by ChatGptBrowserDiagnostics and contain counts/structure only.
  for (const [index, file] of browserFiles.entries()) {
    if (statSync(file).size > 128 * 1024) continue;
    try {
      const record = JSON.parse(readFileSync(file, "utf8"));
      if (record.version !== 2 || typeof record.traceId !== "string" || !record.state) continue;
      write(`browser-${index}.json`, record);
      sources.push({ kind: "browser_structure", path: file });
    } catch {}
  }
  const crashRoots = [join(roaming, "Codex", "web", "Codex", "Crashpad"), ...codexPackages.map(root => join(root, "Roaming", "Codex", "web", "Codex", "Crashpad"))];
  const crashes = newest(crashRoots.flatMap(root => files(root, true)), 40).map(file => {
    const info = statSync(file);
    let sidecar;
    if (file.endsWith("_sidecar.json") && info.size < 16_384) {
      try { const parsed = JSON.parse(readFileSync(file, "utf8")); sidecar = { capture_kind: parsed.capture_kind, ptype: parsed.ptype, osarch: parsed.osarch }; } catch {}
    }
    return { path: file, bytes: info.size, modifiedAt: info.mtime.toISOString(), sidecar };
  });
  write("crash-metadata.json", crashes);
  const recorderRoot = join(diagnostics, "incident-recorder");
  for (const file of files(recorderRoot).filter(file => /^samples\.jsonl(?:\.[1-3])?$/.test(basename(file)))) {
    writeFileSync(join(destination, basename(file)), tail(file, 2 * 1024 * 1024));
  }
  let health: unknown;
  try { health = await (await fetch("http://127.0.0.1:17841/healthz", { signal: AbortSignal.timeout(2000) })).json(); } catch { health = { reachable: false }; }
  write("manifest.json", { capturedAt: new Date().toISOString(), health, sources, limits: { nativeFiles: 12, nativeTailBytes: 512 * 1024, browserFiles: 60, browserMaxBytes: 128 * 1024 }, omitted: ["task_rollouts", "history_databases", "image_payloads", "request_bodies", "credentials", "crash_dump_bodies"] });
  // Own outputs only; retain the latest five bundles. Never delete source logs or arbitrary paths.
  const bundles = readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^incident-\d{4}-\d\d-\d\dT[\dZ-]+-\d+$/.test(entry.name)).map(entry => join(base, entry.name));
  for (const directory of newest(bundles, bundles.length).slice(5)) {
    const target = resolve(directory);
    if (!target.startsWith(base + sep) || !existsSync(join(target, "manifest.json"))) throw new Error("Unsafe incident retention target");
    rmSync(target, { recursive: true });
  }
  return destination;
}

if (import.meta.main) console.log(await collectIncident(process.argv[2]));
