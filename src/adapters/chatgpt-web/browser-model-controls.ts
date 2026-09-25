import type { Locator } from "playwright-core";
import { ChatGptWebAdapterError, chatGptModelSelectionError } from "./adapter-error";
import { cancellableDelay } from "./request-scheduling";

export interface ChatGptModelSelectionContext {
  stage: string;
  family?: string;
  effort?: string;
  signal?: AbortSignal;
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
export async function focusChatGptEffortControl(control: Locator, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  const options = () => ({ timeout: Math.max(1, deadline - Date.now()), signal });
  try {
    signal?.throwIfAborted();
    while (!await control.isEnabled(options())
      || await control.evaluate(element => element.closest('[inert]') !== null, undefined, options())) {
      if (Date.now() >= deadline) return false;
      await cancellableDelay(50, signal);
    }
    for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
      signal?.throwIfAborted();
      await control.waitFor({ state: "visible", ...options() });
      await control.focus(options());
      await cancellableDelay(100, signal);
      if (await control.evaluate(element => (
        element.isConnected && element.contains(element.ownerDocument.activeElement)
        && !element.closest('[inert], [aria-disabled="true"]')
      ), undefined, options())) return true;
    }
  } catch (cause) {
    signal?.throwIfAborted();
    // A removed/hydrating control is recoverable by reopening this document's menu.
    // Navigation, closed targets, cancellation, typed errors and programming faults still escape.
    if (cause instanceof ChatGptWebAdapterError) throw cause;
    if (!(cause instanceof Error) || (cause.name !== "TimeoutError"
      && !/Element is not attached to the DOM|Element is not connected/.test(cause.message))) throw cause;
  }
  return false;
}
