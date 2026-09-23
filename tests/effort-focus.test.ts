import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID, type ChatGptWebCapabilities } from "../src/adapters/chatgpt-web/model";
import { defaultChromeExecutable } from "../src/config";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: defaultChromeExecutable(), headless: true }); });
afterAll(async () => { await browser?.close(); });
const capabilities: ChatGptWebCapabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const worker = Object.create(ChatGptBrowserWorker.prototype) as {
  selectModelAndEffort(page: Page, model: string, effort: string, capabilities: ChatGptWebCapabilities,
    captureDiagnostic?: (checkpoint: string) => Promise<void>, trackUsage?: boolean, modelFamily?: "6" | "5.6"):
    Promise<{ uiEffortIndex: number; modelFamily?: string; usageModel?: string }>;
};

async function fixture(page: Page, scenario: string, family?: "6" | "5.6", announcedFamily = family) {
  page.setDefaultTimeout(3_000);
  await page.setContent(`<form onsubmit="event.preventDefault(); window.submits++">
    <div id="prompt-textarea" contenteditable="true">fixture</div>
    <button id="effort" type="button" aria-haspopup="menu" data-tone="neutral" aria-expanded="true" aria-controls="menu">Effort</button>
    <button type="submit">Send</button></form>
    <div id="menu" role="menu" tabindex="-1"><div data-testid="composer-intelligence-picker-content">
      <div data-model-reasoning-effort-slider>${Array.from({ length: 5 }, () => '<span data-locked="false" data-selected="false"></span>').join("")}
      <div id="owner" role="menuitem" tabindex="0"><span role="slider" aria-hidden="true" style="display:inline-block;width:0"
      aria-valuemin="0" aria-valuemax="4" aria-valuenow="0"></span>Effort</div></div>
    </div></div><script>
    const scenario=${JSON.stringify(scenario)};
    const family=${JSON.stringify(family ?? null)}, announcedFamily=${JSON.stringify(announcedFamily ?? null)};
    window.submits=0; window.opens=1;
    let firstFocus=true;
    const menu=document.querySelector('#menu'), button=document.querySelector('#effort');
    if(family){
      menu.insertAdjacentHTML('beforeend', '<div role="menuitemradio" aria-checked="'+(family==='6')+'">最新</div>'
        +'<div role="menuitemradio" aria-checked="'+(family==='5.6')+'">GPT-5.6 Sol</div>');
      const description=document.createElement('span');description.id='model-description';description.hidden=true;
      document.body.append(description);document.querySelector('#owner').setAttribute('aria-describedby',description.id);
    }
    button.onclick=()=>{menu.hidden=false;button.setAttribute('aria-expanded','true');window.opens++;menu.focus()};
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){menu.hidden=true;button.setAttribute('aria-expanded','false');button.focus()}});
    function bind(owner){
      owner.onfocus=()=>{
        if(!firstFocus)return;firstFocus=false;
        if(scenario==='focus-race')queueMicrotask(()=>menu.focus());
        if(scenario==='replace-on-focus')setTimeout(()=>{const replacement=owner.cloneNode(true);owner.replaceWith(replacement);bind(replacement);menu.focus()},30);
      };
      owner.onkeydown=e=>{
        if(!['ArrowRight','ArrowLeft'].includes(e.key))return;
        if(scenario==='reopen'&&window.opens===1)return;
        const slider=owner.querySelector('[role=slider]');
        const move=()=>{
          slider.setAttribute('aria-valuenow',String(Number(slider.getAttribute('aria-valuenow'))+(e.key==='ArrowRight'?1:-1)*(scenario==='jump'?2:1)));
          if(family)document.querySelector('#model-description').textContent=(slider.getAttribute('aria-valuenow')==='4'?announcedFamily+' Pro':'5.6 高')+'、5件中5件目。';
          if(scenario==='range-drift')slider.setAttribute('aria-valuemax','3');
        };
        if(scenario==='delayed')setTimeout(move,150);else move();
      };
    }
    bind(document.querySelector('#owner'));menu.focus();
    </script>`);
}

test.each(["focus-race", "replace-on-focus", "reopen", "delayed"])("effort selection survives menu hydration without submitting: %s", async scenario => {
  const page = await browser.newPage();
  try {
    await fixture(page, scenario);
    expect((await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, "max", capabilities)).uiEffortIndex).toBe(4);
    expect(await page.locator('[role="slider"]').getAttribute("aria-valuenow")).toBe("4");
    expect(await page.evaluate(() => (window as unknown as { submits: number }).submits)).toBe(0);
  } finally { await page.close(); }
}, 20_000);

test.each(["6", "5.6"] as const)("Japanese named Pro selection survives menu reopen without submitting: %s", async family => {
  const page = await browser.newPage();
  try {
    await fixture(page, "localized-family", family);
    const mode = await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, "max", capabilities, undefined, true, family);
    expect(mode).toMatchObject({ uiEffortIndex: 4, modelFamily: family, usageModel: family === "6" ? "gpt-6-pro" : "gpt-5.6-pro" });
    expect(await page.locator("#effort").getAttribute("aria-expanded")).toBe("false");
    expect(await page.locator("#prompt-textarea").evaluate(element => element === element.ownerDocument.activeElement)).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { submits: number }).submits)).toBe(0);
  } finally { await page.close(); }
}, 20_000);

test("Japanese Pro announcement from a different family is rejected before submission", async () => {
  const page = await browser.newPage();
  try {
    await fixture(page, "localized-family", "6", "5.6");
    const failure = await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, "max", capabilities, undefined, false, "6")
      .then(() => null, error => error);
    expect(failure).toMatchObject({ code: "model_version_unavailable", retryable: false });
    expect(await page.evaluate(() => (window as unknown as { submits: number }).submits)).toBe(0);
  } finally { await page.close(); }
}, 20_000);

test.each(["jump", "range-drift"])("unexpected effort movement is terminal: %s", async scenario => {
  const page = await browser.newPage();
  try {
    await fixture(page, scenario);
    const failure = await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, "max", capabilities)
      .then(() => null, error => error);
    expect(failure).toMatchObject({ code: "chatgpt_model_selection_failed", retryable: false });
    expect(await page.evaluate(() => (window as unknown as { submits: number }).submits)).toBe(0);
  } finally { await page.close(); }
}, 20_000);
