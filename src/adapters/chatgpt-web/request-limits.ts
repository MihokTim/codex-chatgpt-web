import { randomUUID } from "node:crypto";
import type { Page, Request, Response } from "playwright-core";
import { ChatGptWebAdapterError } from "./adapter-error";
import { invalidateChatGptUsageAccountCache } from "./limits";

export type RequestCategory = "generation" | "conversation" | "authentication" | "other" | "unknown";
export interface RequestLimitEvidence {
  id: string;
  source: "http" | "dialog";
  category: RequestCategory;
  status?: number;
  retryAfterMs?: number;
}

export function parseRequestLimitEvidence(value: unknown): RequestLimitEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request-limit evidence");
  const evidence = value as Record<string, unknown>;
  if (Object.keys(evidence).some(key => !["id", "source", "category", "status", "retryAfterMs"].includes(key))
    || typeof evidence.id !== "string" || !/^[A-Za-z0-9_-]{6,128}$/.test(evidence.id)
    || !["http", "dialog"].includes(String(evidence.source))
    || !["generation", "conversation", "authentication", "other", "unknown"].includes(String(evidence.category))
    || (evidence.source === "http" ? evidence.status !== 429 : evidence.status !== undefined)
    || (evidence.retryAfterMs !== undefined && (!Number.isSafeInteger(evidence.retryAfterMs)
      || (evidence.retryAfterMs as number) < 0 || (evidence.retryAfterMs as number) > 31_536_000_000))) {
    throw new Error("Invalid request-limit evidence");
  }
  return { id: evidence.id, source: evidence.source as RequestLimitEvidence["source"],
    category: evidence.category as RequestCategory,
    ...(evidence.status !== undefined ? { status: 429 } : {}),
    ...(evidence.retryAfterMs !== undefined ? { retryAfterMs: evidence.retryAfterMs as number } : {}) };
}

export function retryAfterMilliseconds(value: string | undefined, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const raw = value.trim();
  const milliseconds = /^\d+$/.test(raw) ? Number(raw) * 1_000
    : /^[A-Za-z]{3}, /.test(raw) ? Date.parse(raw) - now : NaN;
  if (!Number.isFinite(milliseconds) || milliseconds > 31_536_000_000) return undefined;
  return Math.max(0, Math.ceil(milliseconds));
}

export function requestCategory(rawUrl: string, method: string): RequestCategory | undefined {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return undefined; }
  if (url.origin !== "https://chatgpt.com") return undefined;
  if (url.pathname.startsWith("/api/auth/")) return "authentication";
  if (/^\/backend-api\/(?:f\/)?conversation\/?$/.test(url.pathname) && method === "POST") return "generation";
  if (/^\/backend-api\/(?:f\/)?conversations?(?:\/|$)/.test(url.pathname)) return "conversation";
  if (url.pathname.startsWith("/backend-api/")) return "other";
  return undefined;
}

export function requestLimitError(evidence: RequestLimitEvidence): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    evidence.source === "http"
      ? `ChatGPT rejected a ${evidence.category} request with HTTP 429. Accepted context parts are not replayed.`
      : "ChatGPT displayed a request-frequency limit. The affected HTTP request is unknown; accepted context parts are not replayed.",
    { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: false, requestLimit: evidence },
  );
}

/** Passive, bounded, content-free diagnostics. Listeners never read response bodies or credentials. */
export class ChatGptRequestMonitor {
  private page?: Page;
  private requests = new WeakMap<Request, { category: RequestCategory; method: string; stage: string; send?: string }>();
  private stage = "preparation";
  private send?: string;
  private rejection?: ChatGptWebAdapterError;
  private submitted = false;
  private generationResponded = false;
  private auxiliaryLimitedAt?: number;
  private ambiguousLimit = false;
  private auxiliaryLimitRevision = 0;
  private observedAuxiliaryLimitRevision = 0;
  private observingDialog = false;
  private counts: Record<string, number> = {};
  private recent: Record<string, unknown>[] = [];
  private writes = new Set<Promise<unknown>>();
  constructor(private readonly traceId: string,
    private readonly report?: (evidence: RequestLimitEvidence) => Promise<unknown>,
    private readonly now: () => number = Date.now) {}

  setStage(stage: string): void { this.stage = stage.replace(/[^a-z0-9_]/gi, "_").slice(0, 80); }
  beginSend(): void {
    this.send = randomUUID(); this.rejection = undefined;
    this.submitted = false; this.generationResponded = false;
    this.auxiliaryLimitedAt = undefined; this.ambiguousLimit = false;
    this.auxiliaryLimitRevision = 0; this.observedAuxiliaryLimitRevision = 0;
  }
  markSubmitted(): void { if (this.send) this.submitted = true; }
  endSend(): void { this.send = undefined; this.submitted = false; }
  failure(): ChatGptWebAdapterError | undefined { return this.rejection; }

  /** A nearby GET limit is correlation, not attribution. Require fresh semantic evidence of
   * this accepted response after dismissing the modal; never send, reload, or infer success here.
   * The unknown dialog still puts new requests into the owner's cooldown. Each distinct GET
   * rejection can warrant another observation of the SAME response; it never permits a Send.
   * Consuming the HTTP evidence, rather than one recovery per Send, handles repeated auxiliary
   * failures during long generations without accepting uncorrelated or repeated modals. */
  async observeAcceptedResponseAfterDialog(evidence: RequestLimitEvidence,
    observe: () => Promise<boolean>): Promise<boolean> {
    const send = this.send;
    const page = this.page;
    const stopped = (reason: string): false => {
      console.info(`[chatgpt-web] accepted_response_observation_stopped ${JSON.stringify({
        traceId: this.traceId, stage: this.stage, reason,
      })}`);
      return false;
    };
    if (!send || !page || !this.submitted) return stopped("submission_not_confirmed");
    if (!this.generationResponded) return stopped("generation_http_not_confirmed");
    if (this.rejection || this.ambiguousLimit) return stopped("conflicting_rejection");
    if (this.observingDialog) return stopped("observation_in_progress");
    if (this.auxiliaryLimitedAt === undefined
      || this.auxiliaryLimitRevision === this.observedAuxiliaryLimitRevision) return stopped("no_new_auxiliary_evidence");
    if (this.now() - this.auxiliaryLimitedAt > 5_000) return stopped("auxiliary_evidence_expired");
    if (!this.report) return stopped("scheduler_unavailable");
    this.observedAuxiliaryLimitRevision = this.auxiliaryLimitRevision;
    this.observingDialog = true;
    try {
      if (!await observe()) return stopped("response_not_observable");
      if (this.send !== send || this.page !== page) return stopped("owner_changed");
      if (this.rejection || this.ambiguousLimit) return stopped("conflicting_rejection");
      try { await this.report(evidence); }
      catch {
        console.warn(`[chatgpt-web] request_limit_report_failed traceId=${this.traceId}`);
        return stopped("scheduler_report_failed");
      }
      if (this.send !== send || this.page !== page) return stopped("owner_changed");
      if (this.rejection || this.ambiguousLimit) return stopped("conflicting_rejection");
      console.info(`[chatgpt-web] accepted_response_observation_preserved traceId=${this.traceId}`);
      return true;
    } finally {
      this.observingDialog = false;
    }
  }

  private onRequest = (request: Request): void => {
    try {
      if (!this.page || request.frame() !== this.page.mainFrame()) return;
      const method = request.method();
      const category = requestCategory(request.url(), method);
      if (category) this.requests.set(request, { category, method, stage: this.stage, send: this.send });
    } catch { /* Service-worker requests have no owned frame. */ }
  };

  private onResponse = (response: Response): void => {
    const request = this.requests.get(response.request());
    if (!request) return;
    // A duplicate response notification must not create new evidence or report another limit.
    this.requests.delete(response.request());
    const status = response.status();
    const currentSend = !!request.send && request.send === this.send;
    if (currentSend && request.category === "generation" && status >= 200 && status < 300) this.generationResponded = true;
    if (currentSend && request.category === "authentication" && status >= 400) this.ambiguousLimit = true;
    if (this.page && request.category === "authentication" && status >= 400) {
      invalidateChatGptUsageAccountCache(this.page.context());
    }
    const key = `${request.category}:${status}`;
    this.counts[key] = (this.counts[key] ?? 0) + 1;
    const event = { at: new Date().toISOString(), traceId: this.traceId,
      category: request.category, method: request.method, stage: request.stage, status,
      currentSend };
    this.recent.push(event);
    if (this.recent.length > 12) this.recent.shift();
    if (status !== 429) return;
    if (currentSend) {
      if (request.category === "conversation" && request.method === "GET") {
        this.auxiliaryLimitedAt = this.now();
        this.auxiliaryLimitRevision += 1;
      }
      else this.ambiguousLimit = true;
    }
    const evidence: RequestLimitEvidence = { id: randomUUID(), source: "http", category: request.category,
      status, retryAfterMs: retryAfterMilliseconds(response.headers()["retry-after"]) };
    if (request.category === "generation" && request.send && request.send === this.send) {
      this.rejection = requestLimitError(evidence);
    }
    console.warn(`[chatgpt-web] request_limit ${JSON.stringify({ ...event, ...evidence, recent: this.recent })}`);
    if (this.report) {
      const write = this.report(evidence).catch(() => {
        console.warn(`[chatgpt-web] request_limit_report_failed traceId=${this.traceId}`);
      });
      this.writes.add(write);
      void write.finally(() => this.writes.delete(write));
    }
  };

  bind(page: Page): void {
    if (page === this.page) return;
    this.detach();
    this.page = page;
    this.auxiliaryLimitedAt = undefined;
    page.on("request", this.onRequest);
    page.on("response", this.onResponse);
  }
  private detach(): void {
    this.page?.off("request", this.onRequest);
    this.page?.off("response", this.onResponse);
  }
  async close(): Promise<void> {
    this.detach();
    this.page = undefined;
    this.endSend();
    await Promise.allSettled(this.writes);
    console.info(`[chatgpt-web] request_counts ${JSON.stringify({ traceId: this.traceId, counts: this.counts })}`);
  }
}
