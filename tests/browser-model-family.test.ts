import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { selectExplicitWebFamily } from "../src/adapters/chatgpt-web/browser-customizations";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { defaultChromeExecutable } from "../src/config";

test("explicit family selection and pre-submit verification use actual Chromium radio state", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.LOCAL_REVIEW_CHROME || defaultChromeExecutable(),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`<form><div id="prompt-textarea" contenteditable="true">fixture</div>
      <button id="effort" type="button" aria-haspopup="menu" data-tone="neutral"
        aria-expanded="false" aria-controls="menu" onclick="openMenu()">Pro</button></form>
      <div id="menu"><div data-testid="composer-intelligence-picker-content">
      <div data-model-selection-view><div role="menuitem" aria-expanded="false"
        onclick="this.setAttribute('aria-expanded',String(this.getAttribute('aria-expanded')!=='true'))">Families</div></div>
      <div data-testid="composer-model-picker-slider-advanced-view">
        <button id="sol-family" role="menuitemradio" aria-checked="false" onclick="selectFamily(this)">GPT-5.6 Sol</button>
        <button id="latest-family" role="menuitemradio" aria-checked="true" onclick="selectFamily(this)">最新</button>
      </div><div id="slider" data-model-reasoning-effort-slider><div role="menuitem">
        <span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="4"></span>Effort
      </div></div></div></div>
      <script>
      function selectFamily(button){document.querySelectorAll('[role=menuitemradio]').forEach(x=>x.setAttribute('aria-checked',String(x===button)))}
      function openMenu(){document.querySelector('#menu').hidden=false;document.querySelector('#effort').setAttribute('aria-expanded','true')}
      document.addEventListener('keydown',event=>{if(event.key==='Escape'){
        document.querySelector('#menu').hidden=true;document.querySelector('#effort').setAttribute('aria-expanded','false');
        document.querySelector('#prompt-textarea').focus();
      }});
      </script>`);
    const activation = { menu: page.locator("#menu"), sliderContainer: page.locator("#slider") };
    expect(await selectExplicitWebFamily(page, activation, "sol")).toBe("GPT-5.6 Sol");
    expect(await page.getByRole("menuitemradio", { name: "GPT-5.6 Sol", exact: true }).getAttribute("aria-checked")).toBe("true");
    expect(await selectExplicitWebFamily(page, activation, "latest")).toBe("最新");
    expect(await page.getByRole("menuitemradio", { name: "最新", exact: true }).getAttribute("aria-checked")).toBe("true");
    const preflight = Object.create(ChatGptBrowserWorker.prototype) as {
      assertSelectedEffort(page: unknown, mode: unknown): Promise<void>;
    };
    const selectedMode = {
      browserFamily: "最新", modelId: CHATGPT_WEB_MODEL_ID, effort: "max", displayLabel: "Pro",
      uiEffortIndex: 4, thinkEnabled: false, localTools: false,
      selection: { url: page.url(), label: "Pro", browserFamily: "latest" },
    };
    await page.locator("#menu").evaluate(element => { (element as HTMLElement).hidden = true; });
    await preflight.assertSelectedEffort(page, selectedMode);
    expect(await page.locator("#menu").isHidden()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("prompt-textarea");
    await page.locator("#menu").evaluate(element => { (element as HTMLElement).hidden = false; });
    await page.locator("[data-model-selection-view]").evaluate(element => element.appendChild(element.firstElementChild!.cloneNode(true)));
    await expect(selectExplicitWebFamily(page, activation, "sol")).rejects.toThrow("family control is unavailable");
  } finally {
    await browser.close();
  }
}, 30_000);
