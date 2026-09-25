import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { requestLimitError } from "../src/adapters/chatgpt-web/request-limits";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

test.each([false, true])("six-part recovery preserves ACKs and never replays an activated Send (activated=%s)", async activated => {
  const root = mkdtempSync(join(tmpdir(), "multipart-rate-recovery-"));
  let retryAt = 0;
  let reports = 0;
  const states: string[] = [];
  // Local protocol fixture only: no ChatGPT requests, browser clicks or production tasks.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    const route = new URL(request.url).pathname;
    if (route === "/v1/traffic/report") {
      reports++;
      retryAt = Date.now() + 10;
      return Response.json({ ok: true, retryAt });
    }
    if (route === "/v1/traffic/acquire") return Response.json(Date.now() < retryAt
      ? { ok: true, granted: false, retryAt, reason: "rate-limit" }
      : { ok: true, granted: true });
    if (body.workStage) states.push(String(body.workStage));
    return Response.json({ ok: true });
  } });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production", pid: process.pid, endpoint: `http://127.0.0.1:${server.port}`,
    control: { endpoint: `http://127.0.0.1:${server.port}`, token: "fixture-private-control-token-0123456789abcdef" },
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB", createdAt: new Date().toISOString(),
    surfaceTargets: { launcher_surface_id_0123456789AB: "fixture-owned-target" },
  }), { mode: 0o600 });
  const rateError = requestLimitError({ id: "fixture-ui-limit", source: "dialog", category: "unknown" });
  const reachedResponse = new Error("fixture reached final response without replay");
  let stage = "";
  let rejected = false;
  let released = false;
  const sends: string[] = [];
  const acknowledgements: number[] = [];
  const progress: string[] = [];
  const frame = {};
  const page = Object.assign(new EventEmitter(), { evaluate: async () => ({}), isClosed: () => false, mainFrame: () => frame });
  const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "launcher", browserHostDescriptorPath: descriptorPath, appName: "Codex Native2", browserDiagnosticsPath: root },
    runStage: async (_trace: string, name: string, _timeout: number, action: (signal: AbortSignal) => Promise<unknown>) => {
      stage = name;
      if (!activated && !rejected && name === "multipart_stage_3_attachment") { rejected = true; throw rateError; }
      return action(new AbortController().signal);
    },
    prepareChatSurface: async () => {},
    selectModelAndEffort: async (_page: unknown, model: string, effort: string) => resolveChatGptWebModelMode(model, effort, capabilities),
    captureSubmissionBaseline: async () => ({}),
    attachPrompt: async () => {}, attachPromptWithCompactionRetry: async () => {}, attachFiles: async () => {},
    sendAttachedPrompt: async (...args: unknown[]) => {
      const lifecycle = args[5] as Pick<BrowserTurn, "onSendActivated" | "onSubmitted">;
      await lifecycle.onSendActivated?.();
      sends.push(stage);
      if (activated && stage === "multipart_stage_3_send") throw rateError;
      await lifecycle.onSubmitted?.();
      return "user_turn";
    },
    assertSelectedEffort: async () => {},
    waitForNewAssistantTurn: async () => { if (stage === "send") throw reachedResponse; return {}; },
    waitForMultipartAcknowledgement: async () => {},
  });
  try {
    await expect(worker.runBrowserTurn({
      traceId: "multipart_rate_fixture", modelId: "gpt-5.6-sol", modelFamily: "5.6", reasoning: "high", capabilities,
      onTextDelta() {}, onPreparationProgress: (name: string) => { progress.push(name); },
      onMultipartStageAcknowledged: (part: number) => { acknowledgements.push(part); },
      prepare: async () => ({ text: "Final fixture prompt", images: [],
        multipart: { parts: Array.from({ length: 6 }, (_, i) => JSON.stringify({ part: i + 1 })), commit: "Finish" },
        release: () => { released = true; } }),
    }, "fixture-owned-surface", page)).rejects.toBe(activated ? rateError : reachedResponse);
    expect(sends).toEqual(activated
      ? ["multipart_stage_1_send", "multipart_stage_2_send", "multipart_stage_3_send"]
      : ["multipart_stage_1_send", "multipart_stage_2_send", "multipart_stage_3_send", "multipart_stage_4_send", "multipart_stage_5_send", "send"]);
    expect(acknowledgements).toEqual(activated ? [1, 2] : [1, 2, 3, 4, 5]);
    expect(reports).toBe(activated ? 0 : 1);
    if (!activated) { expect(progress).toContain("request_wait"); expect(states).toContain("waiting"); }
    expect(released).toBe(true);
    expect(page.listenerCount("request")).toBe(0);
    expect(page.listenerCount("response")).toBe(0);
  } finally { await server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
