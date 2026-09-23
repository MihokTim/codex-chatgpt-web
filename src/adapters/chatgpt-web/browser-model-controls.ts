import type { Locator } from "playwright-core";
import { ChatGptWebAdapterError, chatGptModelSelectionError } from "./adapter-error";

export interface ChatGptModelSelectionContext {
  stage: string;
  family?: string;
  effort?: string;
}

/** One policy for raw UI failures; never replace typed ownership/auth/rate-limit or abort errors. */
export function normalizeChatGptModelSelectionError(
  cause: unknown,
  context: ChatGptModelSelectionContext,
): unknown {
  if (cause instanceof ChatGptWebAdapterError || (cause instanceof Error && cause.name === "AbortError")) return cause;
  const failure = chatGptModelSelectionError(
    `stage=${context.stage}; requested_family=${context.family ?? "default"}; requested_effort=${context.effort ?? "unspecified"}; ChatGPT model controls could not be verified`,
  );
  // Keep the original exception locally, without putting page text/Playwright logs into IPC diagnostics.
  failure.cause = cause;
  return failure;
}

/** A menu's deferred autofocus can undo the focus performed by Locator.press. */
export async function focusChatGptEffortControl(control: Locator): Promise<boolean> {
  const readyDeadline = Date.now() + 5_000;
  while (!await control.isEnabled() || await control.evaluate(element => element.closest('[inert]') !== null)) {
    if (Date.now() >= readyDeadline) return false;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    await control.waitFor({ state: "visible", timeout: 5_000 });
    await control.focus({ timeout: 5_000 });
    await new Promise(resolve => setTimeout(resolve, 100));
    if (await control.evaluate(element => (
      element.isConnected && element.contains(element.ownerDocument.activeElement)
      && !element.closest('[inert], [aria-disabled="true"]')
    ))) return true;
  }
  return false;
}

