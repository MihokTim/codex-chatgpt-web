import { expect, test } from "bun:test";
import { browserViewportUnavailable, recoverOwnedBrowserPage } from "../src/adapters/chatgpt-web/browser-observation-recovery";
import { ChatGptBrowserObservationTimeoutError, ChatGptBrowserWorker, connectAfterClosingBrowserConnection } from "../src/adapters/chatgpt-web/browser-worker";
import type { Page } from "playwright-core";

test("a first rebind viewport failure closes its transport before the second owned attachment", async () => {
  const order: string[] = [];
  let connection = { close: async () => { order.push("close-old"); } };
  const page = {};
  const result = await recoverOwnedBrowserPage(1, 2, attempt => connectAfterClosingBrowserConnection(connection, async () => {
    order.push(`attach-${attempt}`);
    connection = { close: async () => { order.push(`close-${attempt}`); } };
    if (attempt === 1) throw browserViewportUnavailable(new Error("renderer timeout"));
    return page;
  }));
  expect(result).toEqual({ value: page, lastAttempt: 2 });
  expect(order).toEqual(["close-old", "attach-1", "close-1", "attach-2"]);
});

test("persistent viewport loss uses the remaining budget and preserves an explicit terminal cause", async () => {
  for (const start of [1, 2]) {
    const attempts: number[] = [];
    const error = browserViewportUnavailable(new Error("renderer timeout"));
    await expect(recoverOwnedBrowserPage(start, 2, async attempt => { attempts.push(attempt); throw error; }))
      .rejects.toBe(error);
    expect(attempts).toEqual(start === 1 ? [1, 2] : [2]);
    expect(error).toMatchObject({ code: "chatgpt_browser_viewport_unavailable", retryable: false });
  }
});

test("operator cancellation and ownership errors never open another attachment", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController(); let attempts = 0;
    const failure = new Error(cancel ? "cancelled" : "ownership mismatch");
    await expect(recoverOwnedBrowserPage(1, 2, async () => {
      attempts++;
      if (cancel) { controller.abort(failure); throw browserViewportUnavailable(failure); }
      throw failure;
    }, controller.signal)).rejects.toBe(failure);
    expect(attempts).toBe(1);
  }
});

type Baseline = { initialTurnIdentities: string[]; domCache: Record<string, unknown> };
type State = { turnIdentities: string[]; userIdentities: string[]; responseIdentities: string[] };
type Recovery = (attempt: number) => Promise<{ page: Page; baseline: Baseline; lastAttempt: number }>;
type Observer = {
  submissionDomState(): Promise<State>;
  waitForSubmissionAccepted(): Promise<string>;
  waitForTurnDomOrExternalProgress(): Promise<void>;
  waitForNewAssistantTurn(page: Page, baseline: Baseline, deadline: number, signal?: AbortSignal,
    progress?: undefined, grace?: undefined, tracker?: undefined, recover?: Recovery): Promise<{ identity: string }>;
  waitForSubmissionAcceptedWithRecovery(page: Page, baseline: Baseline, signal?: AbortSignal,
    progress?: undefined, revision?: undefined, tracker?: undefined, recover?: Recovery): Promise<string>;
};

function observationFixture() {
  const hidden = { filter() { return this; }, last() { return this; }, isVisible: async () => false };
  const page = { isClosed: () => false, locator: () => hidden } as unknown as Page;
  const baseline: Baseline = { initialTurnIdentities: [], domCache: {} };
  const worker = Object.create(ChatGptBrowserWorker.prototype) as Observer;
  const timeout = async (): Promise<never> => { throw new ChatGptBrowserObservationTimeoutError(1); };
  worker.submissionDomState = timeout;
  worker.waitForSubmissionAccepted = timeout;
  worker.waitForTurnDomOrExternalProgress = async () => {};
  const attempts: number[] = [];
  const recover: Recovery = async first => {
    const result = await recoverOwnedBrowserPage(first, 2, async attempt => {
      attempts.push(attempt);
      if (attempts.length === 1) throw browserViewportUnavailable(new Error("first viewport failed"));
      return page;
    });
    return { page: result.value, baseline, lastAttempt: result.lastAttempt };
  };
  return { page, baseline, worker, recover, attempts };
}

test.each(["assistant", "submission"] as const)(
  "%s DOM timeouts charge a failed viewport retry to the same two-connection budget", async phase => {
    const { page, baseline, worker, recover, attempts } = observationFixture();
    const pending = phase === "assistant"
      ? worker.waitForNewAssistantTurn(page, baseline, Date.now() + 5_000, undefined, undefined, undefined, undefined, recover)
      : worker.waitForSubmissionAcceptedWithRecovery(page, baseline, undefined, undefined, undefined, undefined, recover);
    await expect(pending).rejects.toThrow("after 2 same-page rebinds");
    expect(attempts).toEqual([1, 2]);
  },
);

test("a successful DOM observation resets the consumed connection budget", async () => {
  const { page, baseline, worker, recover, attempts } = observationFixture();
  let observations = 0;
  worker.submissionDomState = async () => {
    observations++;
    if (observations === 1 || observations === 3) throw new ChatGptBrowserObservationTimeoutError(1);
    return observations === 2
      ? { turnIdentities: [], userIdentities: [], responseIdentities: [] }
      : { turnIdentities: ["user", "answer"], userIdentities: ["user"], responseIdentities: ["answer"] };
  };
  const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 5_000,
    undefined, undefined, undefined, undefined, recover);
  expect(binding.identity).toBe("answer");
  expect(attempts).toEqual([1, 2, 1]);
});

test("an exhausted connection budget never opens another transport", async () => {
  let connections = 0;
  await expect(recoverOwnedBrowserPage(3, 2, async () => { connections++; }))
    .rejects.toThrow("budget is exhausted");
  expect(connections).toBe(0);
});
