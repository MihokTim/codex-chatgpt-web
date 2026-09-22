import { defaultChromeExecutable } from "../src/config";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID, type ChatGptWebCapabilities } from "../src/adapters/chatgpt-web/model";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({
    executablePath: process.env.LOCAL_REVIEW_CHROME || defaultChromeExecutable(),
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

type PreflightMenuLifecycle = "hidden-retained" | "dom-removed" | "controls-removed" | "dom-replaced";
type PreflightFamily = "sol" | "latest";

function selectedPreflightMode(page: Page, family: PreflightFamily = "sol") {
  return {
    browserFamily: family === "sol" ? "GPT-5.6 Sol" : "Latest",
    modelId: CHATGPT_WEB_MODEL_ID,
    effort: "max",
    displayLabel: "Pro",
    uiEffortIndex: 4,
    thinkEnabled: false,
    localTools: false,
    selection: { url: page.url(), label: "Pro", browserFamily: family },
  };
}

const preflightWorker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
  waitForSubmissionAcceptedWithRecovery: async () => "user_turn",
}) as unknown as {
  assertSelectedEffort(page: Page, mode: ReturnType<typeof selectedPreflightMode>): Promise<void>;
  sendAttachedPrompt(
    page: Page,
    baseline: unknown,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    abortSignal?: AbortSignal,
    externalProgress?: unknown,
    submissionLifecycle?: {
      onSendActivated?: () => void | Promise<void>;
      onSubmitted?: () => void;
    },
  ): Promise<string>;
};

async function preflightFixture(
  page: Page,
  lifecycle: PreflightMenuLifecycle,
  liveFamily: PreflightFamily = "sol",
): Promise<void> {
  page.setDefaultTimeout(3_000);
  const ariaControls = lifecycle === "controls-removed"
    ? ""
    : ` aria-controls="${lifecycle === "dom-removed" ? "menu-missing" : "menu-stale"}"`;
  await page.setContent(`<form id="composer-form">
    <div id="prompt-textarea" contenteditable="true">fixture</div>
    <button id="effort" type="button" aria-haspopup="menu" data-tone="neutral"
      aria-expanded="false"${ariaControls}>Pro</button>
    <button type="submit" data-testid="send-button">Send</button>
  </form><div id="menu-root"></div>
  <script>
  const lifecycle=${JSON.stringify(lifecycle)};
  const liveFamily=${JSON.stringify(liveFamily)};
  const root=document.querySelector('#menu-root');
  const control=document.querySelector('#effort');
  const composer=document.querySelector('#prompt-textarea');
  const state=window.preflightState={opens:0,familyClicks:0,sliderKeys:0,submits:0,menuIds:[],submitStates:[]};
  function createMenu(id,family,hidden){
    const menu=document.createElement('div');
    menu.id=id;menu.setAttribute('role','menu');menu.hidden=hidden;
    menu.innerHTML='<div data-testid="composer-intelligence-picker-content">'
      +'<div data-testid="composer-model-picker-slider-advanced-view">'
      +'<button role="menuitemradio" aria-checked="'+String(family==='sol')+'">GPT-5.6 Sol</button>'
      +'<button role="menuitemradio" aria-checked="'+String(family==='latest')+'">Latest</button>'
      +'</div><div data-model-reasoning-effort-slider><div role="menuitem" tabindex="0">'
      +'<span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="4" aria-valuenow="4"></span>Effort'
      +'</div></div></div>';
    menu.querySelectorAll('[role=menuitemradio]').forEach(choice=>choice.addEventListener('click',()=>state.familyClicks++));
    menu.querySelector('[data-model-reasoning-effort-slider] [role=menuitem]').addEventListener('keydown',event=>{
      if(event.key==='ArrowLeft'||event.key==='ArrowRight')state.sliderKeys++;
    });
    root.appendChild(menu);state.menuIds.push(id);return menu;
  }
  if(lifecycle==='hidden-retained'||lifecycle==='controls-removed')createMenu('menu-stale',liveFamily,true);
  if(lifecycle==='dom-replaced')createMenu('menu-stale',liveFamily==='sol'?'latest':'sol',true);
  function visibleMenus(){return Array.from(root.querySelectorAll('[role=menu]')).filter(menu=>!menu.hidden)}
  control.addEventListener('click',()=>{
    state.opens++;control.setAttribute('aria-expanded','true');
    if(lifecycle==='hidden-retained'||lifecycle==='controls-removed'){
      root.querySelector('#menu-stale').hidden=false;
      if(lifecycle==='controls-removed')control.removeAttribute('aria-controls');
      return;
    }
    root.querySelectorAll('[id^=menu-live-]').forEach(menu=>menu.remove());
    const menu=createMenu('menu-live-'+state.opens,liveFamily,false);
    if(lifecycle==='dom-removed')control.setAttribute('aria-controls',menu.id);
    else control.setAttribute('aria-controls','menu-stale');
  });
  document.addEventListener('keydown',event=>{
    if(event.key!=='Escape')return;
    if(lifecycle==='hidden-retained'||lifecycle==='controls-removed')root.querySelector('#menu-stale').hidden=true;
    else root.querySelectorAll('[id^=menu-live-]').forEach(menu=>menu.remove());
    control.setAttribute('aria-expanded','false');
    if(lifecycle==='controls-removed')control.removeAttribute('aria-controls');
    if(lifecycle==='dom-replaced')control.setAttribute('aria-controls','menu-stale');
    composer.focus();
  });
  document.querySelector('#composer-form').addEventListener('submit',event=>{
    event.preventDefault();state.submits++;
    state.submitStates.push({expanded:control.getAttribute('aria-expanded'),visibleMenus:visibleMenus().length});
  });
  composer.focus();
  </script>`);
}

async function readPreflightState(page: Page) {
  return page.evaluate(() => {
    const state = (window as unknown as {
      preflightState: {
        opens: number; familyClicks: number; sliderKeys: number; submits: number;
        menuIds: string[]; submitStates: Array<{ expanded: string | null; visibleMenus: number }>;
      };
    }).preflightState;
    const root = document.querySelector("#menu-root")!;
    return {
      ...state,
      expanded: document.querySelector("#effort")!.getAttribute("aria-expanded"),
      ariaControls: document.querySelector("#effort")!.getAttribute("aria-controls"),
      activeElement: document.activeElement?.id,
      visibleMenus: Array.from(root.querySelectorAll<HTMLElement>('[role="menu"]')).filter(menu => !menu.hidden).length,
    };
  });
}

for (const lifecycle of ["hidden-retained", "dom-removed", "controls-removed", "dom-replaced"] as const) {
  test(`pre-submit verification reacquires the open menu without reselection: ${lifecycle}`, async () => {
    const page = await browser.newPage();
    try {
      await preflightFixture(page, lifecycle);
      const mode = selectedPreflightMode(page);
      await preflightWorker.assertSelectedEffort(page, mode);
      await preflightWorker.assertSelectedEffort(page, mode);
      const state = await readPreflightState(page);
      expect(state.opens).toBe(2);
      expect(state.familyClicks).toBe(0);
      expect(state.sliderKeys).toBe(0);
      expect(state.expanded).toBe("false");
      expect(state.activeElement).toBe("prompt-textarea");
      expect(state.visibleMenus).toBe(0);
      if (lifecycle === "dom-removed" || lifecycle === "dom-replaced") {
        expect(state.menuIds.filter(id => id.startsWith("menu-live-"))).toEqual(["menu-live-1", "menu-live-2"]);
      }
      if (lifecycle === "controls-removed") expect(state.ariaControls).toBeNull();
    } finally { await page.close(); }
  }, 20_000);
}

test("pre-submit verification rejects a real family change from a newly opened menu", async () => {
  const page = await browser.newPage();
  try {
    await preflightFixture(page, "dom-replaced", "latest");
    const failure = await preflightWorker.assertSelectedEffort(page, selectedPreflightMode(page, "sol"))
      .then(() => null, error => error);
    expect(failure).toMatchObject({
      status: 502, code: "chatgpt_model_selection_failed", retryable: false,
    });
    expect(failure.message).toContain("stage=preflight-family");
    const state = await readPreflightState(page);
    expect(state.expanded).toBe("false");
    expect(state.activeElement).toBe("prompt-textarea");
    expect(state.visibleMenus).toBe(0);
  } finally { await page.close(); }
}, 20_000);

for (const [transport, lifecycle] of [
  ["normal", "hidden-retained"],
  ["multipart-stage", "dom-removed"],
  ["multipart-final", "dom-replaced"],
] as const) {
  test(`send activation returns to the composer before ${transport} submission`, async () => {
    const page = await browser.newPage();
    try {
      await preflightFixture(page, lifecycle);
      const mode = selectedPreflightMode(page);
      const lifecycleEvents: string[] = [];
      const evidence = await preflightWorker.sendAttachedPrompt(
        page,
        {},
        undefined,
        undefined,
        undefined,
        {
          onSendActivated: async () => {
            lifecycleEvents.push("activated");
            await preflightWorker.assertSelectedEffort(page, mode);
            const state = await readPreflightState(page);
            expect(state.expanded).toBe("false");
            expect(state.activeElement).toBe("prompt-textarea");
            expect(state.visibleMenus).toBe(0);
          },
          onSubmitted: () => { lifecycleEvents.push("submitted"); },
        },
      );
      expect(evidence).toBe("user_turn");
      expect(lifecycleEvents).toEqual(["activated", "submitted"]);
      const state = await readPreflightState(page);
      expect(state.submits).toBe(1);
      expect(state.submitStates).toEqual([{ expanded: "false", visibleMenus: 0 }]);
      expect(state.familyClicks).toBe(0);
      expect(state.sliderKeys).toBe(0);
    } finally { await page.close(); }
  }, 20_000);
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
