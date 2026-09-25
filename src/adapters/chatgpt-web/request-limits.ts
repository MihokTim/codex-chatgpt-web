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
  private counts: Record<string, number> = {};
  private recent: Record<string, unknown>[] = [];
  private writes: Promise<unknown>[] = [];
  constructor(private readonly traceId: string,
    private readonly report?: (evidence: RequestLimitEvidence) => Promise<unknown>) {}

  setStage(stage: string): void { this.stage = stage.replace(/[^a-z0-9_]/gi, "_").slice(0, 80); }
  beginSend(): void { this.send = randomUUID(); this.rejection = undefined; }
  endSend(): void { this.send = undefined; }
  failure(): ChatGptWebAdapterError | undefined { return this.rejection; }

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
    const status = response.status();
    if (this.page && request.category === "authentication" && status >= 400) {
      invalidateChatGptUsageAccountCache(this.page.context());
    }
    const key = `${request.category}:${status}`;
    this.counts[key] = (this.counts[key] ?? 0) + 1;
    const event = { at: new Date().toISOString(), traceId: this.traceId,
      category: request.category, method: request.method, stage: request.stage, status,
      currentSend: !!request.send && request.send === this.send };
    this.recent.push(event);
    if (this.recent.length > 12) this.recent.shift();
    if (status !== 429) return;
    const evidence: RequestLimitEvidence = { id: randomUUID(), source: "http", category: request.category,
      status, retryAfterMs: retryAfterMilliseconds(response.headers()["retry-after"]) };
    if (request.category === "generation" && request.send && request.send === this.send) {
      this.rejection = requestLimitError(evidence);
    }
    console.warn(`[chatgpt-web] request_limit ${JSON.stringify({ ...event, ...evidence, recent: this.recent })}`);
    if (this.report) this.writes.push(this.report(evidence).catch(() => {
      console.warn(`[chatgpt-web] request_limit_report_failed traceId=${this.traceId}`);
    }));
  };

  bind(page: Page): void {
    if (page === this.page) return;
    this.detach();
    this.page = page;
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
    await Promise.allSettled(this.writes);
    console.info(`[chatgpt-web] request_counts ${JSON.stringify({ traceId: this.traceId, counts: this.counts })}`);
  }
}
