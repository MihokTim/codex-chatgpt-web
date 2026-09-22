import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { ChatGptWebAdapterError, chatGptModelSelectionError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { selectExplicitWebFamily } from "../src/adapters/chatgpt-web/browser-customizations";
import { CHATGPT_WEB_MODEL_ID, type ChatGptWebCapabilities } from "../src/adapters/chatgpt-web/model";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import type { AdapterEvent } from "../src/types";
import { httpStatusFromTerminalError } from "../src/lib/errors";

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
    executablePath: process.env.LOCAL_REVIEW_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe",
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
        <div data-model-reasoning-effort-slider><div role="menuitem" tabindex="0">
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
