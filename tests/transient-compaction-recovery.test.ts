import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError, chatGptStoppedThinkingError } from "../src/adapters/chatgpt-web/adapter-error";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { isTransientSummaryFailure, recoveryDelay } from "../src/adapters/chatgpt-web/transient-recovery";
import { defaultBrokerEndpoint } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexProviderConfig } from "../src/types";

for (const scenario of ["upstream", "browser-page", "exhausted", "quota", "stopped"] as const) {
  test(`summary-only recovery shares the physical owner and preserves its budget: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-transient-summary-"));
    const id = randomUUID();
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web", baseUrl: `browser://summary-recovery-${id}`,
      chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: join(root, "launcher.json"),
        brokerSocketPath: defaultBrokerEndpoint(root), localToolsEnabled: true, solAvailable: true, proAvailable: true },
    };
    const parsed = parseRequest({ model: "gpt-5.6-sol", stream: true, reasoning: { effort: "max" },
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: id, turn_id: id }) },
      input: [{ type: "message", role: "user", content: "Saved changes exist. Summarize the unfinished task.",
        internal_chat_message_metadata_passthrough: { turn_id: id } }],
    });
    parsed._compactionRequest = true;
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const original = worker.run;
    const failure = scenario === "browser-page" ? new Error("ChatGPT browser stage timed out: browser_page")
      : scenario === "quota" ? new ChatGptWebAdapterError("quota", { status: 429, errorType: "rate_limit_error", code: "usage_limit_reached", retryable: false })
      : scenario === "stopped" ? chatGptStoppedThinkingError()
      : new ChatGptWebAdapterError("Something went wrong", { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true });
    let starts = 0;
    let active = 0;
    let maxActive = 0;
    worker.run = async turn => {
      starts++;
      maxActive = Math.max(maxActive, ++active);
      try {
        expect(turn.compaction).toBeTrue();
        expect(turn.capabilities.localToolsEnabled).toBeFalse();
        expect(turn.modelId).toBe("gpt-5.6-sol");
        expect(turn.reasoning).toBe("max");
        const prepared = await turn.prepare();
        expect(prepared.text).toContain("Saved changes exist");
        prepared.release();
        turn.onSubmitted?.();
        if (starts === 1 || ["exhausted", "quota", "stopped"].includes(scenario)) throw failure;
        return "Saved changes exist; continue verification.";
      } finally { active--; }
    };
    const run = async () => {
      const events: AdapterEvent[] = [];
      await createChatGptWebAdapter(provider).runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
      return events;
    };
    try {
      const events = await Promise.all([run(), run()]);
      const repeated = await run();
      const recovered = scenario === "upstream" || scenario === "browser-page";
      for (const result of [...events, repeated]) {
        expect(result.at(-1)).toMatchObject(recovered ? { type: "done", endTurn: true } : { type: "error", retryable: false });
        if (recovered) expect(result.some(event => event.type === "error")).toBeFalse();
      }
      expect(starts).toBe(recovered ? 2 : scenario === "exhausted" ? 3 : 1);
      expect(maxActive).toBe(1);
    } finally { worker.run = original; rmSync(root, { recursive: true, force: true }); }
  }, 10_000);
}

test("summary recovery does not classify unknown errors or user cancellation as transient", async () => {
  expect(isTransientSummaryFailure(new DOMException("cancelled", "AbortError"))).toBeFalse();
  expect(isTransientSummaryFailure(new Error("invalid ownership"))).toBeFalse();
  const controller = new AbortController();
  const delay = recoveryDelay(2, controller.signal);
  controller.abort();
  await expect(delay).rejects.toMatchObject({ name: "AbortError" });
});
