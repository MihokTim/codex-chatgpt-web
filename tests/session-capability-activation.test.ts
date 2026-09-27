import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { defaultChromeExecutable } from "../src/config";
import { detectChatGptAccountCapabilities } from "../src/chatgpt-session";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: defaultChromeExecutable(), headless: true }); });
afterAll(async () => { await browser?.close(); });

test.each(["click", "pointerdown", "closing"])("account inspection opens a %s picker without sending the draft", async activation => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<style>[data-model-picker-power-slider]{height:30px;width:200px}</style><form data-chatgpt-composer>
      <div contenteditable="true" data-composer-markdown role="textbox">Keep this draft</div>
      <button type="button" id="owner" data-composer-navigation-target="reasoning"
        aria-haspopup="menu" aria-controls="picker" aria-expanded="false" data-state="closed">Model</button>
      <button type="submit">Send</button>
    </form><div id="picker" role="menu" ${activation === "closing" ? "" : "hidden"}>
      <div data-model-picker-power-slider><span data-orientation="horizontal" aria-disabled="false">
        ${Array.from({ length: 5 }, () => '<span data-selected="false"></span>').join("")}
        <span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="4" aria-valuenow="0"></span>
      </span></div></div><script>
      window.submits=0;window.activations=0;
      document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submits++};
      const owner=document.querySelector('#owner'), picker=document.querySelector('#picker');
      owner.onkeydown=e=>{if(e.key==='Enter')e.preventDefault()};
      function open(){window.activations++;picker.hidden=false;owner.setAttribute('aria-expanded','true');owner.dataset.state='open'}
      ${activation === "pointerdown" ? "owner.onpointerdown=open;owner.onclick=()=>{picker.hidden=true;owner.setAttribute('aria-expanded','true')}" : "owner.onclick=open"};
      document.onkeydown=e=>{if(e.key==='Escape'){picker.hidden=true;owner.setAttribute('aria-expanded','false');owner.dataset.state='closed'}};
    </script>`);
    expect(await detectChatGptAccountCapabilities(page, { selectorTimeoutMs: 500 })).toEqual({
      solAvailable: true, extraHighAvailable: true, proAvailable: true,
    });
    expect(await page.evaluate(() => (window as any).activations)).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).submits)).toBe(0);
    expect(await page.getByRole("textbox").innerText()).toBe("Keep this draft");
    expect(await page.locator('#owner').getAttribute('aria-expanded')).toBe('false');
  } finally { await page.close(); }
});
