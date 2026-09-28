import { createHash } from "node:crypto";
import type { BrowserContext, Locator, Page } from "playwright-core";
import { parseChatGptModelAnnouncement } from "./model-announcement";

export type ChatGptLimitsPlan = "pro_100" | "pro_200" | "unsupported";
export type ChatGptUsageModel = "gpt-6-pro" | "gpt-5.6-pro" | "pro-unknown" | "other";

type UsageAccount = Awaited<ReturnType<typeof readChatGptUsageAccount>>;

/** Cache only while locally observed session cookies are unchanged. No credential leaves memory. */
export class ChatGptUsageAccountCache {
  private value?: { fingerprint: string; account: UsageAccount; expires: number };
  private pending?: { fingerprint: string; promise: Promise<UsageAccount> };
  private revision = 0;
  constructor(private readonly now = Date.now, private readonly ttlMs = 60_000) {}

  invalidate(): void { this.revision++; this.value = undefined; this.pending = undefined; }

  async read(fingerprint: () => Promise<string | undefined>, load: () => Promise<UsageAccount>): Promise<UsageAccount> {
    const before = await fingerprint().catch(error => { this.invalidate(); throw error; });
    if (!before) { this.invalidate(); return load(); }
    if (this.value?.fingerprint === before && this.value.expires > this.now()) return this.value.account;
    if (this.pending?.fingerprint === before) return this.pending.promise;
    this.value = undefined;
    const revision = this.revision;
    let promise!: Promise<UsageAccount>;
    promise = (async () => {
      const account = await load();
      const after = await fingerprint();
      if (before !== after || revision !== this.revision) throw new Error("The ChatGPT account changed during usage verification");
      if (this.pending?.promise === promise) this.value = { fingerprint: before, account, expires: this.now() + this.ttlMs };
      return account;
    })();
    this.pending = { fingerprint: before, promise };
    try { return await promise; }
    finally { if (this.pending?.promise === promise) this.pending = undefined; }
  }
}

const usageAccountCaches = new WeakMap<BrowserContext, ChatGptUsageAccountCache>();

export function invalidateChatGptUsageAccountCache(context: BrowserContext): void {
  usageAccountCaches.get(context)?.invalidate();
}

export async function readCachedChatGptUsageAccount(page: Page): Promise<UsageAccount> {
  const context = page.context();
  let cache = usageAccountCaches.get(context);
  if (!cache) { cache = new ChatGptUsageAccountCache(); usageAccountCaches.set(context, cache); }
  return cache.read(async () => {
    // This is a local browser-protocol read, not an /api/auth/session request. Include all
    // session/account cookie changes; do not log the cookies or this private fingerprint.
    const cookies = (await context.cookies("https://chatgpt.com"))
      .filter(cookie => /auth|session|account|login/i.test(cookie.name))
      .sort((a, b) => `${a.domain}:${a.path}:${a.name}`.localeCompare(`${b.domain}:${b.path}:${b.name}`));
    if (!cookies.length) return undefined;
    return createHash("sha256").update(JSON.stringify(cookies)).digest("hex");
  }, () => readChatGptUsageAccount(page));
}

/** Authenticated account tier is independent of translated billing headings. */
export function supportsChatGptUsageTracking(account: { personal: boolean; planType: string }): boolean {
  return account.personal && ["pro", "prolite"].includes(account.planType);
}

/** Only stable account identity leaves the page; never export session credentials. */
export async function readChatGptUsageAccount(page: Page): Promise<{
  accountKey: string;
  planType: string;
  personal: boolean;
  needsAttention: boolean;
}> {
  if (new URL(page.url()).origin !== "https://chatgpt.com") {
    throw new Error("Open ChatGPT and sign in before setting up Limits.");
  }
  const identity = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session", {
      credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000),
    });
    const url = new URL(response.url);
    if (!response.ok || url.origin !== "https://chatgpt.com" || url.pathname !== "/api/auth/session") {
      throw new Error("Limits could not verify the current ChatGPT account.");
    }
    const session = await response.json();
    if ((session?.error != null && session.error !== "") || (session?.expires != null
      && (typeof session.expires !== "string" || !Number.isFinite(Date.parse(session.expires))
        || Date.parse(session.expires) <= Date.now()))) {
      throw new Error("The ChatGPT session has expired. Sign in again before setting up Limits.");
    }
    // Deliberately copy only these fields from the session response.
    return {
      userId: session?.user?.id,
      accountId: session?.account?.id,
      planType: session?.account?.planType,
      structure: session?.account?.structure,
      needsAttention: session?.account?.isDelinquent === true,
    };
  });
  if ([identity.userId, identity.accountId, identity.planType, identity.structure]
    .some(value => typeof value !== "string" || !value || value.length > 256)) {
    throw new Error("Limits could not identify the current ChatGPT account. Sign in and retry.");
  }
  return {
    accountKey: createHash("sha256").update(`${identity.userId}\0${identity.accountId}`).digest("hex"),
    planType: identity.planType,
    personal: identity.structure === "personal",
    needsAttention: identity.needsAttention,
  };
}

/** The authenticated account tier is stable across renamed and translated billing headings. */
export async function detectChatGptLimitsPlan(page: Page): Promise<{ accountKey: string; plan: ChatGptLimitsPlan }> {
  const before = await readChatGptUsageAccount(page);
  if (!supportsChatGptUsageTracking(before)) return { accountKey: before.accountKey, plan: "unsupported" };
  if (before.needsAttention) {
    throw new Error("ChatGPT reports a subscription payment problem. Check your plan in ChatGPT settings before enabling Limits.");
  }
  const after = await readChatGptUsageAccount(page);
  if (after.accountKey !== before.accountKey || after.planType !== before.planType
    || !supportsChatGptUsageTracking(after) || after.needsAttention) {
    throw new Error("The ChatGPT account or subscription changed during Limits setup. Retry the check.");
  }
  return { accountKey: after.accountKey, plan: after.planType === "pro" ? "pro_200" : "pro_100" };
}

/** The slider's own accessibility announcement names the selected family, even for 'Latest'. */
export async function readChatGptUsageModel(slider: Locator, isPro: boolean): Promise<ChatGptUsageModel> {
  if (!isPro) return "other";
  const announcements = await slider.locator("xpath=ancestor::*[@role='menuitem'][1]").evaluate(element => (
    (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)
      .map(id => element.ownerDocument.getElementById(id)?.textContent ?? "")
  ));
  return chatGptUsageModelFromAnnouncements(announcements);
}

export function chatGptUsageModelFromAnnouncements(announcements: readonly string[]): ChatGptUsageModel {
  const families = new Set<ChatGptUsageModel>();
  for (const text of announcements) {
    const state = parseChatGptModelAnnouncement(text);
    if (!state || !/^Pro$/i.test(state.mode)) continue;
    if (state.version === "6" && (!state.name || state.name === "astra")) families.add("gpt-6-pro");
    if (state.version === "5.6" && (!state.name || state.name === "sol")) families.add("gpt-5.6-pro");
  }
  return families.size === 1 ? [...families][0]! : "pro-unknown";
}
