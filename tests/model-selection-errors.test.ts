import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { ChatGptWebAdapterError, chatGptModelSelectionError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { normalizeChatGptModelSelectionError, selectExplicitWebFamily } from "../src/adapters/chatgpt-web/browser-customizations";
import { CHATGPT_WEB_MODEL_ID, type ChatGptWebCapabilities } from "../src/adapters/chatgpt-web/model";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import type { AdapterEvent } from "../src/types";
import { httpStatusFromTerminalError } from "../src/lib/errors";
import { defaultChromeExecutable, defaultConfig, providerConfig } from "../src/config";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { responseRequest } from "../src/server";

const capabilities: ChatGptWebCapabilities = {
  localToolsEnabled: false, solAvailable: true, extraHighAvailable: true,
  proAvailable: true, browserModelFamily: "sol",
};

test("terminal HTTP classification does not reinterpret model-selection diagnostics as overload", () => {
  for (const code of ["chatgpt_model_selection_failed", "chatgpt_effort_unavailable"] as const) {
    const failure = chatGptModelSelectionError("stage=family-control; family=sol; control is unavailable", undefined, code);
    expect(httpStatusFromTerminalError({ type: failure.errorType, code: failure.code, message: failure.message })).toBe(502);
  }
  expect(httpStatusFromTerminalError({ type: "server_error", code: "server_is_overloaded" })).toBe(503);
  expect(httpStatusFromTerminalError({ type: "rate_limit_error", code: "rate_limit_exceeded" })).toBe(429);
});

test.each(["stuck-slider", "effort-unavailable", "rate-limit", "family-missing"] as const)(
  "real DOM selection failure remains distinct: %s", async scenario => {
  const browser = await chromium.launch({
    executablePath: process.env.LOCAL_REVIEW_CHROME || defaultChromeExecutable(),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    // The family is selected successfully. The effort slider deliberately ignores arrow keys.
    await page.setContent(`<form><div id="prompt-textarea" contenteditable="true">prompt</div>
      <button type="button" aria-haspopup="menu" data-tone="neutral" aria-expanded="true" aria-controls="menu">Effort</button></form>
      <div id="menu" role="menu"><div data-testid="composer-intelligence-picker-content">
        <div data-model-selection-view><button role="menuitem" aria-expanded="false">Family</button></div>
        <div data-testid="composer-model-picker-slider-advanced-view">
          <button role="menuitemradio" aria-checked="true">GPT-5.6 Sol</button>
        </div>
        <div data-model-reasoning-effort-slider>${Array.from({ length: scenario === "effort-unavailable" ? 4 : 5 }, () => '<span data-locked="false" data-selected="false"></span>').join("")}<div role="menuitem" tabindex="0">
          <span role="slider" aria-valuemin="0" aria-valuemax="${scenario === "effort-unavailable" ? 3 : 4}" aria-valuenow="0">Effort</span>
        </div></div>
      </div></div>${scenario === "rate-limit" ? '<div role="dialog">Too many requests. You are making requests too quickly.</div>' : ""}`);
    const worker = ChatGptBrowserWorker.forProvider({
      adapter: "chatgpt-web", baseUrl: "browser://model-selection-error-regression",
      chatgptWeb: capabilities,
    }) as unknown as {
      selectModelAndEffort(page: Page, model: string, effort: string, capabilities: ChatGptWebCapabilities): Promise<unknown>;
    };
    if (scenario === "family-missing") {
      await page.setContent('<div id="menu"><div id="slider">Effort</div></div>');
      await expect(selectExplicitWebFamily(page, {
        menu: page.locator("#menu"), sliderContainer: page.locator("#slider"),
      }, "sol")).rejects.toMatchObject({ status: 502, code: "chatgpt_model_selection_failed", retryable: false });
      return;
    }
    const failure = await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, "max", capabilities)
      .then(() => { throw new Error(`The ${scenario} selection unexpectedly succeeded`); }, error => error);
    expect(failure).toBeInstanceOf(ChatGptWebAdapterError);
    if (scenario === "rate-limit") {
      expect(failure).toMatchObject({ status: 429, code: "rate_limit_exceeded", retryable: false });
      return;
    }
    if (scenario === "effort-unavailable") {
      expect(failure).toMatchObject({ status: 502, code: "chatgpt_effort_unavailable", retryable: false });
      expect(failure.message).not.toContain("reached its usage limit");
      return;
    }
    expect(failure).toMatchObject({ status: 502, code: "chatgpt_model_selection_failed", retryable: false });
    expect(failure.message).toContain("family=sol");
    expect(failure.message).toContain("effort=max");
    expect(failure.message).toContain("before=0; after=0");
    const event: AdapterEvent = {
      type: "error", message: failure.message, status: failure.status,
      errorType: failure.errorType, code: failure.code, retryable: failure.retryable,
    };
    expect(buildResponseJSON([event], CHATGPT_WEB_MODEL_ID)).toMatchObject({
      status: "failed", retryable: false, error: { code: "chatgpt_model_selection_failed" },
    });
    for (const streamPlatform of ["win32", "darwin"] as const) {
      const events = async function* () { yield event; };
      const stream = bridgeToResponsesSSE(events(), CHATGPT_WEB_MODEL_ID,
        undefined, undefined, undefined, undefined, 2_000, { streamPlatform });
      const text = await new Response(stream).text();
      expect(text).toContain("event: response.failed");
      expect(text).toContain('"code":"chatgpt_model_selection_failed"');
      expect(text).not.toContain("server_is_overloaded");
      expect(text).not.toContain("response.completed");
    }
  } finally {
    await browser.close();
  }
}, 30_000);

test("missing requested radio becomes a terminal selection error and HTTP reconnect never restarts the worker", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.LOCAL_REVIEW_CHROME || defaultChromeExecutable(), headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="menu"><div data-testid="composer-intelligence-picker-content">
      <div data-model-selection-view><button role="menuitem" aria-expanded="true">Family</button></div>
      <div data-testid="composer-model-picker-slider-advanced-view"></div>
      <div id="slider">Effort</div></div></div>`);
    const failure = await selectExplicitWebFamily(page, {
      menu: page.locator("#menu"), sliderContainer: page.locator("#slider"),
    }, "sol").then(() => { throw new Error("Unexpected selection success"); }, error => error);
    expect(failure).toBeInstanceOf(ChatGptWebAdapterError);
    expect(failure).toMatchObject({ status: 502, code: "chatgpt_model_selection_failed", retryable: false });
    expect(failure.message).toContain("stage=family-choice");
    expect(failure.cause.name).toBe("TimeoutError");
    expect(failure.message).not.toContain("locator.waitFor");
    const config = defaultConfig("browser-only");
    config.proAvailable = true;
    const worker = ChatGptBrowserWorker.forProvider(providerConfig(config));
    const original = worker.run;
    let starts = 0;
    worker.run = async () => { starts++; throw failure; };
    const id = crypto.randomUUID();
    const body = { model: "chatgpt-web/light", stream: true,
      client_metadata: { "x-codex-turn-metadata": { thread_id: id, turn_id: id } },
      input: [{ type: "message", role: "user", content: "Synthetic model selection test",
        internal_chat_message_metadata_passthrough: { turn_id: id } }] };
    try {
      const responses: Response[] = [];
      const texts: string[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        }), config);
        responses.push(response);
        texts.push(await response.text());
      }
      expect(starts).toBe(1);
      expect(texts[0]).toContain('"code":"chatgpt_model_selection_failed"');
      expect(texts[0]).toContain("response.failed");
      expect(responses[1]!.status).toBe(400);
      expect(texts[1]).toContain("chatgpt_model_selection_failed");
    } finally { worker.run = original; chatGptTurnSessions.clear(); }
  } finally { await browser.close(); }
}, 20_000);

test("selection normalization preserves typed rate-limit, auth, ownership, and cancellation errors", () => {
  const context = { stage: "effort-focus", family: "sol", effort: "max" };
  for (const [status, code] of [[429, "rate_limit_exceeded"], [401, "chatgpt_session_expired"],
    [409, "chatgpt_turn_identity_conflict"], [499, "client_cancelled"]] as const) {
    const failure = new ChatGptWebAdapterError("typed failure", { status, code, errorType: "server_error", retryable: false });
    expect(normalizeChatGptModelSelectionError(failure, context)).toBe(failure);
  }
  const abort = new DOMException("operator cancelled", "AbortError");
  expect(normalizeChatGptModelSelectionError(abort, context)).toBe(abort);
});

test.each(["selection", "preflight"] as const)("%s covers raw initial composer failures at the operation boundary", async operation => {
  const cause = new Error("raw browser text must stay in the local cause");
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async () => { throw cause; },
  }) as {
    selectModelAndEffort(page: Page, model: string, effort: string, capabilities: ChatGptWebCapabilities): Promise<unknown>;
    assertSelectedEffort(page: Page, mode: unknown): Promise<void>;
  };
  const page = {} as Page;
  const pending = operation === "selection"
    ? worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, "max", capabilities)
    : worker.assertSelectedEffort(page, { effort: "max", selection: { browserFamily: "sol", url: "about:blank", label: "Pro" } });
  const failure = await pending.then(() => null, error => error);
  expect(failure).toMatchObject({ code: "chatgpt_model_selection_failed", retryable: false, cause });
  expect(failure.message).toContain(`stage=${operation === "selection" ? "composer" : "preflight-surface"}`);
  expect(failure.message).not.toContain(cause.message);
});
