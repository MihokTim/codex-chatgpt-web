import { readLauncherBrowserHostDescriptor } from "../../launcher-browser-host";
import type { RequestLimitEvidence } from "./request-limits";
import { ChatGptWebAdapterError, chatGptBrowserTabClosedError } from "./adapter-error";

export function cancellableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class LauncherRequestScheduler {
  constructor(private readonly descriptorPath: string,
    private readonly owner: { traceId: string; helperPid: number },
    private readonly signal?: AbortSignal,
    private readonly onWaiting?: (retryAt: number) => void | Promise<void>) {}

  private async request(action: "acquire" | "report", payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.signal?.throwIfAborted();
    const descriptor = readLauncherBrowserHostDescriptor(this.descriptorPath);
    const response = await fetch(`${descriptor.control.endpoint}/v1/traffic/${action}`, {
      method: "POST", headers: { authorization: `Bearer ${descriptor.control.token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...this.owner, ...payload }),
      signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
    });
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      if (body.code === "turn_cancelled") throw chatGptBrowserTabClosedError();
      throw new Error(`Launcher request scheduler unavailable (HTTP ${response.status}); update the launcher and runtime together`);
    }
    return body;
  }

  report(evidence: RequestLimitEvidence): Promise<Record<string, unknown>> { return this.request("report", { evidence }); }

  async optionalAuthenticationAllowed(): Promise<boolean> {
    const result = await this.request("acquire", { intent: "authentication" });
    if (typeof result.granted !== "boolean") throw new Error("Invalid authentication scheduling response");
    return result.granted;
  }

  async acquire(intent: "send" | "open" | "authentication"): Promise<void> {
    const deadline = Date.now() + 10 * 60_000;
    let announced = 0;
    for (;;) {
      this.signal?.throwIfAborted();
      const body = await this.request("acquire", { intent });
      if (body.granted === true) return;
      if (body.granted !== false || !Number.isSafeInteger(body.retryAt)) throw new Error("Invalid launcher request scheduling response");
      const retryAt = body.retryAt as number;
      if (retryAt !== announced) { await this.onWaiting?.(retryAt); announced = retryAt; }
      if (Date.now() >= deadline || retryAt > deadline) throw new ChatGptWebAdapterError(
        `ChatGPT requests remain paused until ${new Date(retryAt).toISOString()}. Already accepted context parts were not resent.`,
        { status: 429, errorType: "rate_limit_error", code: "request_cooldown_pending", retryable: false },
      );
      await cancellableDelay(Math.min(Math.max(retryAt - Date.now(), 50), 10_000), this.signal);
    }
  }
}
