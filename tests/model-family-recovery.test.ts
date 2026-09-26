import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { defaultChromeExecutable } from "../src/config";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

test("a transient family-control timeout reopens the same composer once without sending", async () => {
  const browser = await chromium.launch({ executablePath: defaultChromeExecutable(), headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<form onsubmit="event.preventDefault();window.submits++">
      <div id="prompt-textarea" contenteditable="true">Unsent prompt</div>
      <button id="effort" type="button" data-tone="neutral" aria-haspopup="menu" aria-expanded="false" aria-controls="menu">Pro</button>
      <button type="submit">Send</button></form>
      <div id="menu" role="menu" hidden><div data-model-picker-view="simple">
        <div role="menuitem" tabindex="0" data-model-picker-view-toggle="true" aria-hidden="false">Models</div>
        <div id="choices" hidden><div role="menuitemradio" aria-checked="true">Latest</div>
          <div role="menuitemradio" aria-checked="false">GPT-5.6 Sol</div></div>
      </div><div data-model-reasoning-effort-slider>
        ${Array.from({length:5}, () => '<span data-selected="false" data-locked="false"></span>').join('')}
        <div role="menuitem" tabindex="0" aria-describedby="description"><span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="4" aria-valuenow="4"></span>Power</div>
      </div></div><span id="description" hidden>6 Pro, 5 of 5.</span>
      <div id="hydration-overlay" hidden style="position:fixed;inset:0;z-index:9999;background:transparent"></div>
      <script>
        window.opens=0;window.submits=0;window.selections=0;
        const menu=document.querySelector('#menu'),button=document.querySelector('#effort'),overlay=document.querySelector('#hydration-overlay');
        button.onclick=()=>{menu.hidden=false;button.setAttribute('aria-expanded','true');window.opens++;overlay.hidden=window.opens!==1};
        document.addEventListener('keydown',e=>{if(e.key==='Escape'){menu.hidden=true;button.setAttribute('aria-expanded','false');overlay.hidden=true}});
        document.querySelector('[data-model-picker-view-toggle]').onclick=()=>{document.querySelector('[data-model-picker-view]').dataset.modelPickerView='advanced';document.querySelector('#choices').hidden=false};
        document.querySelectorAll('[role=menuitemradio]').forEach((row,i)=>row.onclick=()=>{
          window.selections++;document.querySelectorAll('[role=menuitemradio]').forEach(e=>e.setAttribute('aria-checked',String(e===row)));
          document.querySelector('#description').textContent=(i===1?'5.6':'6')+' Pro, 5 of 5.';
        });
      </script>`);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const checkpoints: string[] = [];
    const mode = await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, "max",
      { solAvailable:true, extraHighAvailable:true, proAvailable:true, localToolsEnabled:false },
      async (checkpoint: string) => { checkpoints.push(checkpoint); }, false, "5.6");
    expect(mode.modelFamily).toBe("5.6");
    expect(checkpoints.filter(value => value === "effort-controls-reopening")).toHaveLength(1);
    expect(await page.evaluate(() => ({ submits:(window as any).submits, selections:(window as any).selections })))
      .toEqual({ submits:0, selections:1 });
    expect(await page.locator('#prompt-textarea').innerText()).toBe('Unsent prompt');
    expect(await page.locator('#effort').getAttribute('aria-expanded')).toBe('false');
  } finally { await browser.close(); }
}, 20000);
