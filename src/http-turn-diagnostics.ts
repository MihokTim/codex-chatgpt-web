import type { AdapterEvent } from "./types";

export type HttpDiagnosticReporter = (record: Record<string, unknown>) => void;
export const reportHttpDiagnostic: HttpDiagnosticReporter = record => {
  console.info(`[codex-chatgpt-web] http_turn ${JSON.stringify(record)}`);
};

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_./-]{1,128}$/.test(value) ? value : undefined;
}

/** Scalar-only evidence. Never retain request bodies, text deltas, tool arguments or error messages. */
export class HttpTurnDiagnostics {
  private readonly started = Date.now();
  private lastChunkAt?: number;
  private lastAdapterAt?: number;
  private maxChunkGapMs = 0;
  private chunks = 0;
  private bytes = 0;
  private readonly counts: Partial<Record<AdapterEvent["type"], number>> = {};
  private context: Record<string, unknown> = {};
  private ended = false;
  private clientAborted = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly httpTurnId: number,
    private readonly endpoint: string,
    private readonly platform: NodeJS.Platform,
    private readonly report: HttpDiagnosticReporter = reportHttpDiagnostic,
  ) {
    this.emit("start");
    this.timer = setInterval(() => this.emit("progress"), 30_000);
    this.timer.unref?.();
  }

  bindIdentity(identity: { threadId: string; turnId: string }): void {
    this.context.threadId = identifier(identity.threadId);
    this.context.turnId = identifier(identity.turnId);
    this.emit("identity");
  }

  bindRoute(route: string, traceId?: string): void {
    this.context.modelRoute = identifier(route);
    this.context.traceId = identifier(traceId);
    this.emit("route");
  }

  replay(): void { this.emit("terminal_failure_replay"); }
  response(status: number): void { this.context.httpStatus = status; this.emit("response"); }
  sseStarted(responseId: string): void { this.context.responseId = identifier(responseId); }
  sseTerminal(status: "completed" | "failed" | "incomplete"): void {
    this.context.sseTerminal = status;
    this.emit("sse_terminal");
  }

  chunk(byteLength: number): void {
    const now = Date.now();
    this.maxChunkGapMs = Math.max(this.maxChunkGapMs, now - (this.lastChunkAt ?? this.started));
    this.lastChunkAt = now;
    this.chunks++;
    this.bytes += byteLength;
  }

  adapter(event: AdapterEvent): void {
    this.lastAdapterAt = Date.now();
    this.counts[event.type] = (this.counts[event.type] ?? 0) + 1;
    this.context.lastAdapterType = event.type;
    if (event.type === "error" || event.type === "incomplete" || event.type === "done") {
      this.context.adapterTerminal = event.type;
      if (event.type === "error") {
        this.context.errorCode = identifier(event.code);
        this.context.errorType = identifier(event.errorType);
        this.context.originalStatus = event.status;
        this.context.retryable = event.retryable;
      } else if (event.type === "incomplete") this.context.incompleteReason = identifier(event.reason);
      this.emit("adapter_terminal");
    }
  }

  clientAbort(): void {
    this.clientAborted = true;
    this.emit("client_abort_signal");
  }

  end(reason: "source_eof" | "source_error" | "request_error" | "response_cancel" | "aborted" | "no_body"): void {
    if (this.ended) return;
    this.emit("end", { reason });
    this.ended = true;
    clearInterval(this.timer);
  }

  private emit(phase: string, extra: Record<string, unknown> = {}): void {
    if (this.ended) return;
    try {
      const now = Date.now();
      this.report({
        at: new Date(now).toISOString(), pid: process.pid, httpTurnId: this.httpTurnId,
        endpoint: this.endpoint, platform: this.platform, phase, ...this.context, ...extra,
        elapsedMs: now - this.started, chunks: this.chunks, bytes: this.bytes,
        lastChunkAgoMs: this.lastChunkAt === undefined ? null : now - this.lastChunkAt,
        maxChunkGapMs: this.maxChunkGapMs,
        lastAdapterAgoMs: this.lastAdapterAt === undefined ? null : now - this.lastAdapterAt,
        adapterCounts: { ...this.counts }, clientAborted: this.clientAborted,
        // A consumed source / Windows tee observer is not an acknowledgement from native Codex.
        observation: "bridge_source", nativeReceiptConfirmed: false,
      });
    } catch { /* A failed diagnostic sink must not affect a request. */ }
  }
}
