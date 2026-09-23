import { expect, test } from "bun:test";
import { ChatGptWebAdapterError, chatGptModelSelectionError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { normalizeChatGptModelSelectionError } from "../src/adapters/chatgpt-web/browser-model-controls";
import { httpStatusFromTerminalError } from "../src/lib/errors";

test("model selection diagnostics remain distinct from overload and rate limits", () => {
  for (const code of ["chatgpt_model_selection_failed", "chatgpt_effort_unavailable"] as const) {
    const failure = chatGptModelSelectionError("stage=family-control; control is unavailable", undefined, code);
    expect(httpStatusFromTerminalError({ type: failure.errorType, code: failure.code, message: failure.message })).toBe(502);
  }
  expect(httpStatusFromTerminalError({ type: "server_error", code: "server_is_overloaded" })).toBe(503);
});

test("selection normalization preserves authentication, ownership, rate-limit and cancellation errors", () => {
  const context = { stage: "effort-focus", family: "5.6", effort: "max" };
  for (const [status, code] of [[429, "rate_limit_exceeded"], [401, "chatgpt_session_expired"],
    [409, "chatgpt_turn_identity_conflict"], [499, "client_cancelled"]] as const) {
    const failure = new ChatGptWebAdapterError("typed failure", { status, code, errorType: "server_error", retryable: false });
    expect(normalizeChatGptModelSelectionError(failure, context)).toBe(failure);
  }
  const abort = new DOMException("operator cancelled", "AbortError");
  expect(normalizeChatGptModelSelectionError(abort, context)).toBe(abort);
});

test.each(["selection", "preflight"])("%s classifies initial composer failures without exporting raw browser text", async operation => {
  const cause = new Error("raw browser text must stay in the local cause");
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { activeComposer: async () => { throw cause; } });
  const failure = await (operation === "selection"
    ? worker.selectModelAndEffort({}, "gpt-5.6-sol", "max", { solAvailable: true, proAvailable: true, extraHighAvailable: true })
    : worker.assertSelectedEffort({}, { effort: "max", selection: { url: "about:blank", label: "Pro" } }))
    .then(() => null, (error: unknown) => error);
  expect(failure).toMatchObject({ code: "chatgpt_model_selection_failed", retryable: false, cause });
  expect(failure.message).not.toContain(cause.message);
});
