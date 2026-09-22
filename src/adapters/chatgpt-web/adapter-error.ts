export interface ChatGptWebAdapterErrorOptions {
  status: number;
  errorType: string;
  code: string;
  retryable: boolean;
  cause?: unknown;
}

export class ChatGptWebAdapterError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: ChatGptWebAdapterErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGptWebAdapterError";
    this.status = options.status;
    this.errorType = options.errorType;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

/** Pass only fixed diagnostic labels and selector state, never prompt text or raw browser errors. */
export function chatGptModelSelectionError(
  diagnostic: string,
  detail?: string,
  code: "chatgpt_model_selection_failed" | "chatgpt_effort_unavailable" = "chatgpt_model_selection_failed",
): ChatGptWebAdapterError {
  const safeDiagnostic = diagnostic.replace(/[\r\n\t]/g, " ").slice(0, 600);
  const safeDetail = detail?.replace(/[\r\n\t]/g, " ").slice(0, 320);
  return new ChatGptWebAdapterError(
    (code === "chatgpt_effort_unavailable"
      ? "ChatGPT does not expose the requested effort. Check the available options before retrying the task. "
      : "ChatGPT model selection failed. Check the model and effort controls before retrying the task. ")
    + `[${safeDiagnostic}]` + (safeDetail ? ` ChatGPT: ${safeDetail}` : ""),
    {
      status: 502,
      errorType: "server_error",
      code,
      // Multipart preparation may already have been submitted; do not replay it automatically.
      retryable: false,
      // The message also carries these diagnostics because helper IPC does not serialize Error.cause.
      cause: new Error(safeDiagnostic),
    },
  );
}

// Only the compaction owner may signal this after the broker accepts its one-shot handoff.
// It cancels browser observation, while the accepted summary remains the native result.
export class ChatGptCompactionHandoffAccepted extends DOMException {
  constructor() {
    super("Structured compaction handoff accepted", "AbortError");
  }
}

export function chatGptBrowserTabClosedError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The ChatGPT browser tab was closed, so the Codex turn was cancelled.",
    {
      status: 499,
      errorType: "client_closed_request",
      code: "client_cancelled",
      retryable: false,
    },
  );
}

export function chatGptTurnSupersededError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "A newer Codex instruction superseded this ChatGPT response.",
    { status: 499, errorType: "client_closed_request", code: "client_cancelled", retryable: false },
  );
}

export function chatGptStoppedThinkingError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT displayed 'Stopped thinking' and could not continue this response. "
    + "A ChatGPT Web usage limit may have been reached. Check the ChatGPT tab for the exact reason before retrying.",
    {
      status: 502,
      errorType: "server_error",
      code: "chatgpt_stopped_thinking",
      retryable: false,
    },
  );
}

export function chatGptFailedThinkingError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT displayed '思考に失敗しました' (failed thinking) and could not finish this response. "
    + "This status does not expose the underlying cause. Review completed tool work before resuming the task.",
    {
      status: 502,
      errorType: "server_error",
      code: "chatgpt_failed_thinking",
      // A tool may already have modified the workspace. Reconnecting must not replay the task.
      retryable: false,
    },
  );
}

export function chatGptRetainedConversationUnavailableError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The retained ChatGPT conversation is no longer available.",
    {
      status: 409,
      errorType: "invalid_request_error",
      code: "compaction_source_unavailable",
      retryable: false,
    },
  );
}
