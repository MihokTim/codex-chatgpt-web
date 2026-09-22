import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { CHATGPT_WEB_MODEL_ROUTES } from "../src/chatgpt-web-models";
import { compactionBrowserEffortOverride, selectExplicitWebFamily } from "../src/adapters/chatgpt-web/browser-customizations";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { CHATGPT_FAILED_THINKING_LABELS, CHATGPT_STOPPED_THINKING_LABELS } from "../src/adapters/chatgpt-web/ui-labels";
import { defaultConfig, defaultChromeExecutable } from "../src/config";
import { routeChatGptWebRequest } from "../src/server";
import type { CodexParsedRequest } from "../src/types";

test("the existing light slug retains the local Sol Pro route without changing the Pro slug", () => {
  expect(CHATGPT_WEB_MODEL_ROUTES.find(route => route.slug === "chatgpt-web/light")).toMatchObject({
    displayName: "ChatGPT Web — Sol Pro", adapterEffort: "max", codexEffort: "ultra", requiresPro: true,
  });
  expect(CHATGPT_WEB_MODEL_ROUTES.find(route => route.slug === "chatgpt-web/pro")).toMatchObject({
    displayName: "ChatGPT Web — Pro", adapterEffort: "max", codexEffort: "ultra", requiresPro: true,
  });
});

test("compaction overrides honor the new independent Extra High capability", () => {
  const capabilities = { localToolsEnabled: true, solAvailable: true, proAvailable: true, extraHighAvailable: true };
  expect(compactionBrowserEffortOverride(CHATGPT_WEB_MODEL_ID, "max", capabilities)).toBe("xhigh");
  expect(compactionBrowserEffortOverride(CHATGPT_WEB_MODEL_ID, "max", { ...capabilities, extraHighAvailable: false })).toBeUndefined();
  expect(compactionBrowserEffortOverride(CHATGPT_WEB_MODEL_ID, "high", capabilities)).toBeUndefined();
  expect(compactionBrowserEffortOverride("chatgpt-web-zero-risk-pro", "max", capabilities)).toBeUndefined();
  expect(compactionBrowserEffortOverride("gpt-5.6-luna", "max", capabilities)).toBeUndefined();
});

test("public routes bind explicit browser families without trusting a stale caller family", () => {
  const config = { ...defaultConfig("full"), proAvailable: true, extraHighAvailable: true };
  for (const [slug, family, effort] of [
    ["chatgpt-web/light", "sol", "max"],
    ["chatgpt-web/pro", "latest", "max"],
    ["chatgpt-web/high", "latest", "high"],
  ] as const) {
    const input: CodexParsedRequest = {
      modelId: slug, stream: true, context: { messages: [] },
      options: { reasoning: "low", browserModelFamily: family === "sol" ? "latest" : "sol" },
    };
    routeChatGptWebRequest(input, config);
    expect(input.modelId).toBe(CHATGPT_WEB_MODEL_ID);
    expect(input.options).toMatchObject({ browserModelFamily: family, reasoning: effort });
  }
});

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

test("observed failed-thinking and stopped-thinking labels have distinct terminal classifications", () => {
  const { createWindow } = require("@mixmark-io/domino");
  const worker = readFileSync("src/adapters/chatgpt-web/browser-worker.ts", "utf8");
  const source = worker.split("// CHATGPT_THINKING_STATUS_BEGIN")[1]?.split("// CHATGPT_THINKING_STATUS_END")[0];
  if (!source) throw new Error("Stopped-thinking predicate is missing");
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(
    `function detect(root, options, document, NodeFilter, renderedInDom, overlapsRenderedAnswer, overlapsCommentary) { ${source}; return thinkingStatusVisible(options.labels); }`,
  );
  const detect = new Function(`${js}; return detect;`)();
  const matches = (label: string, labels: readonly string[]) => {
    const window = createWindow(`<article id="current"><div data-streaming-response-status><button>${label}</button></div></article>`);
    return detect(window.document.getElementById("current"), { labels },
      window.document, window.NodeFilter, () => true, () => false, () => false);
  };
  expect(matches("思考を停止しました", CHATGPT_STOPPED_THINKING_LABELS)).toBe(true);
  expect(matches("思考に失敗しました", CHATGPT_STOPPED_THINKING_LABELS)).toBe(false);
  expect(matches("思考に失敗しました", CHATGPT_FAILED_THINKING_LABELS)).toBe(true);
  expect(matches("思考を停止しました", CHATGPT_FAILED_THINKING_LABELS)).toBe(false);
});
