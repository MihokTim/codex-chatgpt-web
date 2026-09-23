import { ChatGptWebAdapterError } from "./adapter-error";

export function browserViewportUnavailable(cause: unknown): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT's existing browser page did not respond to the viewport check. Its response was not resubmitted.",
    { status: 502, errorType: "server_error", code: "chatgpt_browser_viewport_unavailable", retryable: false,
      cause: cause instanceof Error ? cause : new Error(String(cause)) },
  );
}

/** Reconnect only the same owned target; a failed first viewport probe also consumes the budget. */
export async function recoverOwnedBrowserPage<T>(
  firstAttempt: number,
  maxAttempts: number,
  reconnect: (attempt: number) => Promise<T>,
  signal?: AbortSignal,
): Promise<{ value: T; lastAttempt: number }> {
  if (firstAttempt < 1 || firstAttempt > maxAttempts) {
    throw new RangeError("Owned browser page reconnect budget is exhausted");
  }
  for (let attempt = firstAttempt; ; attempt++) {
    signal?.throwIfAborted();
    try { return { value: await reconnect(attempt), lastAttempt: attempt }; }
    catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof ChatGptWebAdapterError)
        || error.code !== "chatgpt_browser_viewport_unavailable" || attempt >= maxAttempts) throw error;
    }
  }
}
