import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID, type ChatGptWebCapabilities } from "../src/adapters/chatgpt-web/model";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({
    executablePath: process.env.LOCAL_REVIEW_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  });
});
afterAll(async () => { await browser?.close(); });

const capabilities: ChatGptWebCapabilities = {
  localToolsEnabled: false, solAvailable: true, extraHighAvailable: true,
  proAvailable: true, browserModelFamily: "sol",
};
const worker = ChatGptBrowserWorker.forProvider({
  adapter: "chatgpt-web", baseUrl: "browser://effort-focus-regression", chatgptWeb: capabilities,
}) as unknown as {
  selectModelAndEffort(page: Page, model: string, effort: string,
    capabilities: ChatGptWebCapabilities, diagnostic?: (checkpoint: string) => Promise<void>): Promise<unknown>;
};

type Scenario = "family-panel" | "focus-race" | "replace-on-focus" | "reopen" | "delayed" | "jump" | "family-drift" | "range-drift";
async function fixture(page: Page, scenario: Scenario) {
  page.setDefaultTimeout(3_000);
  await page.setContent(`<form onsubmit="event.preventDefault(); window.submits++">
    <div id="prompt-textarea" contenteditable="true">fixture</div>
    <button id="effort" type="button" aria-haspopup="menu" data-tone="neutral" aria-expanded="true" aria-controls="menu">Effort</button>
    <button type="submit">Send</button></form>
    <div id="menu" role="menu" tabindex="-1"><div data-testid="composer-intelligence-picker-content">
      <div data-model-selection-view><button id="family" role="menuitem" aria-expanded="${scenario === "family-panel" ? "true" : "false"}">Family</button></div>
      <div data-testid="composer-model-picker-slider-advanced-view">
        <button id="sol" role="menuitemradio" aria-checked="true">GPT-5.6 Sol</button>
      </div>
      <div data-model-reasoning-effort-slider><div id="owner" role="menuitem" tabindex="0">
        <span role="slider" aria-hidden="true" style="display:inline-block;width:0" aria-valuemin="0" aria-valuemax="4" aria-valuenow="0"></span>Effort
      </div></div>
    </div></div>
    <script>
    const scenario=${JSON.stringify(scenario)};
    window.submits=0; window.keys=[]; window.opens=1; window.familyClicks=0;
    let focusRace=true;
    const menu=document.querySelector('#menu'), button=document.querySelector('#effort');
    button.onclick=()=>{menu.hidden=false;button.setAttribute('aria-expanded','true');window.opens++;menu.focus();
      document.querySelector('#family').setAttribute('aria-expanded','false');
      if(scenario==='family-panel')setTimeout(()=>document.querySelector('#owner').removeAttribute('aria-disabled'),180);
    };
    document.querySelector('#sol').onclick=()=>{window.familyClicks++};
    document.querySelector('#family').onclick=function(){
      const expanded=this.getAttribute('aria-expanded')!=='true';
      this.setAttribute('aria-expanded',String(expanded));
      if(scenario==='family-panel')setTimeout(()=>document.querySelector('#owner').setAttribute('aria-disabled',String(expanded)),180);
    };
    if(scenario==='family-panel')document.querySelector('#owner').setAttribute('aria-disabled','true');
    document.addEventListener('keydown',e=>{
      if(e.key==='Escape'){menu.hidden=true;button.setAttribute('aria-expanded','false');button.focus()}
    });
    function bind(owner){
      owner.onfocus=()=>{
        if(!focusRace)return;focusRace=false;
        if(scenario==='focus-race')queueMicrotask(()=>menu.focus());
        if(scenario==='replace-on-focus')setTimeout(()=>{
          const replacement=owner.cloneNode(true);owner.replaceWith(replacement);bind(replacement);menu.focus();
        },30);
      };
      owner.onkeydown=e=>{
        if(!['ArrowRight','ArrowLeft'].includes(e.key))return;
        window.keys.push(e.key);
        if(owner.getAttribute('aria-disabled')==='true')return;
        if(scenario==='reopen' && window.opens===1)return;
        const slider=owner.querySelector('[role=slider]');
        const move=()=>{
          slider.setAttribute('aria-valuenow',String(Number(slider.getAttribute('aria-valuenow'))+(e.key==='ArrowRight'?1:-1)*(scenario==='jump'?2:1)));
          if(scenario==='family-drift')document.querySelector('#sol').setAttribute('aria-checked','false');
          if(scenario==='range-drift')slider.setAttribute('aria-valuemax','3');
        };
        if(scenario==='delayed')setTimeout(move,150);else move();
      };
    }
    bind(document.querySelector('#owner')); menu.focus();
    </script>`);
}

test("a single implicit-focus press can leave the real DOM slider at 0 with focus on the menu", async () => {
  const page = await browser.newPage();
  try {
    await fixture(page, "focus-race");
    await page.locator("#owner").press("ArrowRight");
    expect(await page.locator('[role="slider"]').getAttribute("aria-valuenow")).toBe("0");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("menu");
  } finally { await page.close(); }
});

test("the observed advanced family panel leaves a rendered slider disabled despite a checked Sol radio", async () => {
  const page = await browser.newPage();
  try {
    await fixture(page, "family-panel");
    expect(await page.locator('#sol').getAttribute('aria-checked')).toBe('true');
    expect(await page.locator('#owner').isVisible()).toBe(true);
    expect(await page.locator('#owner').isEnabled()).toBe(false);
    await page.locator('#owner').press('ArrowRight');
    expect(await page.locator('[role="slider"]').getAttribute('aria-valuenow')).toBe('0');
    await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, 'max', capabilities);
    expect(await page.locator('[role="slider"]').getAttribute('aria-valuenow')).toBe('4');
  } finally { await page.close(); }
}, 20_000);

test.each(["family-panel", "focus-race", "replace-on-focus", "reopen", "delayed"] as const)(
  "real selection reaches Pro without resending the prompt: %s", async scenario => {
    const page = await browser.newPage();
    try {
      await fixture(page, scenario);
      const checkpoints: string[] = [];
      const selected = await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, "max", capabilities,
        async checkpoint => { checkpoints.push(checkpoint); });
      expect(selected).toMatchObject({ browserFamily: "GPT-5.6 Sol", uiEffortIndex: 4 });
      expect(await page.locator('[role="slider"]').getAttribute("aria-valuenow")).toBe("4");
      const state = await page.evaluate(() => {
        const w = window as unknown as { keys: string[]; opens: number; familyClicks: number; submits: number };
        return { keys: w.keys, opens: w.opens, familyClicks: w.familyClicks, submits: w.submits };
      });
      expect(state.familyClicks).toBe(0);
      expect(state.submits).toBe(0);
      expect(state.keys.length).toBe(scenario === "reopen" ? 5 : 4);
      expect(checkpoints.filter(x => x === "effort-controls-reopening").length).toBe(scenario === "reopen" ? 1 : 0);
    } finally { await page.close(); }
  }, 20_000,
);

test.each(["jump", "family-drift", "range-drift"] as const)("selection fails closed on unexpected state: %s", async scenario => {
  const page = await browser.newPage();
  try {
    await fixture(page, scenario);
    const checkpoints: string[] = [];
    const failure = await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, "max", capabilities,
      async checkpoint => { checkpoints.push(checkpoint); }).then(() => null, error => error);
    expect(failure).toMatchObject({
      status: 502, code: "chatgpt_model_selection_failed", retryable: false,
    });
    expect(checkpoints).not.toContain("effort-controls-reopening");
    expect(await page.evaluate(() => (window as unknown as { submits: number }).submits)).toBe(0);
  } finally { await page.close(); }
});

test("five independent pages recover focus without serializing generation or sharing keyboard state", async () => {
  const pages = await Promise.all(Array.from({ length: 5 }, () => browser.newPage()));
  try {
    await Promise.all(pages.map(async page => {
      await fixture(page, "focus-race");
      await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, "max", capabilities);
      expect(await page.locator('[role="slider"]').getAttribute("aria-valuenow")).toBe("4");
    }));
  } finally { await Promise.all(pages.map(page => page.close())); }
}, 20_000);
