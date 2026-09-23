import type { AdapterEvent } from "../types";

type Failure = Extract<AdapterEvent, { type: "error" }>;

/** Bounded tombstones for terminal browser executions, never for a live browser turn. */
export class TerminalFailureReplays {
  private readonly failures = new Map<string, { at: number; error: Failure }>();

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly maxEntries = 256,
    private readonly now = Date.now,
  ) {}

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.failures) {
      if (entry.at <= cutoff) this.failures.delete(key);
    }
  }

  remember(key: string | undefined, event: AdapterEvent): void {
    // Unknown errors and real transient failures retain the existing retry/recovery policy.
    if (!key || event.type !== "error" || event.retryable !== false || !event.code || !event.errorType) return;
    this.prune();
    this.failures.delete(key);
    this.failures.set(key, { at: this.now(), error: {
      type: "error", code: event.code, errorType: event.errorType,
      message: event.message.slice(0, 4_096), status: event.status, retryable: false,
    } });
    while (this.failures.size > this.maxEntries) this.failures.delete(this.failures.keys().next().value!);
  }

  response(key: string | undefined): Response | undefined {
    if (!key) return;
    this.prune();
    const error = this.failures.get(key)?.error;
    if (!error) return;
    // Codex ignores retryable:false for unknown SSE response.failed codes. Once this canonical
    // instruction has failed terminally, automatic replay is invalid. HTTP 400 stops the loop;
    // the body preserves the original provider classification rather than claiming overload.
    return Response.json({ error: {
      type: error.errorType, code: error.code, message: error.message,
      ...(error.status === undefined ? {} : { original_status: error.status }),
      retryable: false,
    } }, { status: 400 });
  }
}
