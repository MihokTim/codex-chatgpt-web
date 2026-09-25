import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { defaultChromeExecutable } from "../src/config";

test("post-dialog proof uses the current user and a fresh exact ACK, never remounted history", async () => {
  const browser = await chromium.launch({ executablePath: defaultChromeExecutable(), headless: true });
  const worker = Object.create(ChatGptBrowserWorker.prototype) as {
    captureSubmissionBaseline(page: Page): Promise<unknown>;
    acceptedResponseIsObservable(page: Page, baseline: unknown, signal?: AbortSignal, acknowledgement?: string): Promise<boolean>;
  };
  try {
    const page = await browser.newPage();
    await page.setContent('<div data-turn-id-container="old-user"><section data-turn-id-container="old-user" data-turn-id="old-user" data-turn="user" data-testid="conversation-turn-1">Old request</section></div>'
      + '<div data-turn-id-container="old-answer"><section data-turn-id-container="old-answer" data-turn-id="old-answer" data-turn="assistant" data-testid="conversation-turn-2"><div class="markdown">ACK fixture 3/6</div></section></div>');
    const baseline = await worker.captureSubmissionBaseline(page);
    expect(await worker.acceptedResponseIsObservable(page, baseline, undefined, "ACK fixture 3/6")).toBe(false);
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend",
      '<div data-turn-id-container="new-user"><section data-turn-id-container="new-user" data-turn-id="new-user" data-turn="user" data-testid="conversation-turn-3">Current request</section></div>'));
    expect(await worker.acceptedResponseIsObservable(page, baseline, undefined, "ACK fixture 3/6")).toBe(false);
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend",
      '<div data-turn-id-container="new-answer"><section data-turn-id-container="new-answer" data-turn-id="new-answer" data-turn="assistant" data-testid="conversation-turn-4"><div class="markdown" id="answer">ACK fixture 2/6</div></section></div>'));
    expect(await worker.acceptedResponseIsObservable(page, baseline, undefined, "ACK fixture 3/6")).toBe(false);
    await page.locator("#answer").evaluate(element => { element.textContent = "ACK fixture 3/6"; });
    expect(await worker.acceptedResponseIsObservable(page, baseline, undefined, "ACK fixture 3/6")).toBe(true);
    await page.locator("#answer").evaluate(element => { element.textContent = ""; });
    expect(await worker.acceptedResponseIsObservable(page, baseline)).toBe(false);
    const controller = new AbortController();
    const abort = new DOMException("owner cancelled", "AbortError");
    controller.abort(abort);
    await expect(worker.acceptedResponseIsObservable(page, baseline, controller.signal)).rejects.toBe(abort);
  } finally { await browser.close(); }
}, 15_000);
