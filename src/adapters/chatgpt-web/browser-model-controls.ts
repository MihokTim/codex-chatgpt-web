import type { Locator, Page } from "playwright-core";
import { ChatGptWebAdapterError, chatGptModelSelectionError } from "./adapter-error";
import { cancellableDelay } from "./request-scheduling";

export interface ChatGptModelSelectionContext {
  stage: string;
  family?: string;
  effort?: string;
  signal?: AbortSignal;
}

/** Escape can be lost during menu hydration or dismiss only the inner model view. */
export async function closeChatGptModelMenu(page: Page, control: Locator, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const url = page.url();
  const origin = await page.evaluate(() => performance.timeOrigin);
  const deadline = Date.now() + 5_000;
  const sameDocument = async () => {
    signal?.throwIfAborted();
    if (page.url() !== url || !await page.evaluate(value => performance.timeOrigin === value, origin)) {
      throw chatGptModelSelectionError("stage=menu-dismiss; browser document changed while closing model controls");
    }
  };
  const closed = async () => await control.getAttribute("aria-expanded", { timeout: Math.max(1, deadline - Date.now()) }) === "false"
    && await control.getAttribute("data-state", { timeout: Math.max(1, deadline - Date.now()) }) !== "open";
  for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
    await sameDocument();
    if (!await closed()) {
      if (attempt === 0) await page.keyboard.press("Escape");
      else await control.press("Escape", { timeout: Math.max(1, deadline - Date.now()) });
    }
    const settleDeadline = Math.min(deadline, Date.now() + (attempt === 2 ? 3_000 : 1_000));
    do {
      await sameDocument();
      if (await closed()) {
        // Require the dismissal to survive deferred focus and React work before reading its label.
        await cancellableDelay(100, signal);
        await sameDocument();
        if (await closed()) return;
      }
      await cancellableDelay(50, signal);
    } while (Date.now() < settleDeadline);
  }
  throw chatGptModelSelectionError("stage=menu-dismiss; ChatGPT did not close its model menu after bounded dismissal attempts");
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
