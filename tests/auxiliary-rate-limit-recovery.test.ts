import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Page, Request } from "playwright-core";
import { ChatGptBrowserWorker, throwIfChatGptRateLimitDialog, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

test.each(["auxiliary-live", "auxiliary-unconfirmed", "unknown", "generation-rejected"])(
  "multipart part 3 preserves ACKs and never resends an accepted part after a dialog: %s", async scenario => {
    const root = mkdtempSync(join(tmpdir(), "auxiliary-429-fixture-"));
    const reports: Array<{ category: string; source: string }> = [];
    let retryAt = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const body = await request.json() as { evidence?: { category: string; source: string } };
      const route = new URL(request.url).pathname;
      if (route === "/v1/traffic/report") {
        reports.push(body.evidence!); retryAt = Date.now() + 10;
        return Response.json({ ok: true, retryAt });
      }
      if (route === "/v1/traffic/acquire") return Response.json(Date.now() < retryAt
        ? { ok: true, granted: false, retryAt, reason: "rate-limit" } : { ok: true, granted: true });
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
    }));
    let stage = "";
    let modal = false;
    let released = false;
    const sends: string[] = [];
    const acknowledgements: number[] = [];
    const reachedResponse = new Error("fixture reached final response");
    const dialog = {
      filter: () => dialog, last: () => dialog, isVisible: async () => modal,
      waitFor: async () => { if (modal) throw new Error("fixture dialog still visible"); },
      getByRole: () => ({ last: () => ({ isVisible: async () => true, press: async () => { modal = false; } }) }),
    };
    const frame = {};
    const page = Object.assign(new EventEmitter(), {
      evaluate: async () => ({}), isClosed: () => false, mainFrame: () => frame,
      locator: () => dialog,
    });
    const emit = (pathname: string, method: string, status: number) => {
      const req = { frame: () => frame, method: () => method, url: () => `https://chatgpt.com${pathname}` } as Request;
      page.emit("request", req);
      page.emit("response", { request: () => req, status: () => status, headers: () => ({}) });
    };
    const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: { browserHost: "launcher", browserHostDescriptorPath: descriptorPath, appName: "Codex Native2", browserDiagnosticsPath: root },
      runStage: async (_trace: string, name: string, _timeout: number, action: (signal: AbortSignal) => Promise<unknown>) => {
        stage = name; return action(new AbortController().signal);
      },
      prepareChatSurface: async () => {},
      selectModelAndEffort: async (_page: unknown, model: string, effort: string) => resolveChatGptWebModelMode(model, effort, capabilities),
      captureSubmissionBaseline: async () => ({}),
      attachPrompt: async () => {}, attachPromptWithCompactionRetry: async () => {}, attachFiles: async () => {},
      sendAttachedPrompt: async (...args: unknown[]) => {
        const lifecycle = args[5] as Pick<BrowserTurn, "onSendActivated" | "onSubmitted">;
        await lifecycle.onSendActivated?.(); sends.push(stage);
        emit("/backend-api/f/conversation", "POST", 200);
        await lifecycle.onSubmitted?.();
        return "user_turn";
      },
      assertSelectedEffort: async () => {},
      waitForNewAssistantTurn: async () => { if (stage === "send") throw reachedResponse; return {}; },
      waitForMultipartAcknowledgement: async () => {
        if (stage !== "multipart_stage_3_acknowledgement") return;
        if (scenario !== "unknown") emit("/backend-api/conversation/fixture", "GET", 429);
        if (scenario === "generation-rejected") emit("/backend-api/f/conversation", "POST", 429);
        modal = true;
        await throwIfChatGptRateLimitDialog(page as unknown as Page, async () => scenario !== "auxiliary-unconfirmed");
      },
    });
    try {
      const error = await worker.runBrowserTurn({ traceId: "auxiliary_rate_fixture", modelId: "gpt-5.6-sol", modelFamily: "5.6",
        reasoning: "high", capabilities, onTextDelta() {},
        onMultipartStageAcknowledged: (part: number) => { acknowledgements.push(part); },
        prepare: async () => ({ text: "Final fixture prompt", images: [],
          multipart: { parts: Array.from({ length: 6 }, (_, i) => JSON.stringify({ part: i + 1 })), commit: "Finish" },
          release: () => { released = true; } }),
      }, "fixture-owned-surface", page).then(() => null, (error: unknown) => error);
      const continued = scenario === "auxiliary-live";
      if (continued) expect(error).toBe(reachedResponse);
      else expect(error).toMatchObject({ code: "rate_limit_exceeded", retryable: false,
        requestLimit: { category: scenario === "generation-rejected" ? "generation" : "unknown" } });
      expect(sends).toEqual(continued
        ? ["multipart_stage_1_send", "multipart_stage_2_send", "multipart_stage_3_send", "multipart_stage_4_send", "multipart_stage_5_send", "send"]
        : ["multipart_stage_1_send", "multipart_stage_2_send", "multipart_stage_3_send"]);
      expect(acknowledgements).toEqual(continued ? [1, 2, 3, 4, 5] : [1, 2]);
      if (continued) expect(reports.map(({ category, source }) => ({ category, source })))
        .toEqual([{ category: "conversation", source: "http" }, { category: "unknown", source: "dialog" }]);
      expect(released).toBe(true);
      expect(page.listenerCount("request")).toBe(0);
      expect(page.listenerCount("response")).toBe(0);
    } finally { await server.stop(true); rmSync(root, { recursive: true, force: true }); }
  },
);
