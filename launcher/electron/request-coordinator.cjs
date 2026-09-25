// One coordinator per authenticated browser partition, shared by every helper and compaction.
// It schedules new requests only; accepted generations never wait on this coordinator.
const CATEGORIES = new Set(["generation", "conversation", "authentication", "other", "unknown"]);
const INTENTS = new Set(["open", "send", "authentication"]);

class RequestCoordinator {
  constructor({ now = Date.now, spacingMs = 1_500 } = {}) {
    this.now = now;
    this.spacingMs = spacingMs;
    this.nextSendAt = 0;
    this.cooldowns = new Map();
    this.localCooldowns = new Map();
    this.reports = new Map();
  }

  report(owner, evidence) {
    if (!evidence || !["http", "dialog"].includes(evidence.source)
      || Object.keys(evidence).some(key => !["id", "source", "category", "status", "retryAfterMs"].includes(key))
      || !CATEGORIES.has(evidence.category)
      || typeof evidence.id !== "string" || !/^[A-Za-z0-9_-]{6,128}$/.test(evidence.id)
      || (evidence.source === "http" && evidence.status !== 429)
      || (evidence.source === "dialog" && evidence.status !== undefined)
      || (evidence.retryAfterMs !== undefined && (!Number.isSafeInteger(evidence.retryAfterMs)
        || evidence.retryAfterMs < 0 || evidence.retryAfterMs > 31_536_000_000))) {
      throw new Error("Invalid request-limit evidence");
    }
    const now = this.now();
    for (const [key, value] of this.reports) if (value.expiresAt < now) this.reports.delete(key);
    const reportKey = `${owner}:${evidence.id}`;
    const prior = this.reports.get(reportKey);
    if (prior) return prior.until;
    // A dialog has no endpoint attribution. It may delay its own tab but cannot cancel or
    // globally throttle another tab whose generation is healthy.
    const global = evidence.source === "http" && evidence.category !== "other" && evidence.category !== "unknown";
    const store = global ? this.cooldowns : this.localCooldowns;
    const key = global ? evidence.category : owner;
    const previous = store.get(key);
    const strikes = previous && previous.until + 300_000 > now ? previous.strikes + 1 : 1;
    const fallback = Math.min(30_000 * 2 ** Math.min(strikes - 1, 4), 300_000);
    const until = Math.max(previous?.until ?? 0, now + (evidence.retryAfterMs ?? fallback));
    store.set(key, { until, strikes });
    this.reports.set(reportKey, { until, expiresAt: Math.max(until, now + 600_000) });
    return until;
  }

  acquire(owner, intent) {
    if (!INTENTS.has(intent)) throw new Error("Invalid request scheduling intent");
    const now = this.now();
    for (const [key, value] of this.localCooldowns) if (value.until + 600_000 < now) this.localCooldowns.delete(key);
    // A new Send also causes the SPA to fetch conversation state. Let a known history
    // cooldown settle before adding that traffic, including from other helpers/compaction.
    // Already accepted responses remain outside acquire() and keep being observed.
    const categories = intent === "open" ? ["conversation", "authentication", "generation"]
      : intent === "send" ? ["generation", "conversation"] : ["authentication"];
    const cooldownUntil = Math.max(this.localCooldowns.get(owner)?.until ?? 0,
      ...categories.map(category => this.cooldowns.get(category)?.until ?? 0));
    const until = Math.max(cooldownUntil, intent === "send" ? this.nextSendAt : 0);
    if (until > now) return { granted: false, retryAt: until,
      reason: cooldownUntil > now ? "rate-limit" : "send-spacing" };
    if (intent === "send") this.nextSendAt = now + this.spacingMs;
    return { granted: true };
  }
}

module.exports = { RequestCoordinator };
