import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { defaultChromeExecutable } from "../src/config";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { selectChatGptModelFamily } from "../src/adapters/chatgpt-web/model-selection";
import { chatGptEffortSlider, readChatGptEffortAvailability } from "../src/chatgpt-session";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: defaultChromeExecutable(), headless: true }); });
afterAll(async () => { await browser?.close(); });
const worker = () => Object.assign(Object.create(ChatGptBrowserWorker.prototype), { config: { appName: "Codex Native2" } });
// Model an in-page React update while retaining the document's MutationObserver.
const render = (page: Page, html: string) => page.evaluate(value => { document.body.innerHTML = value; }, html);
const power = (key: string, answer: string, user = true) => `<div data-turn-key="${key}">
  ${user ? '<div data-content-search-unit-key="unit:user"><div data-user-message-bubble>Request</div><div class="turn-action-controls"><button>Copy user</button></div></div>' : ''}
  <div data-content-search-unit-key="unit:assistant"><h4 data-conversation-role="assistant"></h4>
  <div data-markdown-text-style="assistant-message">${answer}</div></div>
  <div class="turn-action-controls"><button>Copy assistant</button></div></div>`;
const legacy = (key: string, role: string) => `<div data-turn-id-container="${key}"><section data-testid="conversation-turn-${key}" data-turn="${role}" data-turn-id="${key}"><div class="markdown">${key}</div></section></div>`;

test("mixed renderers preserve document order and bind only the submitted power response", async () => {
  const page = await browser.newPage();
  try {
    const observer = worker();
    const history = power('power-old', 'Power history') + legacy('legacy-user', 'user') + legacy('legacy-answer', 'assistant');
    await render(page, history);
    const baseline = await observer.captureSubmissionBaseline(page);
    expect(baseline.initialTurnIdentities).toEqual(['timeline-user:power-old', 'timeline-assistant:power-old', 'legacy-user', 'legacy-answer']);
    await render(page, history + power('submitted', 'Final response'));
    expect(await observer.currentSubmissionEvidence(page, baseline)).toBe('user_turn');
    const binding = await observer.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
    expect(binding.userIdentity).toBe('timeline-user:submitted');
    expect(binding.identity).toBe('timeline-assistant:submitted');
    expect(await observer.currentSubmissionAnswerText(page, baseline)).toBe('Final response');
    await render(page, history + power('submitted', 'Final response', false));
    expect(await observer.currentSubmissionAnswerText(page, baseline)).toBe('Final response');
    await render(page, history + power('submitted', 'Final response') + power('foreign', 'Wrong response'));
    await expect(observer.currentSubmissionAnswerText(page, baseline)).rejects.toThrow('another user turn');
  } finally { await page.close(); }
});

test("power historical user remounts do not authenticate a submission", async () => {
  const page = await browser.newPage();
  try {
    const observer = worker();
    await render(page, power('old', 'History'));
    const baseline = await observer.captureSubmissionBaseline(page);
    await render(page, power('remounted', 'History') + power('other', 'Unrelated answer'));
    expect(await observer.currentSubmissionEvidence(page, baseline)).toBeUndefined();
    expect(await observer.currentSubmissionAnswerText(page, baseline)).toBe('');
    expect(baseline.submittedUserIdentity).toBeUndefined();
  } finally { await page.close(); }
});

test("power duplicate user bubbles and nested timeline identities are rejected", async () => {
  const page = await browser.newPage();
  try {
    const observer = worker();
    await render(page, power('one', 'A').replace('Request</div>', 'Request</div><div data-user-message-bubble>Other</div>'));
    await expect(observer.captureSubmissionBaseline(page)).rejects.toThrow('unique matching message identity');
    await render(page, `<div data-turn-key="outer">${power('inner', 'A')}</div>`);
    await expect(observer.captureSubmissionBaseline(page)).rejects.toThrow('nested');
  } finally { await page.close(); }
});

test("captured power output binds through the same submitted-user contract", async () => {
  const page = await browser.newPage();
  try {
    const observer = worker();
    const baseline = await observer.captureSubmissionBaseline(page);
    const html = readFileSync(new URL('./fixtures/chatgpt-power-complete.html', import.meta.url), 'utf8');
    await render(page, html);
    expect(await observer.currentSubmissionEvidence(page, baseline)).toBe('user_turn');
    const answer = await observer.currentSubmissionAnswerText(page, baseline);
    expect(answer).toEndWith('STREAM_END_927');
    expect(answer).not.toContain('No tools or apps');
  } finally { await page.close(); }
});

test.each([false, true])("standalone and wrapped power sliders resolve once and preserve disabled ticks (wrapped=%s)", async wrapped => {
  const page = await browser.newPage();
  try {
    const html = '<div data-model-picker-power-slider style="min-height:24px"><span data-orientation="horizontal" aria-disabled="false">'
      + Array.from({ length: 5 }, (_, i) => `<span data-selected="${i <= 2}" ${i === 4 ? 'aria-disabled="true"' : ''}></span>`).join('')
      + '<span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="2"></span></span></div>';
    await page.setContent(wrapped ? `<div role="menuitem" data-reasoning-slider="true">${html}</div>` : html);
    const { sliderContainer, slider } = chatGptEffortSlider(page);
    expect(await sliderContainer.count()).toBe(1);
    expect(await slider.count()).toBe(1);
    expect(await readChatGptEffortAvailability(sliderContainer, { min: 0, max: 4, value: 2 })).toEqual([true, true, true, true, false]);
    await page.locator('[data-selected]').first().evaluate(e => e.setAttribute('data-selected', 'unknown'));
    await expect(readChatGptEffortAvailability(sliderContainer, { min: 0, max: 4, value: 2 })).rejects.toThrow('availability');
  } finally { await page.close(); }
});

test("advanced model view selects the requested family without a view-toggle element", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<div role="menu"><div data-model-picker-view="advanced">'
      + '<div role="menuitemradio" aria-checked="true">Latest</div><div role="menuitemradio" aria-checked="false">GPT-5.6 Sol</div>'
      + '</div></div><script>document.querySelectorAll("[role=menuitemradio]").forEach(row=>row.onclick=()=>document.querySelectorAll("[role=menuitemradio]").forEach(e=>e.setAttribute("aria-checked", String(e===row))))</script>');
    const menu = { menu: page.getByRole('menu') } as Awaited<ReturnType<typeof selectChatGptModelFamily>>;
    await selectChatGptModelFamily(page, menu, '5.6', async () => menu);
    expect(await page.getByRole('menuitemradio', { name: 'GPT-5.6 Sol' }).getAttribute('aria-checked')).toBe('true');
  } finally { await page.close(); }
});

test("modern connector accepts an omitted auxiliary href but rejects contradictory and duplicate mentions", async () => {
  const page = await browser.newPage();
  try {
    const observer = worker();
    await page.setContent('<form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox"><span app-mention-path="app://one" app-mention-display-name="Codex Native2" contenteditable="false">Name</span> Exact request</div></form>');
    const composer = page.getByRole('textbox');
    expect(await observer.connectorIsSelected(composer)).toBeTrue();
    expect(await observer.attachedPromptText(page)).toBe('Exact request');
    await page.locator('[app-mention-path]').evaluate(e => e.setAttribute('data-prompt-link-href', 'app://other'));
    expect(await observer.connectorIsSelected(composer)).toBeFalse();
    await page.locator('[app-mention-path]').evaluate(e => { e.removeAttribute('data-prompt-link-href'); e.after(e.cloneNode(true)); });
    await expect(observer.connectorIsSelected(composer)).rejects.toThrow('duplicate');
  } finally { await page.close(); }
});
