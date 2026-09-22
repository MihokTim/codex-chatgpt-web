import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { CHATGPT_WEB_MODEL_ROUTES } from "../src/chatgpt-web-models";
import { compactionBrowserEffortOverride, selectExplicitWebFamily } from "../src/adapters/chatgpt-web/browser-customizations";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { defaultConfig } from "../src/config";
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

test("explicit family selection switches actual Chromium DOM radio state and rejects ambiguity", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.LOCAL_REVIEW_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="menu"><div data-testid="composer-intelligence-picker-content">
      <div data-model-selection-view><div role="menuitem" aria-expanded="false"
        onclick="this.setAttribute('aria-expanded','true')">Families</div></div>
      <div data-testid="composer-model-picker-slider-advanced-view">
        <button role="menuitemradio" aria-checked="false" onclick="selectFamily(this)">GPT-5.6 Sol</button>
        <button role="menuitemradio" aria-checked="true" onclick="selectFamily(this)">最新</button>
      </div><div id="slider">Effort</div></div></div>
      <script>function selectFamily(button){document.querySelectorAll('[role=menuitemradio]').forEach(x=>x.setAttribute('aria-checked',String(x===button)))}</script>`);
    const activation = { menu: page.locator("#menu"), sliderContainer: page.locator("#slider") };
    expect(await selectExplicitWebFamily(page, activation, "sol")).toBe("GPT-5.6 Sol");
    expect(await page.getByRole("menuitemradio", { name: "GPT-5.6 Sol", exact: true }).getAttribute("aria-checked")).toBe("true");
    expect(await selectExplicitWebFamily(page, activation, "latest")).toBe("最新");
    expect(await page.getByRole("menuitemradio", { name: "最新", exact: true }).getAttribute("aria-checked")).toBe("true");
    await page.locator("[data-model-selection-view]").evaluate(element => element.appendChild(element.firstElementChild!.cloneNode(true)));
    await expect(selectExplicitWebFamily(page, activation, "sol")).rejects.toThrow("family control is unavailable");
  } finally {
    await browser.close();
  }
}, 30_000);
