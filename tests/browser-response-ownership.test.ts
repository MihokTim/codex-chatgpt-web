import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { ChatGptBrowserWorker, ChatGptCompletionTracker } from "../src/adapters/chatgpt-web/browser-worker";
import { defaultChromeExecutable } from "../src/config";

type Baseline = { initialTurnIdentities: string[]; submittedUserIdentity?: string; domCache: Record<string, unknown> };
type Binding = { identity: string; locator: Locator; userIdentity?: string; acceptedTurnIdentities: string[] };
type Observer = {
  captureSubmissionBaseline(page: Page): Promise<Baseline>;
  currentSubmissionEvidence(page: Page, baseline: Baseline): Promise<string | undefined>;
  currentSubmissionAnswerText(page: Page, baseline: Baseline): Promise<string>;
  waitForNewAssistantTurn(page: Page, baseline: Baseline, deadline: number,
    signal?: AbortSignal, progress?: undefined, graceMs?: number): Promise<Binding>;
  reconcileAssistantTurnBinding(page: Page, baseline: Baseline, binding: Binding): Promise<Binding>;
  responseDomSnapshot(locator: Locator, cache: unknown): Promise<{
    responsePresent: boolean; visibleText: string; fullHtml: string; completionActionVisible: boolean;
    stoppedThinkingVisible: boolean; failedThinkingVisible: boolean;
  }>;
};
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: defaultChromeExecutable(), headless: true }); });
afterAll(async () => { await browser?.close(); });

const section = (id: string, role: "user" | "assistant", text: string, mounted = true) =>
  `<div data-turn-id-container="${id}">${mounted ? `<section data-testid="conversation-turn-${id}" data-turn="${role}" data-turn-id="${id}"><div class="markdown">${text}</div>${role === "assistant" ? '<button data-testid="copy-turn-action-button">Copy</button>' : ""}</section>` : ""}</div>`;
const initial = section("prep-user", "user", "Preparation") + section("prep-answer", "assistant", "ACK");
const current = (ack: string, answer: string, mountUser = true) => section("prep-user", "user", "Preparation")
  + section(ack, "assistant", "ACK") + section("submitted-user", "user", "Actual request", mountUser)
  + section(answer, "assistant", "Actual final answer");
const render = (page: Page, html: string) => page.evaluate(value => { document.body.innerHTML = value; }, html);
const observer = () => Object.create(ChatGptBrowserWorker.prototype) as Observer;

const timeline = (key: string, message: string, answer: string, mounted = true) => `<div data-turn-key="${key}">
  ${mounted ? `<div data-chatgpt-search-unit-key="fallback:0:user" data-chatgpt-search-message-ids="${key}"><div data-user-message-bubble>${message}</div></div>` : ""}
  <span hidden data-chatgpt-agent-turn-start></span>
  <div data-chatgpt-search-unit-key="fallback:2:assistant" data-chatgpt-search-message-ids="changing-assistant-id">
    <div data-markdown-text-style="assistant-message"><p>${answer}</p></div>
  </div><button aria-label="コピーする"></button></div>`;

test("timeline ownership follows a new outer user key across remounts and virtualization", async () => {
  const page = await browser.newPage();
  try {
    const worker = observer();
    await render(page, timeline('old', 'Preparation', 'ACK'));
    const baseline = await worker.captureSubmissionBaseline(page);
    await render(page, timeline('old', 'Preparation', 'Changed historical answer'));
    expect(await worker.currentSubmissionEvidence(page, baseline)).toBeUndefined();
    await render(page, timeline('old', 'Preparation', 'ACK') + timeline('new', '<div class="markdown">思考に失敗しました</div>', 'Final answer'));
    expect(await worker.currentSubmissionEvidence(page, baseline)).toBe('user_turn');
    const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2_000);
    expect(binding.userIdentity).toBe('timeline-user:new');
    expect(binding.identity).toBe('timeline-assistant:new');
    const initialSnapshot = await worker.responseDomSnapshot(binding.locator, {});
    expect(initialSnapshot.visibleText).toBe('Final answer');
    expect(initialSnapshot.failedThinkingVisible).toBeFalse();
    await render(page, timeline('old', 'Preparation', 'Remounted ACK') + timeline('new', '', 'Final answer', false));
    expect(await worker.currentSubmissionAnswerText(page, baseline)).toBe('Final answer');
    const snapshot = await worker.responseDomSnapshot(binding.locator, {});
    expect(snapshot.completionActionVisible).toBeTrue();
    expect(snapshot.visibleText).toBe('Final answer');
    await page.locator('[data-turn-key="new"] button').evaluate(e => e.removeAttribute('aria-label'));
    expect((await worker.responseDomSnapshot(binding.locator, {})).completionActionVisible).toBeFalse();
    await render(page, timeline('old', 'Preparation', 'ACK') + timeline('new', 'Actual request', 'Final answer') + timeline('foreign', 'Another request', 'Wrong answer'));
    await expect(worker.currentSubmissionAnswerText(page, baseline)).rejects.toThrow('another user turn');
  } finally { await page.close(); }
});

test("timeline rejects duplicate keys and a user message that does not own its container", async () => {
  const page = await browser.newPage();
  try {
    const worker = observer();
    await render(page, timeline('same','one','A') + timeline('same','two','B'));
    await expect(worker.captureSubmissionBaseline(page)).rejects.toThrow('duplicate');
    await render(page, timeline('owner','one','A').replace('data-chatgpt-search-message-ids="owner"','data-chatgpt-search-message-ids="foreign"'));
    await expect(worker.captureSubmissionBaseline(page)).rejects.toThrow('matching message identity');
  } finally { await page.close(); }
});

test.each([false, true])("remounted historical users cannot prove a submission (extra exchange=%s)", async extra => {
  const page = await browser.newPage();
  try {
    const worker = observer();
    await render(page, initial);
    const baseline = await worker.captureSubmissionBaseline(page);
    await render(page, section("old-user-remounted", "user", "Preparation")
      + section("old-answer-remounted", "assistant", "ACK")
      + (extra ? section("another-user", "user", "Another request") + section("another-answer", "assistant", "Wrong answer") : ""));
    expect(await worker.currentSubmissionEvidence(page, baseline)).toBeUndefined();
    expect(await worker.currentSubmissionAnswerText(page, baseline)).toBe("");
    expect(baseline.submittedUserIdentity).toBeUndefined();
  } finally { await page.close(); }
});

test("identical user text is safe when it extends the proven conversation boundary", async () => {
  const page = await browser.newPage();
  try {
    const worker = observer();
    await render(page, initial);
    const baseline = await worker.captureSubmissionBaseline(page);
    await render(page, initial + section("repeated-user", "user", "Preparation")
      + section("new-answer", "assistant", "New response to the repeated request"));
    expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
    expect(await worker.currentSubmissionAnswerText(page, baseline)).toBe("New response to the repeated request");
  } finally { await page.close(); }
});

test("a changed historical ACK cannot be mistaken for a second answer to the submitted user", async () => {
  const page = await browser.newPage();
  try {
    const worker = observer();
    await render(page, initial);
    const baseline = await worker.captureSubmissionBaseline(page);
    await render(page, current("prep-answer-remounted", "answer-shell"));
    const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2_000);
    expect(binding.identity).toBe("answer-shell");
    expect(binding.userIdentity).toBe("submitted-user");
    // Both assistant IDs change again after a long generation; the submitted user is stable.
    await render(page, current("prep-answer-final", "answer-final"));
    const rebound = await worker.reconcileAssistantTurnBinding(page, baseline, binding);
    expect(rebound.identity).toBe("answer-final");
    expect(rebound.userIdentity).toBe("submitted-user");
    const snapshot = await worker.responseDomSnapshot(rebound.locator, {});
    expect(snapshot.visibleText).toBe("Actual final answer");
    const tracker = new ChatGptCompletionTracker(0);
    const completion = { responsePresent: snapshot.responsePresent, running: false,
      currentText: snapshot.visibleText, currentHtml: snapshot.fullHtml, completionActionVisible: snapshot.completionActionVisible };
    tracker.update(completion, 1_000);
    expect(tracker.update(completion, 1_001)).toBe(true);
  } finally { await page.close(); }
});

test.each([true, false])("a historical assistant remount is not bound before the submitted user appears (initially mounted=%s)", async mounted => {
  const page = await browser.newPage();
  try {
    const worker = observer();
    await render(page, section("prep-user", "user", "Preparation") + section("prep-answer", "assistant", "ACK", mounted));
    const baseline = await worker.captureSubmissionBaseline(page);
    const bindingPromise = worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2_000);
    await render(
      page,
      section("prep-user", "user", "Preparation")
        + section("prep-answer-remounted", "assistant", "ACK"),
    );
    const early = await Promise.race([
      bindingPromise.then(() => "bound" as const),
      new Promise<"pending">(resolve => setTimeout(() => resolve("pending"), 100)),
    ]);
    expect(early).toBe("pending");
    expect(await worker.currentSubmissionAnswerText(page, baseline)).toBe("");
    await render(page, current("prep-answer-remounted", "answer-final"));
    const binding = await bindingPromise;
    expect(binding.identity).toBe("answer-final");
    expect(binding.userIdentity).toBe("submitted-user");
  } finally { await page.close(); }
});

test("submission acceptance retains the user anchor before its section is virtualized", async () => {
  const page = await browser.newPage();
  try {
    const worker = observer();
    await render(page, initial);
    const baseline = await worker.captureSubmissionBaseline(page);
    await render(page, initial + section("submitted-user", "user", "Actual request"));
    expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
    expect(baseline.submittedUserIdentity).toBe("submitted-user");
    await render(page, current("prep-answer-remounted", "answer-final", false));
    const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2_000);
    expect(binding).toMatchObject({ identity: "answer-final", userIdentity: "submitted-user" });
    expect(await worker.currentSubmissionAnswerText(page, baseline)).toBe("Actual final answer");
  } finally { await page.close(); }
});

test("an unproven user container cannot give a remounted historical answer ownership", async () => {
  const page = await browser.newPage();
  try {
    const worker = observer();
    await render(page, section("prep-user", "user", "Preparation") + section("prep-answer", "assistant", "ACK", false));
    const baseline = await worker.captureSubmissionBaseline(page);
    await render(page, current("prep-answer-remounted", "answer-final", false));
    await expect(worker.waitForNewAssistantTurn(page, baseline, Date.now() + 5_000, undefined, undefined, 0))
      .rejects.toThrow("did not expose its assistant turn");
    expect(await worker.currentSubmissionAnswerText(page, baseline)).toBe("");
  } finally { await page.close(); }
});

test.each(["virtualized-user", "foreign-user", "missing-user", "ambiguous-answers"])(
  "assistant replacement preserves request ownership: %s", async scenario => {
    const page = await browser.newPage();
    try {
      const worker = observer();
      await render(page, initial);
      const baseline = await worker.captureSubmissionBaseline(page);
      await render(page, current("prep-answer", "answer-shell"));
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2_000);
      if (scenario === "virtualized-user") {
        await render(page, current("prep-answer-remounted", "answer-final", false));
        expect((await worker.reconcileAssistantTurnBinding(page, baseline, binding)).identity).toBe("answer-final");
      } else if (scenario === "foreign-user") {
        await render(page, current("prep-answer", "answer-final")
          + section("foreign-user", "user", "Unrelated request") + section("foreign-answer", "assistant", "Wrong answer"));
        await expect(worker.reconcileAssistantTurnBinding(page, baseline, binding)).rejects.toThrow("another user turn");
      } else if (scenario === "missing-user") {
        await render(page, initial + section("answer-final", "assistant", "Unproven answer"));
        expect((await worker.reconcileAssistantTurnBinding(page, baseline, binding)).identity).toBe("answer-shell");
      } else {
        await render(page, current("prep-answer", "answer-final") + section("extra-answer", "assistant", "Ambiguous answer"));
        await expect(worker.reconcileAssistantTurnBinding(page, baseline, binding)).rejects.toMatchObject({ code: "chatgpt_turn_identity_conflict" });
      }
    } finally { await page.close(); }
  },
);
