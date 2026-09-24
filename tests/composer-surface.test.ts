import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { defaultChromeExecutable } from "../src/config";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_COMPOSER_SELECTOR, CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_SEND_BUTTON_SELECTOR, CHATGPT_FILE_INPUT_SELECTOR, CHATGPT_CONNECTOR_MENU_ROW_SELECTOR,
  readChatGptEffortAvailability } from "../src/chatgpt-session";
import { selectChatGptModelFamily } from "../src/adapters/chatgpt-web/model-selection";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: defaultChromeExecutable(), headless: true }); });
afterAll(async () => { await browser?.close(); });

async function fixture(page: Page, current: boolean) {
  await page.setContent(`<form id="unrelated"><div role="textbox" contenteditable="true" data-composer-markdown>Other editor</div>
    <button type="submit">Other submit</button><input type="file" multiple></form>
    <form id="chat" ${current ? "data-chatgpt-composer" : ""}>
      <div ${current ? 'data-composer-markdown role="textbox"' : 'id="prompt-textarea"'} contenteditable="true">Prompt</div>
      <button type="button" aria-haspopup="menu" ${current ? 'data-composer-navigation-target="reasoning"' : 'data-tone="neutral"'}>Effort</button>
      <button type="submit" ${current ? "" : 'data-testid="send-button"'}>Send</button>
      <input type="file" accept="image/*,video/*" multiple><input type="file" accept="image/*" multiple>
      <input type="file" multiple ${current ? "" : 'data-testid="upload-photos-input"'}>
    </form><script>window.submits=[];document.querySelectorAll('form').forEach(form=>form.onsubmit=e=>{e.preventDefault();window.submits.push(form.id)})</script>`);
}

test.each([false, true])("composer controls remain scoped to the chat form (current=%s)", async current => {
  const page = await browser.newPage();
  try {
    await fixture(page, current);
    const composer = page.locator(CHATGPT_COMPOSER_SELECTOR);
    expect(await composer.count()).toBe(1);
    const form = composer.locator("xpath=ancestor::form[1]");
    expect(await form.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).count()).toBe(1);
    const send = form.locator(CHATGPT_SEND_BUTTON_SELECTOR);
    expect(await send.count()).toBe(1);
    await send.press("Enter");
    expect(await page.evaluate(() => (window as any).submits)).toEqual(["chat"]);
    const input = form.locator(CHATGPT_FILE_INPUT_SELECTOR);
    expect(await input.count()).toBe(1);
    await input.setInputFiles({ name: "context.txt", mimeType: "text/plain", buffer: Buffer.from("fixture context") });
    expect(await input.evaluate((element: HTMLInputElement) => element.files?.[0]?.name)).toBe("context.txt");
    expect(await form.locator('input[accept]').evaluateAll(elements => elements.every(e => !(e as HTMLInputElement).files?.length))).toBeTrue();
  } finally { await page.close(); }
});

test("a current composer with both old and new markers is selected once", async () => {
  const page = await browser.newPage();
  try {
    await fixture(page, true);
    await page.locator('#chat [contenteditable]').evaluate(e => e.id = "prompt-textarea");
    expect(await page.locator(CHATGPT_COMPOSER_SELECTOR).count()).toBe(1);
  } finally { await page.close(); }
});

test("localized connector display text cannot override the exact selected connector identity", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<div id="composer"><span data-id="plugin:one" data-keyword="Codex Native2">Localized display</span><span data-id="plugin:two" data-keyword="Other">Codex Native2</span></div>');
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { config: { appName: "Codex Native2" } });
    expect(await worker.connectorIsSelected(page.locator('#composer'))).toBeTrue();
    await page.locator('[data-id="plugin:one"]').evaluate(e => e.remove());
    expect(await worker.connectorIsSelected(page.locator('#composer'))).toBeFalse();
  } finally { await page.close(); }
});

test("current mention rows exclude unrelated navigation buttons", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button data-list-navigation-item="true">Unrelated</button><div data-mention-list-scroll-area><button data-list-navigation-item="true">Codex Native2</button></div>');
    expect(await page.locator(CHATGPT_CONNECTOR_MENU_ROW_SELECTOR).allTextContents()).toEqual(['Codex Native2']);
  } finally { await page.close(); }
});

test("current app mentions require matching app links and preserve exact prompt readback", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<form data-chatgpt-composer><div data-composer-markdown role="textbox" contenteditable="true"><p><span app-mention-path="app://fixture" app-mention-display-name="Codex Native2" data-prompt-link-href="app://fixture" contenteditable="false">Localized label</span> Exact prompt</p><p>Second line</p></div></form>');
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { config: { appName: "Codex Native2" } });
    const composer = page.locator(CHATGPT_COMPOSER_SELECTOR);
    expect(await worker.connectorIsSelected(composer)).toBeTrue();
    expect(await worker.attachedPromptText(page)).toBe('Exact prompt\nSecond line');
    await page.locator('[app-mention-path]').evaluate(e => e.setAttribute('data-prompt-link-href','app://other'));
    expect(await worker.connectorIsSelected(composer)).toBeFalse();
    await page.locator('[app-mention-path]').evaluate(e => { e.setAttribute('data-prompt-link-href','app://fixture'); e.after(e.cloneNode(true)); });
    await expect(worker.connectorIsSelected(composer)).rejects.toThrow('duplicate');
  } finally { await page.close(); }
});

test("current power ticks respect locks and reject disabled or incomplete controls", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<div role="menuitem" data-reasoning-slider="true"><div data-model-picker-power-slider><span data-orientation="horizontal" aria-disabled="false">'
      + Array.from({length:5},(_,index)=>`<span data-selected="${index<3}" ${index===4?'data-locked="true"':''}></span>`).join('')+'</span></div></div>');
    const container=page.locator('[data-reasoning-slider]');
    const state={min:0,max:4,value:2};
    expect(await readChatGptEffortAvailability(container,state)).toEqual([true,true,true,true,false]);
    await page.locator('[data-locked]').evaluate(e=>e.removeAttribute('data-locked'));
    expect(await readChatGptEffortAvailability(container,state)).toEqual([true,true,true,true,true]);
    await page.locator('[aria-disabled]').evaluate(e=>e.setAttribute('aria-disabled','true'));
    await expect(readChatGptEffortAvailability(container,state)).rejects.toThrow('availability');
    await page.locator('[aria-disabled]').evaluate(e=>e.setAttribute('aria-disabled','false'));
    await page.locator('[data-selected]').last().evaluate(e=>e.remove());
    await expect(readChatGptEffortAvailability(container,state)).rejects.toThrow('availability');
  } finally { await page.close(); }
}, 15_000);

test.each(['simple', 'advanced'])("current model view %s selects and verifies the requested family", async view => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<div role="menu"><div data-model-picker-view="${view}">
      <div role="menuitem" aria-hidden="false" data-model-picker-view-toggle="true" onclick="this.parentElement.dataset.modelPickerView='advanced';document.querySelector('#choices').hidden=false">Models</div>
      <div id="choices" ${view === 'simple' ? 'hidden' : ''}><div role="menuitemradio" aria-checked="true">Latest</div><div role="menuitemradio" aria-checked="false">GPT-5.6 Sol</div></div>
      </div></div><script>document.querySelectorAll('[role=menuitemradio]').forEach(row=>row.onclick=()=>{document.querySelectorAll('[role=menuitemradio]').forEach(e=>e.setAttribute('aria-checked',String(e===row)));});</script>`);
    const menu:any={menu:page.getByRole('menu')};
    await selectChatGptModelFamily(page,menu,'5.6',async()=>menu);
    expect(await page.getByRole('menuitemradio',{name:'GPT-5.6 Sol'}).getAttribute('aria-checked')).toBe('true');
  } finally { await page.close(); }
});
