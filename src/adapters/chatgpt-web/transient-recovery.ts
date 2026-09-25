import { ChatGptWebAdapterError } from "./adapter-error";

const preparationRecoveries = new WeakMap<object, Promise<void>>();
export const preparedBrowserRecovery = (owner: object): Promise<void> | undefined => preparationRecoveries.get(owner);

/** All observers of one failed physical preparation share both cleanup and retry accounting. */
export function sharePreparedBrowserRecovery(owner: object, recover: () => Promise<void>): Promise<void> {
  const existing = preparationRecoveries.get(owner);
  if (existing) return existing;
  const ready = Promise.resolve().then(recover);
  void ready.catch(() => {});
  preparationRecoveries.set(owner, ready);
  return ready;
}

/** No quota, authentication, refusal, cancellation, or ambiguous tool execution is retried here. */
export function isTransientBrowserPreparationFailure(error: unknown): boolean {
  if (error instanceof ChatGptWebAdapterError) {
    return error.code === "chatgpt_browser_viewport_unavailable"
      || (error.code === "upstream_server_error" && error.retryable);
  }
  if (!(error instanceof Error) || error.name === "AbortError") return false;
  return /^ChatGPT browser stage timed out: (browser_page|temporary_chat_preparation|effort_selection|prompt_attachment|file_attachment)$/.test(error.message)
    || /^Launcher browser (connection|CDP endpoint) (timed out|is not ready)/.test(error.message)
    || /^Could not connect Playwright to the launcher browser:/.test(error.message);
}

export function isRecoverableResponseFailure(error: unknown): error is ChatGptWebAdapterError {
  return error instanceof ChatGptWebAdapterError
    && (error.code === "chatgpt_failed_thinking"
      || (error.code === "upstream_server_error" && error.retryable));
}

/** A fresh compaction runtime has no tool capability and only rebuilds a summary from native history. */
export function isTransientSummaryFailure(error: unknown): boolean {
  if (isTransientBrowserPreparationFailure(error)) return true;
  return error instanceof Error && !(error instanceof ChatGptWebAdapterError)
    && /^ChatGPT browser stage timed out: (multipart_stage_\d+_(send|acknowledgement)|send)$/.test(error.message);
}

export const MAX_FRESH_COMPACTION_ATTEMPTS = 3;

export function recoveryDelay(attempt: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, Math.min(4_000, 1_000 * attempt));
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Recovery cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
