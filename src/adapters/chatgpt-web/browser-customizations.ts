import type { Locator, Page } from "playwright-core";
import { chatGptModelSelectionError } from "./adapter-error";
import { CHATGPT_WEB_MODEL_ID, type ChatGptWebCapabilities } from "./model";

/** Use Extra High for compaction only when refreshed account detection confirms it. */
export function compactionBrowserEffortOverride(
  modelId: string,
  reasoning: string | undefined,
  capabilities: ChatGptWebCapabilities,
): "xhigh" | undefined {
  return modelId === CHATGPT_WEB_MODEL_ID && reasoning === "max" && capabilities.extraHighAvailable
    ? "xhigh"
    : undefined;
}

/** Verify the visible model family instead of inheriting a previous browser selection. */
export async function selectExplicitWebFamily(
  _page: Page,
  activation: { menu: Locator; sliderContainer: Locator },
  family: "sol" | "latest",
): Promise<string> {
  if (family !== "sol" && family !== "latest") throw new Error("Invalid explicit ChatGPT family");
  const picker = activation.menu.locator('[data-testid="composer-intelligence-picker-content"]');
  const toggle = picker.locator('[data-model-selection-view] [role="menuitem"][aria-expanded]').filter({ visible: true });
  if (await toggle.count() !== 1) throw chatGptModelSelectionError(`stage=family-control; family=${family}; ChatGPT model family control is unavailable`);
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click({ timeout: 5_000 });
  const name = family === "sol" ? /^GPT-5\.6 Sol$/ : /^(Latest|最新)$/;
  const choices = picker.locator('[data-testid="composer-model-picker-slider-advanced-view"]');
  const choice = choices.getByRole("menuitemradio", { name, exact: true, includeHidden: true });
  await choice.waitFor({ state: "visible", timeout: 5_000 });
  if (await choice.count() !== 1) throw chatGptModelSelectionError(`stage=family-choice; family=${family}; ChatGPT requested family is ambiguous`);
  const observed = (await choice.innerText()).trim();
  await choice.click({ timeout: 5_000 });
  const deadline = Date.now() + 5_000;
  while (await choice.getAttribute("aria-checked") !== "true") {
    if (Date.now() >= deadline) throw chatGptModelSelectionError(`stage=family-confirmation; family=${family}; ChatGPT did not confirm the requested model family`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await activation.sliderContainer.waitFor({ state: "visible", timeout: 5_000 });
  return observed;
}
