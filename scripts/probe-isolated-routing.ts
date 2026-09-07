import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
const [mode, codex, home, outputDir] = process.argv.slice(2);
if (!codex || !home || !outputDir || !["native", "web"].includes(mode!)) throw new Error("Usage: probe-isolated-routing.ts native|web CODEX HOME OUTPUT_DIR");
mkdirSync(outputDir, { recursive: true });
const prompt = mode === "native"
  ? "This is a bounded routing probe. Spawn exactly one child, omit model and reasoning effort and do not fork history. Ask it only to reply NATIVE_CHILD_OK. Do not use shell, network, file or app tools. Wait for this child to complete, then reply NATIVE_ROUTING_OK followed by its exact answer. Do not create any other agents or do other work."
  : "This is a bounded routing probe. Spawn exactly two children with no forked history: first OMIT model and reasoning_effort entirely and ask it only to reply DEFAULT_WEB_CHILD_OK; second explicitly select model chatgpt-web/pro and reasoning_effort ultra and ask it only to reply ESCALATED_WEB_CHILD_OK. This explicit Pro call tests authorized critical-task escalation. Do not use shell, network, file or app tools. Wait for both to complete and reply WEB_ROUTING_OK followed by their exact answers. Do not create other agents or do other work.";
const baseConfig = Bun.TOML.parse(readFileSync(join(home, "config.toml"), "utf8")) as { mcp_servers?: Record<string, unknown> };
const args = ["exec", "--skip-git-repo-check", "--json", "--sandbox", "read-only", "-c", "approval_policy=\"never\"", "-c", "features.plugins=false",
  ...Object.keys(baseConfig.mcp_servers ?? {}).flatMap(name => ["-c", `mcp_servers.${name}.enabled=false`]),
  ...(mode === "native" ? ["--model", "gpt-6-astra", "-c", "model_reasoning_effort=\"medium\""] : []), prompt];
const child = spawn(resolve(codex), args, { cwd: process.cwd(), env: { ...process.env, CODEX_HOME: resolve(home) }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let stdout = "", stderr = "";
child.stdout.on("data", data => { stdout += data; });
child.stderr.on("data", data => { stderr += data; });
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10 * 60_000);
const exitCode = await new Promise<number | null>((res, rej) => { child.on("error", rej); child.on("exit", res); });
clearTimeout(timer);
writeFileSync(join(outputDir, `${mode}.stdout.jsonl`), stdout, { mode: 0o600 });
writeFileSync(join(outputDir, `${mode}.stderr.txt`), stderr, { mode: 0o600 });
const events = stdout.split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const thread = events.find(e => e.type === "thread.started")?.thread_id;
const final = events.filter(e => e.type === "item.completed" && e.item?.type === "agent_message").map(e => e.item.text).at(-1);
console.log(JSON.stringify({ mode, exitCode, timedOut, thread, final, outputDir }));
if (exitCode !== 0 || timedOut || !final?.replaceAll("\\_", "_").includes(mode === "native" ? "NATIVE_ROUTING_OK" : "WEB_ROUTING_OK")) process.exit(1);