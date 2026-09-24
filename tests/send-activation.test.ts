import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { defaultChromeExecutable } from "../src/config";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: defaultChromeExecutable(), headless: true }); });
afterAll(async () => { await browser?.close(); });

const worker = Object.create(ChatGptBrowserWorker.prototype) as {
  captureSubmissionBaseline(page: Page): Promise<unknown>;
  sendAttachedPrompt(page: Page, baseline: unknown, capture?: (checkpoint: string) => Promise<void>,
    signal?: AbortSignal, progress?: undefined, lifecycle?: {
      onSendActivated(): Promise<void>; onSubmitted(): void;
    }): Promise<string>;
};

async function fixture(page: Page) {
  await page.setContent(`<form>
    <div id="prompt-textarea" contenteditable="true"></div>
    <button id="send" type="submit">Send</button>
    </form><main></main><script>
    window.submissions=[];
    document.querySelector('form').onsubmit=event=>{
      event.preventDefault();
      const composer=document.querySelector('#prompt-textarea');
      window.submissions.push(composer.innerText);
      composer.textContent='';
      // Acceptance is asynchronous; a late DOM acknowledgement must never trigger a resend.
      setTimeout(()=>{
        const key='part-'+window.submissions.length;
        const turn=document.createElement('div');turn.dataset.turnKey=key;
        turn.innerHTML='<div data-chatgpt-search-unit-key="'+key+':user" data-chatgpt-search-message-ids="'+key+'">accepted</div>';
        document.querySelector('main').append(turn);
      },150);
    };
    </script>`);
}

test.each(["disabled", "replaced"])("final 6/6 submits exactly once when model preflight leaves Send %s", async scenario => {
  const page = await browser.newPage();
  try {
    await fixture(page);
    const prompts = Array.from({ length: 6 }, (_, index) => `PART ${index + 1}/6\n` + "context ".repeat(9_000) + "END");
    const accepted: number[] = [];
    for (const [index, prompt] of prompts.entries()) {
      await page.locator('#prompt-textarea').fill(prompt);
      const baseline = await worker.captureSubmissionBaseline(page);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      try {
        expect(await worker.sendAttachedPrompt(page, baseline, undefined, controller.signal, undefined, {
          onSendActivated: async () => {
            if (index !== 5) return;
            await page.evaluate(replace => {
              const button = document.querySelector<HTMLButtonElement>('#send')!;
              button.disabled = true;
              // This occurs AFTER the early send-ready check, as image processing/model
              // menu hydration can do in the actual final-part preflight.
              setTimeout(() => {
                const ready = replace ? button.cloneNode(true) as HTMLButtonElement : button;
                ready.disabled = false;
                if (replace) button.replaceWith(ready);
              }, 450);
            }, scenario === "replaced");
          },
          onSubmitted: () => { accepted.push(index + 1); },
        })).toBe("user_turn");
      } finally { clearTimeout(timer); }
    }
    expect(accepted).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await page.evaluate(() => (window as unknown as { submissions: string[] }).submissions)).toEqual(prompts);
  } finally { await page.close(); }
}, 15_000);

test("abort during final Send readiness never submits later when the button recovers", async () => {
  const page = await browser.newPage();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await fixture(page);
    await page.locator('#prompt-textarea').fill('PART 6/6 retained');
    const baseline = await worker.captureSubmissionBaseline(page);
    let accepted = false;
    await expect(worker.sendAttachedPrompt(page, baseline, undefined, controller.signal, undefined, {
      onSendActivated: async () => {
        await page.locator('#send').evaluate((element: HTMLButtonElement) => { element.disabled = true; });
        timer = setTimeout(() => controller.abort(), 100);
      },
      onSubmitted: () => { accepted = true; },
    })).rejects.toThrow();
    await page.locator('#send').evaluate((element: HTMLButtonElement) => { element.disabled = false; });
    await page.waitForTimeout(300);
    expect(accepted).toBe(false);
    expect(await page.locator('#prompt-textarea').textContent()).toBe('PART 6/6 retained');
    expect(await page.evaluate(() => (window as unknown as { submissions: string[] }).submissions)).toEqual([]);
  } finally { if (timer) clearTimeout(timer); await page.close(); }
}, 15_000);
