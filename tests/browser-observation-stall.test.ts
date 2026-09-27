import { expect, test } from "bun:test";
import { ChatGptBrowserWorker, ChatGptBrowserObservationTimeoutError, ChatGptCompletionTracker,
  ChatGptCompletionRevealTracker, ChatGptTurnDomHealthTracker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";

test("an unresponsive alert read rebinds before releasing the pending tool boundary", async () => {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  const hidden = { filter() { return this; }, last() { return this; }, isVisible: async () => false };
  const stalled = { ...hidden, isVisible: () => new Promise(() => {}) };
  const oldPage = { isClosed: () => false, locator: () => stalled };
  const answer = {};
  const newPage = { isClosed: () => false, locator: (selector: string) => selector.startsWith('[data-turn-id=') ? answer : hidden };
  const baseline = { initialTurnIdentities: [], initialUserAnchors: [], domCache: {} };
  const progress = new ChatGptExternalTurnProgress();
  const revision = progress.recordToolBatch(1);
  let observed = false, recovery = 0;
  const waiting = progress.waitForToolBatchObservation(revision).then(() => { observed = true; });
  worker.submissionDomState = async (page: unknown) => {
    expect(page).toBe(newPage);
    return { turnIdentities: ['user', 'assistant'], userIdentities: ['user'], responseIdentities: ['assistant'] };
  };
  worker.responseDomSnapshot = async () => {
    expect(observed).toBeFalse();
    return { visibleText: 'Before the tool' };
  };
  const result = await worker.waitForNewAssistantTurn(oldPage, baseline, Date.now() + 10_000,
    undefined, progress, 60_000, new ChatGptCompletionTracker(), async (attempt: number, error: unknown) => {
      expect(observed).toBeFalse();
      expect(error).toBeInstanceOf(ChatGptBrowserObservationTimeoutError);
      recovery++;
      return { page: newPage, baseline, lastAttempt: attempt };
    });
  await waiting;
  expect(recovery).toBe(1);
  expect(result.identity).toBe('assistant');
  expect(observed).toBeTrue();
}, 12_000);

test("a CDP evaluation that never responds has a host-side deadline", async () => {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  const response = { evaluate: () => new Promise(() => {}), page: () => ({ isClosed: () => false }) };
  await expect(worker.responseDomSnapshot(response, {})).rejects.toBeInstanceOf(ChatGptBrowserObservationTimeoutError);
}, 8_000);

test("footer reveal is bounded and never substitutes for terminal DOM evidence", () => {
  const reveal = new ChatGptCompletionRevealTracker();
  const complete = new ChatGptCompletionTracker(0);
  const health = new ChatGptTurnDomHealthTracker(60_000, 10_000, 60_000);
  const state = { responsePresent: true, running: false, currentText: 'Final answer',
    completionActionVisible: false, externalToolCallsInFlight: false };
  expect(reveal.shouldReveal(state, 0)).toBeFalse();
  expect(reveal.shouldReveal(state, 5_000)).toBeTrue();
  expect(reveal.shouldReveal(state, 60_000)).toBeFalse();
  expect(complete.update(state, 5_000)).toBeFalse();
  expect(health.update(state, 0)).toBeUndefined();
  expect(health.update(state, 60_000)).toContain('completed-turn action');
  expect(complete.update({ ...state, completionActionVisible: true }, 60_001)).toBeFalse();
  expect(complete.update({ ...state, completionActionVisible: true }, 60_002)).toBeTrue();
});

test("footer reveal waits for generation and tools, and ignores missing/empty/already-complete responses", () => {
  const state = { responsePresent: true, running: false, currentText: 'Final answer',
    completionActionVisible: false, externalToolCallsInFlight: false };
  for (const blocked of [{ running: true }, { externalToolCallsInFlight: true },
    { responsePresent: false }, { currentText: '' }, { completionActionVisible: true }]) {
    const reveal = new ChatGptCompletionRevealTracker();
    expect(reveal.shouldReveal(state, 0)).toBeFalse();
    expect(reveal.shouldReveal({ ...state, ...blocked }, 10_000)).toBeFalse();
    expect(reveal.shouldReveal(state, 10_001)).toBeFalse();
    expect(reveal.shouldReveal(state, 15_001)).toBeTrue();
  }
});
