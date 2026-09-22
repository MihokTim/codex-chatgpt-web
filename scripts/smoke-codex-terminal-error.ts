import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { bridgeToResponsesSSE } from "../src/bridge";
import { defaultConfig, providerConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { responseRequest } from "../src/server";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import type { AdapterEvent } from "../src/types";

// Entirely local contract probe: isolated CODEX_HOME, fake provider, no ChatGPT or real tools.
const codex = resolve(process.argv[2] ?? "");
if (!existsSync(codex)) throw new Error("Pass an installed native Codex executable");
const bundled = spawnSync(codex, ["debug", "models", "--bundled"], { encoding: "utf8", timeout: 15_000 });
if (bundled.status !== 0) throw new Error(bundled.stderr);
const config = defaultConfig("browser-only");
config.proAvailable = true;
const catalog = augmentNativeModelCatalog(JSON.parse(bundled.stdout), config);
const root = resolve("output", `terminal-error-smoke-${Date.now()}`);
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "models.json"), JSON.stringify(catalog));
const failure: AdapterEvent = {
  type: "error", status: 502, errorType: "server_error",
  code: "chatgpt_submitted_turn_failed", retryable: false,
  message: "ChatGPT stopped responding after the task started. Check the ChatGPT tab before continuing.",
};

for (const terminalReplay of [false, true]) {
  let requests = 0;
  let browserStarts = 0;
  const worker = ChatGptBrowserWorker.forProvider(providerConfig(config));
  const originalRun = worker.run;
  worker.run = async turn => {
    browserStarts++;
    await turn.onSendActivated?.();
    turn.onSubmitted?.();
    throw new Error("ChatGPT exposed 2 new conversation turns for one submitted message");
  };
  const statuses: number[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/responses") return new Response("Not found", { status: 404 });
    requests++;
    if (terminalReplay) {
      const response = await responseRequest(request, config, undefined, { rememberState: false });
      statuses.push(response.status);
      return response;
    }
    await request.json();
    statuses.push(200);
    async function* events() { yield failure; }
    return new Response(bridgeToResponsesSSE(events(), "chatgpt-web/high"), { headers: { "content-type": "text/event-stream" } });
  } });
  const home = join(root, terminalReplay ? "terminal-replay" : "baseline");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.toml"), [
    'model = "chatgpt-web/high"', 'model_provider = "local-smoke"',
    `model_catalog_json = ${JSON.stringify(join(root, "models.json"))}`,
    '[model_providers.local-smoke]', 'name = "Local terminal error smoke"',
    `base_url = "http://127.0.0.1:${server.port}/v1"`,
    'env_key = "OPENAI_API_KEY"', 'wire_api = "responses"', 'supports_websockets = false', "",
  ].join("\n"));
  const started = Date.now();
  const child = Bun.spawn([codex, "exec", "--skip-git-repo-check", "--json", "--sandbox", "read-only", "--model", "chatgpt-web/high", "Test the local provider terminal failure contract."], {
    cwd: home, env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: "local-terminal-smoke" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 30_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    writeFileSync(join(home, "stdout.jsonl"), stdout);
    writeFileSync(join(home, "stderr.log"), stderr);
    const result = { terminalReplay, requests, browserStarts, statuses, exitCode, durationMs: Date.now() - started,
      reconnectMessages: stdout.split("\n").filter(line => /Reconnecting|stream disconnected/.test(line)) };
    writeFileSync(join(home, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    if (exitCode === 0 || result.durationMs >= 30_000) throw new Error("Native Codex did not terminate as a failure in time");
    if (terminalReplay && (requests !== 2 || browserStarts !== 1 || !stdout.includes(failure.code!))) throw new Error("Production terminal replay did not stop native retries with its real error code and one browser execution");
    if (!terminalReplay && requests < 5) throw new Error("The installed Codex no longer reproduces the repeated SSE failure retries");
  } finally {
    clearTimeout(timeout);
    await server.stop(true);
    worker.run = originalRun;
    chatGptTurnSessions.clear();
  }
}
console.log(`NATIVE_CODEX_TERMINAL_ERROR_SMOKE_OK ${root}`);
