import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { defaultConfig, providerConfig } from "../src/config";
import { responseRequest } from "../src/server";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";

// Uses the installed native client and the real adapter/SSE implementation; no ChatGPT requests.
const codex = resolve(process.argv[2] ?? "");
const holdMs = Number(process.argv[3] ?? "315000");
if (!Number.isFinite(holdMs) || holdMs < 15000 || holdMs > 900000) throw new Error("Invalid hold duration");
const bundled = spawnSync(codex, ["debug", "models", "--bundled"], { encoding: "utf8", timeout: 15000, windowsHide: true });
if (bundled.status !== 0) throw new Error("Native model catalog unavailable");
const root = resolve("output", `stream-liveness-${Date.now()}`);
mkdirSync(root, { recursive: true });
const config = defaultConfig("browser-only");
config.proAvailable = true;
config.stallTimeoutSec = 15;
writeFileSync(join(root, "models.json"), JSON.stringify(augmentNativeModelCatalog(JSON.parse(bundled.stdout), config)));
const summary: unknown[] = [];
for (const mode of ["comments-only", "interrupted", "long-heartbeat"] as const) {
  let requests = 0, starts = 0, heartbeats = 0, maxGapMs = 0;
  let lastFrameAt = Date.now();
  const worker = ChatGptBrowserWorker.forProvider(providerConfig(config));
  const original = worker.run;
  worker.run = async turn => {
    starts++;
    await turn.onSendActivated?.();
    turn.onSubmitted?.();
    await Bun.sleep(mode === "long-heartbeat" ? holdMs : 16000);
    turn.onTextDelta("STREAMOK");
    return "STREAMOK";
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/responses") return new Response("Not found", { status: 404 });
    const number = ++requests;
    if (mode === "comments-only") {
      await request.json();
      let timer: ReturnType<typeof setInterval>;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { timer = setInterval(() => controller.enqueue(new TextEncoder().encode(": keepalive\n\n")), 1000); },
        cancel() { clearInterval(timer); },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    const response = await responseRequest(request, config, undefined, { rememberState: false });
    const reader = response.body!.getReader();
    let dropped = false;
    let dropTimer: ReturnType<typeof setTimeout> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (mode === "interrupted" && number === 1) dropTimer = setTimeout(() => {
          dropped = true; controller.close(); void reader.cancel();
        }, 7000);
      },
      async pull(controller) {
        const next = await reader.read();
        if (dropped) return;
        if (next.done) { if (dropTimer) clearTimeout(dropTimer); controller.close(); return; }
        const now = Date.now();
        maxGapMs = Math.max(maxGapMs, now - lastFrameAt); lastFrameAt = now;
        if (new TextDecoder().decode(next.value).includes("response.heartbeat")) heartbeats++;
        controller.enqueue(next.value);
      },
      cancel() { if (dropTimer) clearTimeout(dropTimer); return reader.cancel(); },
    });
    return new Response(stream, { status: response.status, headers: response.headers });
  } });
  const directory = join(root, mode);
  mkdirSync(directory);
  writeFileSync(join(directory, "config.toml"), [
    'model = "chatgpt-web/light"', 'model_provider = "local-liveness"',
    `model_catalog_json = ${JSON.stringify(join(root, "models.json"))}`,
    '[model_providers.local-liveness]', 'name = "Local liveness probe"',
    `base_url = "http://127.0.0.1:${server.port}/v1"`, 'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"', 'supports_websockets = false',
    'stream_idle_timeout_ms = 5000', `stream_max_retries = ${mode === "comments-only" ? 0 : 5}`, '',
  ].join("\n"));
  const started = Date.now();
  const child = Bun.spawn([codex, "exec", "--ephemeral", "--skip-git-repo-check", "--json", "--sandbox", "read-only", "Return STREAMOK without tools."], {
    cwd: directory, env: { ...process.env, CODEX_HOME: directory, OPENAI_API_KEY: "local-liveness-only" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  console.log(JSON.stringify({ mode, root, pid: child.pid, holdMs, idleTimeoutMs: 5000 }));
  const timeout = setTimeout(() => child.kill(), mode === "long-heartbeat" ? holdMs + 30000 : 40000);
  const progress = setInterval(() => console.log(JSON.stringify({ mode, elapsedMs: Date.now() - started, requests, starts, heartbeats })), 30000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    writeFileSync(join(directory, "stdout.jsonl"), stdout); writeFileSync(join(directory, "stderr.log"), stderr);
    const result = { mode, exitCode, durationMs: Date.now() - started, requests, starts, heartbeats, maxGapMs,
      completed: stdout.includes('"type":"turn.completed"'),
      reconnects: stdout.split("\n").filter(line => line.includes("Reconnecting")),
      finalMarker: stdout.includes('"text":"STREAMOK"'),
    };
    writeFileSync(join(directory, "result.json"), JSON.stringify(result, null, 2)); summary.push(result); console.log(JSON.stringify(result));
    if (mode === "comments-only") {
      if (exitCode === 0 || result.durationMs > 15000 || !stdout.includes("idle timeout")) throw new Error("Control did not prove native SSE idle timeout");
    } else if (exitCode !== 0 || !result.completed || !result.finalMarker || starts !== 1
      || (mode === "interrupted" ? requests !== 2 : requests !== 1)) throw new Error(`Liveness failed: ${mode}`);
  } finally {
    clearTimeout(timeout); clearInterval(progress); await server.stop(true);
    worker.run = original; chatGptTurnSessions.clear();
  }
}
writeFileSync(join(root, "result.json"), JSON.stringify(summary, null, 2));
console.log(`NATIVE_STREAM_LIVENESS_OK ${root}`);
