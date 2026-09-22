import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { augmentNativeModelCatalog } from "../src/model-catalog";

// Explicit live acceptance: only Sol Pro, an isolated CODEX_HOME, and a synthetic file.
const codex = resolve(process.argv[2] ?? "");
const sandbox = process.argv[3] ?? "read-only";
const discoverFirst = process.argv.includes("--discover-first");
const matchCurrentFullAccess = process.argv.includes("--match-current-full-access");
if (sandbox !== "read-only" && sandbox !== "workspace-write"
  && !(sandbox === "danger-full-access" && matchCurrentFullAccess)) {
  throw new Error("Use read-only/workspace-write, or explicitly match an already-authorized full-access task");
}
const config = JSON.parse(readFileSync(join(homedir(), ".codex-chatgpt-web/config.json"), "utf8"));
const health = await fetch(`http://${config.host}:${config.port}/healthz`).then(r => r.json()) as {
  accepting_turns: boolean; active_browser_turns: number;
};
if (!health.accepting_turns || health.active_browser_turns >= 5) throw new Error("No free browser slot");
const bundled = spawnSync(codex, ["debug", "models", "--bundled"], { encoding: "utf8", timeout: 15000, windowsHide: true });
if (bundled.status !== 0) throw new Error("Native catalog unavailable");
const root = resolve("output", `sol-tool-roundtrip-${Date.now()}`);
mkdirSync(root, { recursive: true });
const token = `SOLTOOL-${crypto.randomUUID()}`;
writeFileSync(join(root, "nonce.txt"), token);
writeFileSync(join(root, "models.json"), JSON.stringify(augmentNativeModelCatalog(JSON.parse(bundled.stdout), config)));
writeFileSync(join(root, "config.toml"), [
  'model = "chatgpt-web/light"', 'model_provider = "sol-acceptance"',
  `model_catalog_json = ${JSON.stringify(join(root, "models.json"))}`,
  'approval_policy = "never"', `sandbox_mode = ${JSON.stringify(sandbox)}`,
  '[model_providers.sol-acceptance]', 'name = "Sol tool roundtrip acceptance"',
  `base_url = "http://${config.host}:${config.port}/v1"`, 'env_key = "OPENAI_API_KEY"',
  'wire_api = "responses"', 'supports_websockets = false', '',
].join("\n"));
const started = Date.now();
const discovery = discoverFirst
  ? "First call Codex Native2's codex_tool_inventory once with query exec_command and include_schema true, using the current turn capability. This is a tool visibility diagnostic. Distinguish the outer native inventory from the connector functions actually callable in ChatGPT. If ChatGPT provides tool search, use it once to discover Codex Native2 codex_exec. Do not infer a tool is callable merely because its name appears in the inventory. "
  : "";
const child = Bun.spawn([codex, "exec", "--ephemeral", "--skip-git-repo-check", "--json", "--sandbox", sandbox,
  discovery + "Read nonce.txt in the current working directory by calling the native command execution tool: the ChatGPT Codex connector exposes it as codex_exec, forwarding to exec_command. Run Get-Content -LiteralPath nonce.txt. Its random contents are not in this prompt. Return exactly those contents. If the function is not exposed, return TOOL_NOT_EXPOSED. If an actual call is blocked by a permission or safety check, return TOOL_CALL_BLOCKED. For another invocation error, return TOOL_CALL_FAILED. Distinguish the tools actually exposed, whether a call was attempted, and the observed error; do not describe a blocked call as a missing tool. If an inventory was requested, summarize its actual result without copying capability tokens. Do not use view_image, image tools, browser tools, or alternative file-reading tricks. Do not retry an unavailable or blocked command, change permissions, spawn agents, change models, or modify files."], {
  cwd: root, env: { ...process.env, CODEX_HOME: root, OPENAI_API_KEY: "local-sol-acceptance" },
  stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
});
console.log(JSON.stringify({ started: true, root, pid: child.pid, model: "chatgpt-web/light", sandbox, discoverFirst, biggerContext: config.experimentalBiggerContext }));
// Do not cancel an accepted Pro generation merely to meet a test timeout.
const progress = setInterval(() => console.log(JSON.stringify({ pid: child.pid, elapsedMs: Date.now() - started })), 30000);
try {
  async function record(stream: ReadableStream<Uint8Array>, path: string) {
    writeFileSync(path, ""); const chunks: Buffer[] = [];
    for await (const part of stream) { const bytes = Buffer.from(part); appendFileSync(path, bytes); chunks.push(bytes); }
    return Buffer.concat(chunks).toString("utf8");
  }
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, record(child.stdout, join(root, "stdout.jsonl")), record(child.stderr, join(root, "stderr.log"))]);
  const events = stdout.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const answers = events.filter(e => e.type === "item.completed" && e.item?.type === "agent_message").map(e => e.item.text);
  const commands = events.filter(e => e.type === "item.completed" && e.item?.type === "command_execution");
  const result = { exitCode, durationMs: Date.now() - started, sandbox, discoverFirst, answers, commands,
    errors: events.filter(e => e.type === "error" || e.type === "turn.failed"),
    success: exitCode === 0 && answers.at(-1)?.trim() === token && commands.some(e => e.item.aggregated_output?.includes(token)) && events.some(e => e.type === "turn.completed"),
  };
  writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  if (!result.success) process.exitCode = 1;
} finally { clearInterval(progress); }
